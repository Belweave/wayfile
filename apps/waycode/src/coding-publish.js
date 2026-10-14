import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;
const VERIFICATION_MAX_AGE_MS = 30 * 60 * 1000;
const VERIFICATION_FUTURE_SKEW_MS = 2 * 60 * 1000;

const BLOCKED_COMPONENTS = new Set([
  '.git', 'node_modules', '.next', '.wayfile', 'runs', 'traces', '.ssh', '.aws', '.npmrc', '.netrc', '.pypirc',
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b(?:npm|vercel)_[A-Za-z0-9_-]{20,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token)\b\s*[:=]\s*(["']?)(?!\s*(?:$|#|<[^>]+>|YOUR[_-]|REPLACE[_-]?ME|CHANGEME|EXAMPLE))[A-Za-z0-9/+_=.-]{16,}\1/i,
];

export class PublishError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PublishError';
    this.code = options.code || 'PUBLISH_ERROR';
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateInput({ workspace, repo, visibility = 'private', files }) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new PublishError('workspace must be a non-empty directory path', { code: 'INVALID_INPUT' });
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) {
    throw new PublishError('repo must be a GitHub owner/name pair', { code: 'INVALID_INPUT' });
  }
  if (!['private', 'public'].includes(visibility)) throw new PublishError("visibility must be 'private' or 'public'", { code: 'INVALID_INPUT' });
  if (files !== undefined && (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))) {
    throw new PublishError('files must be an array of workspace-relative paths', { code: 'INVALID_INPUT' });
  }
}

function isBlockedPath(path) {
  const parts = path.split('/');
  const file = parts.at(-1);
  return parts.some((part, index) => BLOCKED_COMPONENTS.has(part) || (!(part === '.env.example' && index === parts.length - 1) && /^\.env(?:$|[._-])/i.test(part)) || /^\.envrc$/i.test(part))
    || parts.some((part) => /^(?:session|sessions)$/i.test(part))
    || /\.trace(?:\.|$)/i.test(file)
    || /(?:^|[._-])session(?:[._-].*)?\.(?:json|jsonl|ndjson|trace|txt)$/i.test(file);
}

function validateRelativePath(path) {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new PublishError(`invalid workspace-relative file path: ${JSON.stringify(path)}`, { code: 'INVALID_PATH' });
  }
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new PublishError(`invalid workspace-relative file path: ${JSON.stringify(path)}`, { code: 'INVALID_PATH' });
  }
  if (/[\r\n\t]/.test(path)) throw new PublishError(`file path contains unsupported control characters: ${JSON.stringify(path)}`, { code: 'INVALID_PATH' });
  return path;
}

function parseNulList(text) {
  return text ? text.split('\0').filter(Boolean) : [];
}

function redactDiagnostic(text) {
  return String(text || '').trim().replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:npm|vercel)_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted token]').slice(0, 2000);
}

async function defaultExecute({ command, args, cwd, input, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, { cwd, signal, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) {
      rejectPromise(new PublishError(`could not start ${command}: ${cause.message}`, { code: 'PREFLIGHT_FAILED', cause }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflow = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finishError(new PublishError(`${command} command timed out`, { code: 'COMMAND_TIMEOUT' }));
    }, PROCESS_TIMEOUT_MS);
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    };
    const take = (list, chunk, current) => {
      const bytes = Buffer.byteLength(chunk);
      if (current + bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return current;
      }
      list.push(chunk);
      return current + bytes;
    };
    child.on('error', (cause) => finishError(new PublishError(`could not start ${command}: ${cause.message}`, { code: 'PREFLIGHT_FAILED', cause })));
    child.stdout.on('data', (chunk) => { stdoutBytes = take(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', (chunk) => { stderrBytes = take(stderr, chunk, stderrBytes); });
    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (overflow) {
        settled = true;
        rejectPromise(new PublishError(`${command} output exceeded the safety limit`, { code: 'OUTPUT_LIMIT' }));
        return;
      }
      settled = true;
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolvePromise({ code: Number.isInteger(code) ? code : 128, signal, stdout: stdoutBuffer.toString('utf8'), stdoutBytes: stdoutBuffer, stderr: stderrBuffer.toString('utf8') });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function createRunner(execute = defaultExecute, signal) {
  if (typeof execute !== 'function') throw new PublishError('execute must be a command executor function', { code: 'INVALID_INPUT' });
  return async function run(command, args, cwd, { allowFailure = false, input } = {}) {
    signal?.throwIfAborted();
    let result;
    try { result = await execute({ command, args, cwd, ...(signal ? { signal } : {}), ...(input === undefined ? {} : { input }) }); }
    catch (cause) {
      if (cause instanceof PublishError) throw cause;
      throw new PublishError(`${command} ${args[0] || ''} could not run: ${cause?.message || String(cause)}`, { code: 'COMMAND_FAILED', cause });
    }
    if (!result || typeof result !== 'object') throw new PublishError(`${command} executor returned no command result`, { code: 'EXECUTOR_ERROR' });
    signal?.throwIfAborted();
    const code = Number.isInteger(result.code) ? result.code : Number.isInteger(result.exitCode) ? result.exitCode : null;
    if (code === null) throw new PublishError(`${command} executor returned no exit code`, { code: 'EXECUTOR_ERROR' });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const stdoutBytes = Buffer.isBuffer(result.stdoutBytes) ? Buffer.from(result.stdoutBytes) : Buffer.from(stdout, 'utf8');
    if (code !== 0 && !allowFailure) {
      const diagnostic = redactDiagnostic(stderr || stdout);
      throw new PublishError(`${command} ${args.join(' ')} failed${diagnostic ? `: ${diagnostic}` : ` (exit ${code})`}`, { code: 'COMMAND_FAILED' });
    }
    return { code, stdout, stderr, stdoutBytes };
  };
}

async function workspaceRoot(workspacePath) {
  const requestedPath = resolve(workspacePath);
  let requestedInfo;
  try { requestedInfo = await lstat(requestedPath); }
  catch (cause) { throw new PublishError(`workspace must already exist: ${workspacePath}`, { code: 'INVALID_WORKSPACE', cause }); }
  if (requestedInfo.isSymbolicLink()) throw new PublishError('workspace must be a real directory, not a symlink', { code: 'INVALID_WORKSPACE' });
  let workspace;
  try { workspace = await realpath(requestedPath); }
  catch (cause) { throw new PublishError(`workspace must already exist: ${workspacePath}`, { code: 'INVALID_WORKSPACE', cause }); }
  const info = await lstat(workspace);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PublishError('workspace must be a real directory, not a symlink', { code: 'INVALID_WORKSPACE' });
  return workspace;
}

async function assertNoSymlinkParents(workspace, path) {
  const parts = path.split('/');
  let current = workspace;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PublishError(`file path traverses a non-directory or symlink: ${path}`, { code: 'INVALID_PATH' });
  }
}

async function enumerateFiles(workspace) {
  const files = [];
  const walk = async (directory, prefix = '') => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (cause) { throw new PublishError(`cannot scan workspace directory ${prefix || '.'}: ${cause.message}`, { code: 'SCAN_FAILED', cause }); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isBlockedPath(path)) continue;
      const fullPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new PublishError(`symlink is not publishable: ${path}`, { code: 'UNSAFE_FILE' });
      if (entry.isDirectory()) await walk(fullPath, path);
      else if (entry.isFile()) files.push(path);
      else throw new PublishError(`non-regular file is not publishable: ${path}`, { code: 'UNSAFE_FILE' });
    }
  };
  await walk(workspace);
  return files;
}

async function readRegularFile(workspace, path) {
  await assertNoSymlinkParents(workspace, path);
  const fullPath = resolve(workspace, ...path.split('/'));
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new PublishError(`not a regular file: ${path}`, { code: 'UNSAFE_FILE' });
    if (info.size > MAX_FILE_BYTES) throw new PublishError(`file exceeds the ${MAX_FILE_BYTES} byte scan limit: ${path}`, { code: 'SCAN_LIMIT' });
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new PublishError(`file exceeds the ${MAX_FILE_BYTES} byte scan limit: ${path}`, { code: 'SCAN_LIMIT' });
    return bytes;
  } catch (cause) {
    if (cause instanceof PublishError) throw cause;
    throw new PublishError(`cannot safely read ${path}: ${cause.message}`, { code: 'SCAN_FAILED', cause });
  } finally { await handle?.close(); }
}

function findSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

async function scanFiles(workspace, paths) {
  let total = 0;
  const records = [];
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readRegularFile(workspace, path);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new PublishError(`workspace scan exceeds the ${MAX_TOTAL_BYTES} byte total limit`, { code: 'SCAN_LIMIT' });
    if (findSecret(bytes.toString('latin1'))) throw new PublishError(`possible credential found in ${path}; remove it before publishing`, { code: 'SECRET_DETECTED' });
    records.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (!records.length) throw new PublishError('workspace has no publishable files after protected paths are excluded', { code: 'NO_FILES' });
  return records;
}

function parseRemote(remote) {
  const value = remote.trim();
  let host;
  let path;
  if (/^[^/\s]+:\/\//.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new PublishError('origin is not a valid GitHub remote URL', { code: 'REMOTE_MISMATCH' }); }
    if (url.username || url.password) throw new PublishError('origin URL must not contain embedded credentials', { code: 'REMOTE_MISMATCH' });
    host = url.hostname.toLowerCase();
    path = url.pathname.replace(/^\//, '');
  } else {
    const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(value);
    if (!scp) throw new PublishError('origin is not a supported GitHub SSH or HTTPS URL', { code: 'REMOTE_MISMATCH' });
    host = scp[1].toLowerCase();
    path = scp[2];
  }
  path = path.replace(/\.git$/i, '').replace(/\/$/, '');
  const pieces = path.split('/');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new PublishError('origin must point to one GitHub owner/name repository', { code: 'REMOTE_MISMATCH' });
  return { host, repo: `${pieces[0]}/${pieces[1]}` };
}

function repoEquals(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function validateOrigin(remote, repo, targetUrl, configuredHost) {
  const parsed = parseRemote(remote);
  if (!repoEquals(parsed.repo, repo)) throw new PublishError(`origin points to ${parsed.repo}, not requested ${repo}`, { code: 'REMOTE_MISMATCH' });
  if (targetUrl) {
    const target = parseRemote(targetUrl);
    if (!repoEquals(target.repo, repo) || parsed.host !== target.host) throw new PublishError('origin host does not match the requested GitHub repository host', { code: 'REMOTE_MISMATCH' });
  } else {
    const host = configuredHost || process.env.GH_HOST?.toLowerCase() || 'github.com';
    if (parsed.host !== host) throw new PublishError(`origin host ${parsed.host} does not match the configured GitHub host ${host}`, { code: 'REMOTE_MISMATCH' });
  }
  return parsed;
}

function hashPlan(workspace, repo, visibility, state, records, selectedPaths) {
  const payload = JSON.stringify({
    workspace,
    repo: repo.toLowerCase(),
    visibility,
    repository: { initialized: state.initialized, branch: state.branch, head: state.head, origin: state.origin, status: state.status, deleted: state.deleted },
    files: records.map(({ path, bytes, sha256: hash }) => [path, bytes, hash]),
    selectedPaths,
  });
  return sha256(payload);
}

async function scanReachableHistory(run, workspace, head) {
  if (!head) return;
  const objects = (await run('git', ['rev-list', '--objects', head], workspace)).stdout.trim().split('\n').filter(Boolean);
  if (objects.length > 4096) throw new PublishError('repository history exceeds bounded publication scan; use a dedicated source snapshot repository', { code: 'HISTORY_LIMIT' });
  let totalBytes = 0;
  for (const entry of objects) {
    const space = entry.indexOf(' '), objectId = space < 0 ? entry : entry.slice(0, space);
    if (!/^[0-9a-f]{40,64}$/.test(objectId)) throw new PublishError('malformed Git history object', { code: 'HISTORY_SCAN_FAILED' });
    if (space >= 0 && isBlockedPath(entry.slice(space + 1))) throw new PublishError('protected files exist in reachable Git history; use a clean source snapshot repository', { code: 'SECRET_HISTORY' });
    const kind = (await run('git', ['cat-file', '-t', objectId], workspace)).stdout.trim();
    if (!['blob', 'commit', 'tree', 'tag'].includes(kind)) throw new PublishError('unsupported Git history object', { code: 'HISTORY_SCAN_FAILED' });
    if (kind === 'tree') continue;
    const object = await run('git', ['cat-file', kind, objectId], workspace);
    totalBytes += object.stdoutBytes.length;
    if (object.stdoutBytes.length > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new PublishError('Git history exceeds bounded scan size', { code: 'HISTORY_LIMIT' });
    if (findSecret(object.stdoutBytes.toString('latin1'))) throw new PublishError('possible credential exists in reachable Git history; publication blocked', { code: 'SECRET_HISTORY' });
  }
}

async function inspectWorkspace(input, run) {
  const workspace = await workspaceRoot(input.workspace);
  const rootResult = await run('git', ['rev-parse', '--show-toplevel'], workspace, { allowFailure: true });
  let initialized = rootResult.code === 0;
  let branch = 'main';
  let head = null;
  let origin = null;
  let worktreeStatus = '';
  let allCandidates;
  let trackedPaths = [];

  if (initialized) {
    let gitRoot;
    try { gitRoot = await realpath(rootResult.stdout.trim()); }
    catch (cause) { throw new PublishError('Git reported an invalid repository root', { code: 'INVALID_WORKSPACE', cause }); }
    if (gitRoot !== workspace) throw new PublishError(`workspace is inside a parent Git repository (${gitRoot}); use the exact repository root or an isolated workspace`, { code: 'PARENT_REPOSITORY' });

    const status = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], workspace);
    worktreeStatus = status.stdout;
    if (status.stdout.trim() && !input.allowDirty) throw new PublishError('workspace Git repository is dirty; commit or explicitly authorize publishing local changes', { code: 'DIRTY_REPOSITORY' });
    if (input.allowDirty && status.stdout.split('\n').some(line => line && ![' ', '?'].includes(line[0]))) throw new PublishError('pre-existing staged changes must be committed or unstaged before publication', { code: 'DIRTY_INDEX' });

    const branchResult = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace, { allowFailure: true });
    if (branchResult.code !== 0 || !branchResult.stdout.trim()) throw new PublishError('cannot publish from a detached Git HEAD', { code: 'INVALID_BRANCH' });
    branch = branchResult.stdout.trim();
    const headResult = await run('git', ['rev-parse', '--verify', 'HEAD'], workspace, { allowFailure: true });
    if (headResult.code === 0) head = headResult.stdout.trim();
    await scanReachableHistory(run, workspace, head);
    const remotes = parseNulList((await run('git', ['remote'], workspace)).stdout.trim().split('\n').join('\0'));
    if (remotes.includes('origin')) {
      origin = (await run('git', ['remote', 'get-url', 'origin'], workspace)).stdout.trim();
      if (!origin) throw new PublishError('origin is configured without a URL', { code: 'REMOTE_MISMATCH' });
    }
    const tracked = parseNulList((await run('git', ['ls-files', '-z'], workspace)).stdout);
    trackedPaths = tracked;
    for (const path of tracked) {
      if (isBlockedPath(path)) throw new PublishError(`tracked protected path would be part of the published repository: ${path}`, { code: 'PROTECTED_PATH' });
      validateRelativePath(path);
    }
    const untracked = parseNulList((await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], workspace)).stdout);
    allCandidates = [...new Set([...tracked, ...untracked])];
  } else {
    const diagnostic = `${rootResult.stderr}\n${rootResult.stdout}`.toLowerCase();
    if (!diagnostic.includes('not a git repository') && !diagnostic.includes('not a git work tree')) {
      throw new PublishError(`could not determine Git repository state: ${redactDiagnostic(diagnostic)}`, { code: 'GIT_PREFLIGHT_FAILED' });
    }
    try { await lstat(resolve(workspace, '.git')); throw new PublishError('workspace has a .git entry that Git could not read', { code: 'INVALID_WORKSPACE' }); }
    catch (cause) { if (cause instanceof PublishError) throw cause; if (cause.code !== 'ENOENT') throw cause; }
    allCandidates = await enumerateFiles(workspace);
  }

  let requested;
  if (input.files !== undefined) {
    requested = [...new Set(input.files.map(validateRelativePath))];
    for (const path of requested) {
      if (isBlockedPath(path)) throw new PublishError(`protected path cannot be explicitly staged: ${path}`, { code: 'PROTECTED_PATH' });
      if (!allCandidates.includes(path)) throw new PublishError(`file is ignored, missing, or not a repository file: ${path}`, { code: 'INVALID_PATH' });
    }
  } else {
    requested = allCandidates.filter((path) => !isBlockedPath(path));
  }

  for (const path of requested) validateRelativePath(path);
  const candidateFiles = [...new Set(allCandidates.filter((path) => !isBlockedPath(path)))];
  const deleted = [];
  for (const path of trackedPaths) {
    try { await lstat(resolve(workspace, validateRelativePath(path))); }
    catch (cause) { if (cause.code === 'ENOENT') deleted.push(path); else throw cause; }
  }
  const scannedFiles = await scanFiles(workspace, candidateFiles.filter(path => !deleted.includes(path)));
  const selectedSet = new Set(requested);
  const records = scannedFiles.filter((file) => selectedSet.has(file.path));
  if (!records.length) throw new PublishError('workspace has no selected publishable files', { code: 'NO_FILES' });
  const state = { initialized, branch, head, origin, status: worktreeStatus, deleted };
  return {
    workspace,
    repo: input.repo,
    visibility: input.visibility,
    branch,
    initialized,
    head,
    origin,
    files: records.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash })),
    scannedFiles: scannedFiles.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash })),
    deletedFiles: deleted.filter(path => selectedSet.has(path)),
    excluded: ['.env, .env.*, and .envrc', 'node_modules/', '.next/', '.wayfile/', 'runs/', 'session(s)/', 'traces/', '*.trace*'],
    snapshot: hashPlan(workspace, input.repo, input.visibility, state, scannedFiles, records.map(({ path }) => path)),
  };
}

/**
 * Create a read-only publication plan. The returned snapshot binds the exact
 * workspace root, repository state, visibility, and scanned file contents.
 * Pass that snapshot in `verification` to publishRepository after recent,
 * independent checks have passed.
 */
export async function planRepositoryPublication({ workspace, repo, visibility = 'private', files, execute, allowDirty = false, signal } = {}) {
  const input = { workspace, repo, visibility, allowDirty, ...(files === undefined ? {} : { files }) };
  validateInput(input);
  const run = createRunner(execute, signal);
  return inspectWorkspace(input, run);
}

function validateVerification(verification, plan) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    throw new PublishError('publish requires verification evidence for the current workspace snapshot', { code: 'VERIFICATION_REQUIRED' });
  }
  const verifiedAt = Date.parse(verification.verifiedAt);
  const age = Date.now() - verifiedAt;
  if (verification.passed !== true || verification.independent !== true || typeof verification.verifiedBy !== 'string' || !verification.verifiedBy.trim() || typeof verification.evidence !== 'string' || !verification.evidence.trim()) {
    throw new PublishError('verification must include passed:true, independent:true, verifiedBy, and evidence', { code: 'VERIFICATION_REQUIRED' });
  }
  if (verification.snapshot !== plan.snapshot || verification.workspace !== plan.workspace) {
    throw new PublishError('verification does not match the current workspace snapshot', { code: 'VERIFICATION_MISMATCH' });
  }
  if (!Number.isFinite(verifiedAt) || age > VERIFICATION_MAX_AGE_MS || age < -VERIFICATION_FUTURE_SKEW_MS) {
    throw new PublishError('verification must be no more than 30 minutes old and cannot be from the future', { code: 'VERIFICATION_STALE' });
  }
}

function repositoryNotFound(result) {
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return message.includes('could not resolve to a repository') || message.includes('repository not found') || message.includes('http 404') || message.includes('not found (http 404)');
}

async function inspectGithubRepository(run, workspace, repo) {
  const result = await run('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,url,isPrivate'], workspace, { allowFailure: true });
  if (result.code !== 0) {
    if (repositoryNotFound(result)) return null;
    const diagnostic = redactDiagnostic(result.stderr || result.stdout);
    throw new PublishError(`could not verify GitHub repository ${repo}${diagnostic ? `: ${diagnostic}` : ''}`, { code: 'GITHUB_PREFLIGHT_FAILED' });
  }
  let details;
  try { details = JSON.parse(result.stdout); }
  catch (cause) { throw new PublishError('gh repo view returned malformed repository details', { code: 'GITHUB_PREFLIGHT_FAILED', cause }); }
  if (typeof details.nameWithOwner !== 'string' || typeof details.url !== 'string' || typeof details.isPrivate !== 'boolean') {
    throw new PublishError('gh repo view omitted owner, URL, or visibility details', { code: 'GITHUB_PREFLIGHT_FAILED' });
  }
  if (!repoEquals(details.nameWithOwner, repo)) throw new PublishError(`GitHub resolved ${details.nameWithOwner}, not requested ${repo}`, { code: 'REMOTE_MISMATCH' });
  return details;
}

async function requirePreflight(run, workspace) {
  const gitVersion = await run('git', ['--version'], workspace);
  const version = /git version (\d+)\.(\d+)/.exec(gitVersion.stdout);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 28)) {
    throw new PublishError('Git 2.28 or newer is required for safe default-branch initialization', { code: 'PREFLIGHT_FAILED' });
  }
  await run('gh', ['--version'], workspace);
  const auth = await run('gh', ['auth', 'status'], workspace);
  const authOutput = `${auth.stdout}\n${auth.stderr}`;
  if (!/logged in|active account|✓/i.test(authOutput)) throw new PublishError('gh auth status did not confirm an authenticated account', { code: 'PREFLIGHT_FAILED' });
  const authHost = /logged in to ([A-Za-z0-9.-]+)/i.exec(authOutput)?.[1]?.toLowerCase();
  const name = await run('git', ['config', '--get', 'user.name'], workspace, { allowFailure: true });
  const email = await run('git', ['config', '--get', 'user.email'], workspace, { allowFailure: true });
  if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
    throw new PublishError('configure git user.name and user.email before publishing', { code: 'PREFLIGHT_FAILED' });
  }
  return { host: process.env.GH_HOST?.toLowerCase() || authHost || 'github.com' };
}

function stagedIndexEntries(text) {
  return parseNulList(text).map((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new PublishError('Git returned a malformed staged index entry', { code: 'STAGING_FAILED' });
    const [mode, objectId, stage] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (!/^[0-9a-f]{40,64}$/.test(objectId) || stage !== '0' || !['100644', '100755'].includes(mode)) {
      throw new PublishError(`staged entry is not a regular file: ${path}`, { code: 'UNSAFE_FILE' });
    }
    return { path, objectId };
  });
}

function commitTreeEntries(text) {
  return parseNulList(text).map((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new PublishError('Git returned a malformed commit tree entry', { code: 'COMMIT_VERIFY_FAILED' });
    const [mode, kind, objectId] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (kind !== 'blob' || !/^[0-9a-f]{40,64}$/.test(objectId) || !['100644', '100755'].includes(mode) || isBlockedPath(path)) {
      throw new PublishError(`commit contains an unsafe or unsupported file: ${path}`, { code: 'COMMIT_VERIFY_FAILED' });
    }
    return { path, objectId };
  });
}

async function stageScannedFiles(run, plan, explicitFiles) {
  const tracked = parseNulList((await run('git', ['ls-files', '-z'], plan.workspace)).stdout);
  const untracked = parseNulList((await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], plan.workspace)).stdout);
  const indexable = new Set([...tracked, ...untracked]);
  const stage = [...plan.files.map(({ path }) => path), ...(plan.deletedFiles || [])].filter((path) => indexable.has(path));
  if (explicitFiles !== undefined) {
    const omitted = explicitFiles.filter((path) => !stage.includes(path));
    if (omitted.length) throw new PublishError(`requested file is ignored or no longer present: ${omitted[0]}`, { code: 'INVALID_PATH' });
  }
  if (!stage.length) throw new PublishError('all scanned files are ignored by Git; there is nothing safe to stage', { code: 'NO_FILES' });

  // Re-read the selected files immediately before staging and require the exact
  // content verified by the caller.
  const current = await scanFiles(plan.workspace, stage.filter(path => !plan.deletedFiles?.includes(path)));
  for (const path of plan.deletedFiles || []) {
    try { await lstat(resolve(plan.workspace, path)); throw new PublishError('deleted file reappeared after verification', { code: 'VERIFICATION_MISMATCH' }); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  const original = new Map(plan.files.map((file) => [file.path, `${file.bytes}:${file.sha256}`]));
  for (const file of current) if (original.get(file.path) !== `${file.bytes}:${file.sha256}`) {
    throw new PublishError(`workspace changed after verification: ${file.path}`, { code: 'VERIFICATION_MISMATCH' });
  }

  // Keep every argv bounded even for large workspaces. Literal pathspecs stop
  // names containing Git wildcard syntax from staging neighboring files.
  for (let offset = 0; offset < stage.length; offset += 128) {
    const batch = stage.slice(offset, offset + 128).map((path) => `:(literal)${path}`);
    await run('git', ['add', '-A', '--', ...batch], plan.workspace);
  }
  const stagedPaths = parseNulList((await run('git', ['diff', '--cached', '--name-only', '-z'], plan.workspace)).stdout);
  const stageSet = new Set(stage);
  for (const path of stagedPaths) {
    if (!stageSet.has(path) || isBlockedPath(path)) throw new PublishError(`unexpected or protected path became staged: ${path}`, { code: 'STAGING_FAILED' });
  }

  const index = stagedIndexEntries((await run('git', ['ls-files', '--stage', '-z'], plan.workspace)).stdout);
  const expectedPaths = plan.head !== null ? plan.scannedFiles.map(({ path }) => path) : stage;
  const sortedExpected = [...expectedPaths].sort();
  const indexPaths = index.map(({ path }) => path).sort();
  if (indexPaths.length !== sortedExpected.length || indexPaths.some((path, i) => path !== sortedExpected[i])) {
    throw new PublishError('Git index contains files outside the verified workspace snapshot', { code: 'STAGING_FAILED' });
  }
  const stagedEntries = index.filter((entry) => stageSet.has(entry.path));
  const liveStage = stage.filter(path => !plan.deletedFiles?.includes(path));
  if (stagedEntries.length !== liveStage.length || new Set(stagedEntries.map((entry) => entry.path)).size !== liveStage.length) {
    throw new PublishError('Git staged an unexpected set of files', { code: 'STAGING_FAILED' });
  }
  const expectedFiles = new Map(plan.scannedFiles.map((file) => [file.path, file]));
  for (const entry of index) {
    const blob = await run('git', ['cat-file', 'blob', entry.objectId], plan.workspace);
    if (findSecret(blob.stdoutBytes.toString('latin1'))) throw new PublishError(`possible credential found in staged content: ${entry.path}`, { code: 'SECRET_DETECTED' });
    const expected = expectedFiles.get(entry.path);
    if (!expected || blob.stdoutBytes.length !== expected.bytes || sha256(blob.stdoutBytes) !== expected.sha256) {
      throw new PublishError(`staged bytes differ from the verified workspace snapshot: ${entry.path}`, { code: 'VERIFICATION_MISMATCH' });
    }
  }
  return { stage, stagedPaths, index };
}

async function ensureCommit(run, workspace) {
  const check = await run('git', ['diff', '--cached', '--quiet'], workspace, { allowFailure: true });
  if (check.code === 0) return false;
  if (check.code !== 1) throw new PublishError('could not verify staged changes before commit', { code: 'STAGING_FAILED' });
  await run('git', ['commit', '-m', 'Publish workspace'], workspace);
  return true;
}

async function recheckRepositoryState(run, plan) {
  const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], plan.workspace);
  if (branch.stdout.trim() !== plan.branch) throw new PublishError('current branch changed after verification', { code: 'VERIFICATION_MISMATCH' });
  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], plan.workspace, { allowFailure: true });
  if ((plan.head === null && head.code === 0) || (plan.head !== null && (head.code !== 0 || head.stdout.trim() !== plan.head))) {
    throw new PublishError('repository base commit changed after verification', { code: 'VERIFICATION_MISMATCH' });
  }
  const remotes = (await run('git', ['remote'], plan.workspace)).stdout.trim().split('\n').filter(Boolean);
  if (plan.origin === null) {
    if (remotes.includes('origin')) throw new PublishError('origin was added after verification; review it and create a new plan', { code: 'VERIFICATION_MISMATCH' });
  } else {
    if (!remotes.includes('origin')) throw new PublishError('origin was removed after verification', { code: 'VERIFICATION_MISMATCH' });
    const origin = (await run('git', ['remote', 'get-url', 'origin'], plan.workspace)).stdout.trim();
    if (origin !== plan.origin) throw new PublishError('origin changed after verification', { code: 'VERIFICATION_MISMATCH' });
  }
  const worktreeDiff = await run('git', ['diff', '--quiet'], plan.workspace, { allowFailure: true });
  if (worktreeDiff.code !== 0) throw new PublishError('workspace changed while files were being staged', { code: 'VERIFICATION_MISMATCH' });
}

async function verifyPublishedCommit(run, plan, { committed, stage, stagedPaths, index }) {
  const revision = await run('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], plan.workspace);
  const [commit, ...parents] = revision.stdout.trim().split(/\s+/);
  if (!/^[0-9a-f]{40,64}$/.test(commit || '')) throw new PublishError('Git returned an invalid commit ID after publication staging', { code: 'COMMIT_VERIFY_FAILED' });
  if (committed) {
    const expectedParents = plan.head === null ? [] : [plan.head];
    if (parents.length !== expectedParents.length || parents.some((parent, index) => parent !== expectedParents[index])) {
      throw new PublishError('commit parent differs from the verified repository base', { code: 'COMMIT_VERIFY_FAILED' });
    }
  } else if (plan.head === null || commit !== plan.head) {
    throw new PublishError('Git HEAD changed unexpectedly during publication', { code: 'COMMIT_VERIFY_FAILED' });
  }

  const changed = committed ? parseNulList((await run('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], plan.workspace)).stdout).sort() : [];
  const expectedChanged = (committed ? stagedPaths : []).slice().sort();
  if (changed.length !== expectedChanged.length || changed.some((path, index) => path !== expectedChanged[index])) {
    throw new PublishError('commit includes paths outside the explicit staged file set', { code: 'COMMIT_VERIFY_FAILED' });
  }

  const tree = commitTreeEntries((await run('git', ['ls-tree', '-r', '-z', 'HEAD'], plan.workspace)).stdout);
  const expectedTreePaths = (plan.head !== null ? plan.scannedFiles.map(({ path }) => path) : stage).sort();
  const treePaths = tree.map(({ path }) => path).sort();
  if (treePaths.length !== expectedTreePaths.length || treePaths.some((path, index) => path !== expectedTreePaths[index])) {
    throw new PublishError('published commit tree differs from the verified workspace file set', { code: 'COMMIT_VERIFY_FAILED' });
  }
  const indexByPath = new Map(index.map((entry) => [entry.path, entry.objectId]));
  const expectedFiles = new Map(plan.scannedFiles.map((file) => [file.path, file]));
  for (const entry of tree) {
    if (indexByPath.get(entry.path) !== entry.objectId) throw new PublishError(`commit blob differs from the verified Git index: ${entry.path}`, { code: 'COMMIT_VERIFY_FAILED' });
    const expected = expectedFiles.get(entry.path);
    if (!expected) throw new PublishError(`commit contains a file outside the scanned snapshot: ${entry.path}`, { code: 'COMMIT_VERIFY_FAILED' });
  }
}

function defaultRemoteUrl(repo, configuredHost) {
  const host = configuredHost || process.env.GH_HOST || 'github.com';
  return `https://${host}/${repo}.git`;
}

/**
 * Publish an isolated, verified workspace to GitHub. This function performs
 * mutations only when called by the CLI's explicit publication command.
 * `verification` must attest that an independent check passed against the
 * snapshot returned by planRepositoryPublication within the last 30 minutes.
 * `execute`, when supplied, receives `{ command, args, cwd, input? }` and must
 * return `{ code, stdout, stderr }`; it is intended for harness tests.
 */
export async function publishRepository({ workspace, repo, visibility = 'private', files, verification, execute, allowDirty = false, signal } = {}) {
  const input = { workspace, repo, visibility, allowDirty, ...(files === undefined ? {} : { files }) };
  validateInput(input);
  const run = createRunner(execute, signal);
  const workspacePath = await workspaceRoot(workspace);
  const preflight = await requirePreflight(run, workspacePath);

  const plan = await inspectWorkspace(input, run);
  validateVerification(verification, plan);

  const githubRepo = await inspectGithubRepository(run, plan.workspace, repo);
  if (githubRepo && githubRepo.isPrivate !== (visibility === 'private')) {
    throw new PublishError(`GitHub repository visibility does not match requested ${visibility}`, { code: 'VISIBILITY_MISMATCH' });
  }
  if (plan.origin) validateOrigin(plan.origin, repo, githubRepo?.url, preflight.host);

  const author = await run('git', ['config', '--get', 'user.name'], plan.workspace, { allowFailure: true });
  const email = await run('git', ['config', '--get', 'user.email'], plan.workspace, { allowFailure: true });
  if (author.code !== 0 || email.code !== 0 || !author.stdout.trim() || !email.stdout.trim()) {
    throw new PublishError('configure git user.name and user.email before publishing', { code: 'PREFLIGHT_FAILED' });
  }

  // Re-read the whole plan before the first mutation. This catches changes
  // made while authentication and remote checks were running.
  const current = await inspectWorkspace(input, run);
  validateVerification(verification, current);

  if (!plan.initialized) await run('git', ['init', '--initial-branch=main'], plan.workspace);
  const staged = await stageScannedFiles(run, plan, files);
  await recheckRepositoryState(run, plan);
  const committed = await ensureCommit(run, plan.workspace);
  await verifyPublishedCommit(run, plan, { ...staged, committed });

  let remoteUrl = githubRepo?.url;
  if (!githubRepo) {
    // Do not ask gh to add an origin or push implicitly. Remote creation,
    // remote configuration, and push are distinct reviewed commands here.
    await run('gh', ['repo', 'create', repo, visibility === 'private' ? '--private' : '--public'], plan.workspace);
    const created = await inspectGithubRepository(run, plan.workspace, repo);
    if (!created) throw new PublishError('gh repo create succeeded but the repository cannot be read back', { code: 'GITHUB_CREATE_FAILED' });
    if (created.isPrivate !== (visibility === 'private')) throw new PublishError('created GitHub repository has unexpected visibility', { code: 'VISIBILITY_MISMATCH' });
    remoteUrl = created.url;
  }

  if (plan.origin) {
    validateOrigin(plan.origin, repo, remoteUrl);
  } else {
    if (!remoteUrl) remoteUrl = defaultRemoteUrl(repo, preflight.host);
    // Re-check the host and repository before adding the remote.
    validateOrigin(remoteUrl, repo, remoteUrl);
    await run('git', ['remote', 'add', 'origin', remoteUrl], plan.workspace);
  }

  // No force option is ever used. A non-fast-forward remote rejects the push.
  await run('git', ['push', 'origin', `refs/heads/${plan.branch}:refs/heads/${plan.branch}`], plan.workspace);
  return {
    published: true,
    workspace: plan.workspace,
    repo,
    visibility,
    branch: plan.branch,
    files: staged.stage,
    snapshot: plan.snapshot,
    committed,
    remote: remoteUrl,
  };
}

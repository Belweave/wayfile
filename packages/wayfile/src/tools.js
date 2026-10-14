// Optional host tools. Filesystem paths are scoped; shell cwd is NOT a security sandbox.
import { constants } from 'node:fs';
import { open, realpath, stat, lstat, opendir, mkdir, rename, unlink } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, relative, isAbsolute, dirname, basename, join, sep } from 'node:path';
import { validateValue } from './contracts.js';

export class ToolError extends Error {
  constructor(message, { code = 'TOOL_ERROR', recoverable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ToolError'; this.code = code; this.recoverable = recoverable;
  }
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const checkAbort = (signal) => signal?.throwIfAborted();
const PROTECTED_NAMES = ['.env', '.env.*', '.git', '.ssh', '.aws'];
const SAFE_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USER', 'LOGNAME'];

function bounded(value, label, maximum = 67108864) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return value;
}

export function createProjectTools({
  workspace, allowWrite = false, allowShell = false, authorize, allowSensitiveFiles = false, denyPaths = [], env,
  timeoutMs = 10000, maxReadBytes = 32768, maxWriteBytes = 1048576,
  maxResults = 200, maxFiles = 2000, maxDepth = 32, maxShellBytes = 65536,
  searchExcludes = ['.git', 'node_modules', '.wayfile', 'runs'],
} = {}) {
  if (typeof workspace !== 'string' || !workspace) throw new Error('project tools need an explicit workspace');
  const root = realpathSync(resolve(workspace));
  if (!statSync(root).isDirectory()) throw new Error('project workspace must be a directory');
  if (typeof allowWrite !== 'boolean' || typeof allowShell !== 'boolean') throw new Error('allowWrite and allowShell must be booleans');
  if (typeof allowSensitiveFiles !== 'boolean') throw new Error('allowSensitiveFiles must be a boolean');
  if (authorize !== undefined && typeof authorize !== 'function') throw new Error('project authorize must be a function');
  if (allowShell && !authorize) throw new Error('shell needs an explicit authorize callback');
  bounded(timeoutMs, 'timeoutMs', 300000); bounded(maxReadBytes, 'maxReadBytes'); bounded(maxWriteBytes, 'maxWriteBytes');
  bounded(maxResults, 'maxResults', 10000); bounded(maxFiles, 'maxFiles', 100000); bounded(maxDepth, 'maxDepth', 256); bounded(maxShellBytes, 'maxShellBytes');
  if (!Array.isArray(searchExcludes) || searchExcludes.some((name) => typeof name !== 'string' || !name || name.includes('/') || name.includes('\\'))) throw new Error('searchExcludes must contain directory names');
  if (!Array.isArray(denyPaths) || denyPaths.some((name) => typeof name !== 'string' || !name || name.includes('/') || name.includes('\\'))) throw new Error('denyPaths must contain protected path component patterns');
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'))) throw new Error('shell env must be an explicit string map');
  const shellEnv = env === undefined ? Object.fromEntries(SAFE_ENV.filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]])) : { ...env };
  const protectedNames = [...(allowSensitiveFiles ? [] : PROTECTED_NAMES), ...denyPaths];
  const inside = (path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
  const label = (path) => relative(root, path).split(sep).join('/') || '.';
  const protectedPath = (path) => relative(root, path).split(sep).some((part) => protectedNames.some((pattern) => pattern.endsWith('*') ? part.startsWith(pattern.slice(0, -1)) : part === pattern));
  const lexical = (path) => {
    if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) throw new ToolError('path must be relative to the project workspace', { code: 'SCOPE' });
    const resolved = resolve(root, path);
    if (!inside(resolved)) throw new ToolError('path escapes the project workspace', { code: 'SCOPE' });
    return resolved;
  };
  const existing = async (path, namesOnly = false) => {
    const resolved = lexical(path);
    if (!namesOnly && protectedPath(resolved)) throw new ToolError('protected project path requires explicit sensitive-file access', { code: 'PROTECTED_PATH' });
    let actual;
    try { actual = await realpath(resolved); }
    catch (cause) { if (cause.code === 'ENOENT') throw new ToolError(`${path}: not found`, { code: 'ENOENT', recoverable: true, cause }); throw cause; }
    if (!inside(actual)) throw new ToolError('symlink escapes the project workspace', { code: 'SCOPE' });
    if (!namesOnly && protectedPath(actual)) throw new ToolError('symlink targets a protected project path', { code: 'PROTECTED_PATH' });
    return actual;
  };
  const approve = async (name, args, context) => {
    checkAbort(context.signal);
    if (authorize && await authorize({ tool: name, args: structuredClone(args), ...context }) !== true) throw new ToolError(`${name}: authorization denied`, { code: 'DENIED' });
    checkAbort(context.signal);
  };

  async function readBounded(path, limit, signal) {
    checkAbort(signal);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile()) throw new ToolError('path is not a regular file', { code: 'INVALID_PATH' });
      if (info.size > limit) throw new ToolError(`file exceeds ${limit} bytes`, { code: 'OUTPUT_LIMIT' });
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        checkAbort(signal);
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new ToolError(`file exceeds ${limit} bytes`, { code: 'OUTPUT_LIMIT' });
      checkAbort(signal);
      return buffer.subarray(0, length);
    } catch (cause) {
      if (cause.code === 'ENOENT') throw new ToolError('file is no longer present', { code: 'ENOENT', recoverable: true, cause });
      if (cause.code === 'ELOOP') throw new ToolError('file changed to a symlink during access', { code: 'SCOPE', cause });
      throw cause;
    } finally { await handle?.close(); }
  }

  function textOf(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (cause) { throw new ToolError('file is not UTF-8 text; use an injected binary/artifact adapter', { code: 'INVALID_OUTPUT', cause }); }
  }

  async function walk(directory, recursive, visit, signal, excludes = [], skipped) {
    let count = 0;
    const scan = async (dir, depth) => {
      checkAbort(signal);
      if (depth > maxDepth) throw new ToolError(`directory depth exceeds ${maxDepth}`, { code: 'OUTPUT_LIMIT' });
      const safe = await existing(label(dir), true);
      const entries = [];
      for await (const entry of await opendir(safe)) {
        checkAbort(signal);
        const path = join(safe, entry.name);
        if (skipped && protectedPath(path)) { await skipped(path, 'protected'); continue; }
        if (excludes.includes(entry.name)) { if (skipped) await skipped(path, 'excluded'); continue; }
        if (++count > maxFiles) throw new ToolError(`scan exceeds ${maxFiles} entries; narrow the path`, { code: 'OUTPUT_LIMIT' });
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        checkAbort(signal);
        const path = join(safe, entry.name);
        const type = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
        if (type === 'symlink' && skipped) { await skipped(path, 'symlink'); continue; }
        await visit(path, type);
        // Do not follow symlinks while traversing, even when their current target is in scope.
        if (recursive && type === 'directory') await scan(path, depth + 1);
      }
    };
    await scan(directory, 0);
    return count;
  }

  function tool(name, description, input_schema, execute) {
    return { name, description, input_schema, async execute(args, context = {}) {
      const errors = validateValue(args, input_schema);
      if (errors.length) throw new ToolError(`${name}: invalid arguments: ${errors.slice(0, 5).join('; ')}`, { code: 'INVALID_ARGS' });
      await approve(name, args, context);
      return execute(args, context);
    } };
  }

  const definitions = [
    tool('list-files', 'List a project directory. Paths must be workspace-relative. Recursive listing does not follow symlinks; limit overflow fails explicitly.', schema({ path: pathSchema, recursive: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: maxResults } }), async (args, { signal }) => {
      const directory = await existing(args.path || '.', true);
      if (!(await stat(directory)).isDirectory()) throw new ToolError('list path is not a directory', { code: 'INVALID_PATH' });
      const entries = [], limit = args.limit ?? maxResults;
      await walk(directory, args.recursive === true, async (path, type) => {
        if (entries.length >= limit) throw new ToolError(`listing exceeds ${limit} results; narrow the path`, { code: 'OUTPUT_LIMIT' });
        entries.push({ path: label(path), type });
      }, signal);
      return { path: label(directory), entries };
    }),
    tool('read-file', `Read an entire UTF-8 project file, at most ${maxReadBytes} bytes. The result includes its SHA-256 for guarded writes.`, schema({ path: pathSchema }, ['path']), async ({ path }, { signal }) => {
      const actual = await existing(path), buffer = await readBounded(actual, maxReadBytes, signal);
      return { path: label(actual), bytes: buffer.length, sha256: sha(buffer), text: textOf(buffer) };
    }),
    tool('search-files', `Search UTF-8 project files for a literal string. Default excluded names: ${searchExcludes.join(', ')}. Symlinks are not followed. File/scan/result limits fail explicitly; choose a narrow path.`, schema({
      query: { type: 'string', minLength: 1, maxLength: 4096 }, path: pathSchema,
      case_sensitive: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: maxResults },
    }, ['query']), async (args, { signal }) => {
      const start = await existing(args.path || '.'), info = await stat(start);
      const matches = [], skipped = [], limit = args.limit ?? maxResults, query = args.case_sensitive === false ? args.query.toLowerCase() : args.query;
      let filesScanned = 0;
      const search = async (path) => {
        const actual = await existing(label(path));
        const text = textOf(await readBounded(actual, maxReadBytes, signal));
        filesScanned++;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) if ((args.case_sensitive === false ? lines[i].toLowerCase() : lines[i]).includes(query)) {
          if (matches.length >= limit) throw new ToolError(`search exceeds ${limit} matches; narrow the query/path`, { code: 'OUTPUT_LIMIT' });
          matches.push({ path: label(actual), line: i + 1, text: lines[i] });
        }
      };
      if (info.isFile()) await search(start);
      else if (info.isDirectory()) await walk(start, true, async (path, type) => { if (type === 'file') await search(path); }, signal, searchExcludes, async (path, reason) => {
        if (skipped.length >= maxResults) throw new ToolError(`search exceeds ${maxResults} skipped paths; narrow the path`, { code: 'OUTPUT_LIMIT' });
        skipped.push({ path: label(path), reason });
      });
      else throw new ToolError('search path is not a file or directory', { code: 'INVALID_PATH' });
      return { matches, filesScanned, skipped, excludedNames: [...searchExcludes], followedSymlinks: false };
    }),
  ];

  if (allowWrite) definitions.push(tool('write-file', 'Atomically replace or create a UTF-8 project file. Optional expected_sha256 prevents overwriting a changed file. Parent directories require create_dirs:true. Symlink components are rejected.', schema({
    path: pathSchema, content: { type: 'string', maxLength: maxWriteBytes }, create_dirs: { type: 'boolean' },
    expected_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  }, ['path', 'content']), async (args, { signal }) => {
    const target = lexical(args.path), buffer = Buffer.from(args.content, 'utf8');
    if (protectedPath(target)) throw new ToolError('protected project path requires explicit sensitive-file access', { code: 'PROTECTED_PATH' });
    if (target === root) throw new ToolError('write target must be a file inside the workspace', { code: 'INVALID_PATH' });
    if (buffer.length > maxWriteBytes) throw new ToolError(`write exceeds ${maxWriteBytes} bytes`, { code: 'OUTPUT_LIMIT' });
    const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      checkAbort(signal);
      let info;
      try { info = await lstat(parent); }
      catch (cause) {
        if (cause.code !== 'ENOENT' || args.create_dirs !== true) throw cause;
        await mkdir(parent); info = await lstat(parent);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ToolError('write parent must be a real project directory', { code: 'SCOPE' });
    }
    if (await realpath(parent) !== parent || !inside(parent)) throw new ToolError('write parent changed or escaped workspace', { code: 'SCOPE' });
    let info;
    try { info = await lstat(target); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (info && (info.isSymbolicLink() || !info.isFile())) throw new ToolError('write target must be a regular file without symlinks', { code: 'SCOPE' });
    if (args.expected_sha256 !== undefined) {
      if (!info || sha(await readBounded(target, maxWriteBytes, signal)) !== args.expected_sha256) throw new ToolError('file changed since it was read', { code: 'CONFLICT' });
    }
    checkAbort(signal);
    const temp = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), info ? info.mode & 0o777 : 0o600);
      if (info) await handle.chmod(info.mode & 0o777);
      await handle.writeFile(buffer); await handle.sync(); await handle.close(); handle = null;
      checkAbort(signal);
      if (await realpath(parent) !== parent) throw new ToolError('write parent changed during access', { code: 'SCOPE' });
      await rename(temp, target);
      return { path: label(target), bytes: buffer.length, sha256: sha(buffer), written: true };
    } finally {
      await handle?.close();
      try { await unlink(temp); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
  }));

  if (allowShell) definitions.push(tool('shell', 'Run an explicitly authorized shell command with project cwd and a timeout. Cwd is not a security sandbox: commands retain host-user permissions. Nonzero exits return their exitCode/stdout/stderr for diagnosis.', schema({ command: { type: 'string', minLength: 1, maxLength: 16384 } }, ['command']), async ({ command }, { signal }) => {
    checkAbort(signal);
    return new Promise((resolveResult, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: shellEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const stdout = [], stderr = [];
      let total = 0, failure, killTimer;
      const kill = (force = false) => {
        try { if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM'); else if (child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (cause) { if (cause.code !== 'ESRCH') failure ||= cause; }
      };
      const stop = (error) => {
        if (failure) return;
        failure = error; kill();
        killTimer = setTimeout(() => kill(true), 100);
      };
      const abort = () => stop(new ToolError('shell was aborted', { code: 'TIMEOUT', cause: signal.reason }));
      const timer = setTimeout(() => stop(new ToolError(`shell exceeded ${timeoutMs}ms`, { code: 'TIMEOUT' })), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      const collect = (list, data) => {
        total += data.length;
        if (total > maxShellBytes) stop(new ToolError(`shell output exceeds ${maxShellBytes} bytes`, { code: 'OUTPUT_LIMIT' }));
        else list.push(data);
      };
      child.stdout.on('data', (data) => collect(stdout, data)); child.stderr.on('data', (data) => collect(stderr, data));
      const finish = (error, code, termination) => {
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
        if (error || failure) reject(failure || error);
        else if (termination) reject(new ToolError(`shell terminated by ${termination}`, { code: 'PROCESS_EXIT' }));
        else resolveResult({ exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      };
      child.once('error', (error) => finish(error)); child.once('close', (code, termination) => finish(null, code, termination));
      if (signal?.aborted) abort();
    });
  }));
  return definitions;
}

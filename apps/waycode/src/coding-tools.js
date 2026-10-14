// Coding tools combine the scoped project tools with explicitly enabled host
// processes. A workspace cwd is a convenience, not an operating-system sandbox.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { validateValue } from 'wayfile/contracts';
import { ToolError, createProjectTools } from 'wayfile/tools';
import { createEditTool } from './coding-edit.js';

const MAX_OUTPUT_BYTES = 16 * 1024;
const STREAM_TAIL_BYTES = MAX_OUTPUT_BYTES / 2;
const MAX_CONCURRENT = 4;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_URL_TIMEOUT_MS = 10_000;
const SAFE_ENV = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USER', 'LOGNAME',
];

const schema = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const commandSchema = schema({ command: { type: 'string', minLength: 1, maxLength: 16_384 } }, ['command']);
const startSchema = schema({ ...commandSchema.properties, port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['command']);
const processIdSchema = schema({ id: { type: 'string', minLength: 1, maxLength: 128 } }, ['id']);
const timeoutSchema = { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS };
const runSchema = schema({ command: commandSchema.properties.command, timeout_ms: timeoutSchema }, ['command']);
const urlSchema = schema({ url: { type: 'string', minLength: 1, maxLength: 2048 }, timeout_ms: timeoutSchema }, ['url']);

function safeEnvironment() {
  const env = Object.fromEntries(SAFE_ENV
    .filter((name) => typeof process.env[name] === 'string')
    .map((name) => [name, process.env[name]]));
  if (!env.PATH) env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  env.CI = '1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  env.npm_config_yes = 'true';
  return env;
}

function scrubSecrets(text) {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED TOKEN]')
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\r\n,}"']+/gi, '$1[REDACTED]')
    .replace(/(^|[\s"'{,])([A-Za-z_][\w.-]*)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, (match, prefix, key, separator) => /(?:api[_-]?key|access[_-]?key|secret|password|passwd|token|credential|authorization|private[_-]?key|client[_-]?secret|database[_-]?url|connection[_-]?string|refresh[_-]?token|session[_-]?key|signing[_-]?key|bearer)/i.test(key) ? `${prefix}${key}${separator}[REDACTED]` : match)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2');
}

function tailBuffer(previous, chunk, limit = STREAM_TAIL_BYTES) {
  const next = Buffer.concat([previous, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

function outputOf(record) {
  // Each stream keeps half of the full budget, so the combined result is always
  // at most 16 KiB, even when a process floods both streams.
  return {
    stdout: utf8Tail(scrubSecrets(record.stdoutTail.toString('utf8')), STREAM_TAIL_BYTES),
    stderr: utf8Tail(scrubSecrets(record.stderrTail.toString('utf8')), STREAM_TAIL_BYTES),
  };
}

function utf8Tail(value, maximum) {
  const buffer = Buffer.from(value);
  let start = Math.max(0, buffer.length - maximum);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'TOOL_ERROR';
}

function localUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new ToolError('url must be an absolute localhost URL', { code: 'INVALID_ARGS' }); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new ToolError('check-url only accepts http(s) URLs on localhost, 127.0.0.1, or ::1', { code: 'SCOPE' });
  }
  url.hash = '';
  return url;
}

function publicationCommand(command) {
  // This is a guard against common accidental publication commands. It is not
  // a shell parser or a security boundary; shell syntax can always obscure intent.
  const text = command.replace(/\\[\r\n]/g, ' ');
  const git = /(?:^|[;&|()<>`\n]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;|&]+)\s+)*(?:(?:[^\s;|&]+\/)?git(?:\.exe)?\s+(?:(?:-[A-Za-z][\w-]*|--[\w-]+)(?:=[^\s;|&]+)?(?:\s+[^\s;|&]+)?\s+)*)push\b/i;
  const gh = /(?:^|[;&|()<>`\n]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;|&]+)\s+)*(?:(?:[^\s;|&]+\/)?gh(?:\.exe)?\s+(?:(?:-[A-Za-z][\w-]*|--[\w-]+)(?:=[^\s;|&]+)?(?:\s+[^\s;|&]+)?\s+)*)repo\s+create\b/i;
  return git.test(text) || gh.test(text);
}

function shellArguments(command) {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * Create a project-scoped coding registry and a managed host-process lifetime.
 * Shell commands run as the current host user; the workspace cwd is not a sandbox.
 */
export function createCodingTools({ workspace, onEvent, signal, allowWrite = true, allowShell = true } = {}) {
  if (typeof workspace !== 'string' || !workspace) throw new Error('coding tools need an explicit workspace');
  if (typeof allowWrite !== 'boolean' || typeof allowShell !== 'boolean') throw new Error('allowWrite and allowShell must be booleans');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new Error('onEvent must be a function');
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) throw new Error('signal must be an AbortSignal');

  const root = realpathSync(resolve(workspace));
  const processes = new Map();
  const backgroundRecords = new Map();
  const active = new Set();
  const lifecycle = new AbortController();
  let closed = signal?.aborted === true;
  let closePromise;

  const emit = (event) => {
    if (typeof onEvent !== 'function') return;
    try {
      const result = onEvent(Object.freeze({ at: new Date().toISOString(), ...event }));
      result?.catch?.(() => {});
    }
    catch { /* An observer must not interfere with a tool or process. */ }
  };
  const requireOpen = () => {
    if (closed) throw new ToolError('coding tools have been closed', { code: 'CLOSED' });
    signal?.throwIfAborted();
  };
  const combinedSignal = (callSignal) => {
    const signals = [signal, callSignal, lifecycle.signal].filter(Boolean);
    if (!signals.length) return undefined;
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  };
  const signalProcess = (record, name) => {
    if (!record.child) return;
    try {
      if (process.platform !== 'win32' && record.child.pid) process.kill(-record.child.pid, name);
      else record.child.kill(name);
    } catch (error) {
      if (error?.code !== 'ESRCH') emit({ type: 'process-signal-error', id: record.id, code: errorCode(error) });
    }
  };
  const terminate = (record) => {
    if (record.status !== 'running' && record.status !== 'starting') return record.done;
    signalProcess(record, 'SIGTERM');
    if (!record.killTimer) {
      record.killTimer = setTimeout(() => signalProcess(record, 'SIGKILL'), 250);
      record.killTimer.unref?.();
    }
    return record.done;
  };
  const statusOf = (record) => ({
    id: record.id,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...outputOf(record),
  });
  const publicView = (record) => Object.freeze({
    get id() { return record.id; },
    get status() { return record.status; },
    get exitCode() { return record.exitCode; },
    get signal() { return record.signal; },
    get startedAt() { return record.startedAt; },
    get finishedAt() { return record.finishedAt; },
    get stdout() { return outputOf(record).stdout; },
    get stderr() { return outputOf(record).stderr; },
    toJSON() { return statusOf(record); },
  });

  function launch(command, { background, timeoutMs, callSignal } = {}) {
    requireOpen();
    const effectiveSignal = combinedSignal(callSignal);
    effectiveSignal?.throwIfAborted();
    if (active.size >= MAX_CONCURRENT) throw new ToolError(`at most ${MAX_CONCURRENT} host processes may run at once`, { code: 'PROCESS_LIMIT', recoverable: true });
    if (background && typeof command !== 'string') throw new ToolError('command must be a string', { code: 'INVALID_ARGS' });
    const id = randomUUID();
    const record = {
      id, status: 'starting', exitCode: null, signal: null, startedAt: new Date().toISOString(),
      stdoutTail: Buffer.alloc(0), stderrTail: Buffer.alloc(0), child: null, killTimer: null,
      finishedAt: null, error: null,
    };
    record.done = new Promise((resolveDone) => { record.resolveDone = resolveDone; });
    const shell = shellArguments(command);
    let child;
    try {
      child = spawn(shell.file, shell.args, {
        cwd: root,
        env: safeEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
    } catch (cause) {
      record.status = 'failed'; record.finishedAt = new Date().toISOString();
      record.error = 'process could not start'; record.resolveDone();
      throw new ToolError('host process could not start', { code: 'PROCESS_START', cause });
    }
    record.child = child;
    record.status = 'running';
    active.add(record);
    if (background) {
      backgroundRecords.set(id, record);
      processes.set(id, publicView(record));
    }
    emit({ type: 'process-started', id, background, cwd: root });

    child.stdout?.on('data', (data) => { record.stdoutTail = tailBuffer(record.stdoutTail, data); });
    child.stderr?.on('data', (data) => { record.stderrTail = tailBuffer(record.stderrTail, data); });
    child.once('error', (error) => {
      if (record.status === 'running' || record.status === 'starting') {
        record.status = 'failed'; record.error = 'process could not start';
        record.finishedAt = new Date().toISOString();
        active.delete(record);
        emit({ type: 'process-failed', id, code: errorCode(error) });
        record.resolveDone();
      }
    });
    child.once('close', (code, terminationSignal) => {
      // A shell leader can exit before descendants. Keep group escalation alive.
      record.exitCode = Number.isInteger(code) ? code : null;
      record.signal = terminationSignal || null;
      record.finishedAt = new Date().toISOString();
      if (record.status === 'running' || record.status === 'starting') {
        record.status = terminationSignal ? 'stopped' : 'exited';
      }
      active.delete(record);
      emit({ type: record.status === 'stopped' ? 'process-stopped' : 'process-exited', id, exitCode: record.exitCode, signal: record.signal });
      record.resolveDone();
    });

    if (effectiveSignal?.aborted) terminate(record);
    return { record, signal: effectiveSignal, timeoutMs };
  }

  const projectTools = createProjectTools({ workspace: root, allowWrite, allowShell: false });
  const edit = createEditTool(projectTools);
  if (edit) projectTools.push(edit);
  const tools = projectTools.map((base) => ({
    ...base,
    async execute(args, context = {}) {
      requireOpen();
      const callSignal = combinedSignal(context.signal);
      emit({ type: 'tool-started', tool: base.name });
      try {
        const result = await base.execute(args, { ...context, signal: callSignal });
        emit({ type: 'tool-completed', tool: base.name });
        return result;
      } catch (error) {
        emit({ type: 'tool-failed', tool: base.name, code: errorCode(error) });
        throw error;
      }
    },
  }));

  const addTool = (name, description, input_schema, execute) => tools.push({
    name, description, input_schema,
    async execute(args, context = {}) {
      requireOpen();
      const errors = validateValue(args, input_schema);
      if (errors.length) throw new ToolError(`${name}: invalid arguments: ${errors.slice(0, 5).join('; ')}`, { code: 'INVALID_ARGS' });
      emit({ type: 'tool-started', tool: name });
      try {
        const result = await execute(args, context);
        emit({ type: 'tool-completed', tool: name });
        return result;
      } catch (error) {
        emit({ type: 'tool-failed', tool: name, code: errorCode(error) });
        throw error;
      }
    },
  });

  if (allowShell) {
    addTool('run-command', 'Run a host shell command from the project workspace. Host-user permissions apply; cwd is not a sandbox. Output is a redacted tail of at most 16 KiB. Publishing commands are blocked.', runSchema, async ({ command, timeout_ms }, context) => {
      if (publicationCommand(command)) throw new ToolError('publishing commands require an explicit publication capability', { code: 'PUBLICATION_BLOCKED' });
      const timeout = timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
      const { record, signal: effectiveSignal } = launch(command, { callSignal: context.signal });
      let timer;
      let abortHandler;
      let cancellation;
      if (effectiveSignal) {
        abortHandler = () => { cancellation = new ToolError('host command was cancelled', { code: 'ABORTED' }); terminate(record); };
        effectiveSignal.addEventListener('abort', abortHandler, { once: true });
        if (effectiveSignal.aborted) abortHandler();
      }
      timer = setTimeout(() => {
        cancellation = new ToolError(`host command exceeded ${timeout}ms`, { code: 'TIMEOUT' });
        terminate(record);
      }, timeout);
      try {
        await record.done;
        if (cancellation) throw cancellation;
        return {
          exitCode: record.exitCode,
          ...(record.signal ? { signal: record.signal } : {}),
          ...(record.error ? { error: record.error } : {}),
          ...outputOf(record),
        };
      } finally {
        clearTimeout(timer);
        effectiveSignal?.removeEventListener('abort', abortHandler);
      }
    });

    addTool('start-process', 'Start a managed host process across chat turns. For a web server supply port, and use the exact same explicit port in the command. An occupied port is rejected; no unrelated process is killed. Host-user permissions apply; cwd is not a sandbox.', startSchema, async ({ command, port }, context) => {
      if (publicationCommand(command)) throw new ToolError('publishing commands require an explicit publication capability', { code: 'PUBLICATION_BLOCKED' });
      if (port) {
        await new Promise((resolvePort, reject) => {
          const probe = createServer();
          probe.once('error', () => reject(new ToolError(`Port ${port} is already occupied or unavailable. Do not switch ports or kill unrelated processes.`, { code: 'PORT_OCCUPIED' })));
          probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(resolvePort));
        });
      }
      const { record } = launch(command, { background: true, callSignal: context.signal });
      record.port = port ?? null;
      return { id: record.id, status: record.status, startedAt: record.startedAt };
    });

    addTool('process-status', 'Return the current status and bounded, redacted output tail for a managed background process.', processIdSchema, async ({ id }) => {
      const record = backgroundRecords.get(id);
      if (!record) throw new ToolError('managed process was not found', { code: 'ENOENT', recoverable: true });
      return statusOf(record);
    });

    addTool('stop-process', 'Stop a managed background process group and return its final status and bounded output tail.', processIdSchema, async ({ id }) => {
      const record = backgroundRecords.get(id);
      if (!record) throw new ToolError('managed process was not found', { code: 'ENOENT', recoverable: true });
      await terminate(record);
      return statusOf(record);
    });
  }

  addTool('check-url', 'Wait for an HTTP 2xx response from one explicit localhost URL. It never tries another port or follows redirects off localhost.', urlSchema, async ({ url: rawUrl, timeout_ms }, context) => {
    const target = localUrl(rawUrl);
    const timeout = timeout_ms ?? DEFAULT_URL_TIMEOUT_MS;
    const effectiveSignal = combinedSignal(context.signal);
    const deadline = Date.now() + timeout;
    let attempts = 0;
    let lastStatus = null;
    let lastError = null;
    do {
      effectiveSignal?.throwIfAborted();
      attempts++;
      const requestTimeRemaining = Math.max(1, deadline - Date.now());
      const requestController = new AbortController();
      const requestTimer = setTimeout(() => requestController.abort(), Math.min(2_000, requestTimeRemaining));
      const abortHandler = () => requestController.abort(effectiveSignal?.reason);
      effectiveSignal?.addEventListener('abort', abortHandler, { once: true });
      try {
        let requestUrl = new URL(target);
        let response;
        let redirects = 0;
        while (true) {
          response = await fetch(requestUrl, { redirect: 'manual', signal: requestController.signal });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            lastStatus = response.status;
            if (!location || redirects++ >= 5) break;
            const next = new URL(location, requestUrl);
            if (!['http:', 'https:'].includes(next.protocol) || next.origin !== target.origin || next.username || next.password) break;
            requestUrl = next;
            continue;
          }
          lastStatus = response.status;
          await response.body?.cancel();
          break;
        }
        if (lastStatus !== null && lastStatus >= 200 && lastStatus < 300) {
          return {
            ready: true, status: lastStatus, host: target.hostname,
            port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
            attempts, elapsed_ms: Math.max(0, timeout - Math.max(0, deadline - Date.now())),
          };
        }
        lastError = null;
      } catch (error) {
        if (effectiveSignal?.aborted) effectiveSignal.throwIfAborted();
        lastError = error?.name === 'AbortError' ? 'request-timeout' : 'connection-failed';
      } finally {
        clearTimeout(requestTimer);
        effectiveSignal?.removeEventListener('abort', abortHandler);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await abortableDelay(Math.min(200, remaining), effectiveSignal);
    } while (Date.now() < deadline);
    return {
      ready: false, status: lastStatus, host: target.hostname,
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)), attempts,
      elapsed_ms: Math.max(0, timeout - Math.max(0, deadline - Date.now())),
      reason: lastError || 'not-ready',
    };
  });

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    if (!lifecycle.signal.aborted) lifecycle.abort(new ToolError('coding tools have been closed', { code: 'CLOSED' }));
    closePromise = (async () => {
      const running = [...active];
      for (const record of running) terminate(record);
      if (running.length) {
        await boundedWait(Promise.all(running.map((record) => record.done)), 1_000);
      }
      for (const record of active) signalProcess(record, 'SIGKILL');
      if (active.size) {
        await boundedWait(Promise.all([...active].map((record) => record.done)), 1_000);
      }
      emit({ type: 'registry-closed', processCount: processes.size });
    })();
    return closePromise;
  };
  signal?.addEventListener('abort', () => { void close(); }, { once: true });
  if (signal?.aborted) void close();

  return { tools, close, processes };
}

function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  signal.throwIfAborted();
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new ToolError('operation was cancelled', { code: 'ABORTED' }));
    };
    function cleanup() { signal.removeEventListener('abort', onAbort); }
    function done() { cleanup(); resolveDelay(); }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function boundedWait(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolveDelay) => { timer = setTimeout(resolveDelay, ms); }),
  ]).finally(() => clearTimeout(timer));
}

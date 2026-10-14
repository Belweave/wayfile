#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const help = `waycode chat --workspace <directory> [--session <id>] [--model <provider-model>]
waycode run --workspace <directory> --message <task> [--session <id>]
waycode doctor [--workspace <directory>]

Options: --read-only disables writes and command execution.
         --check-url http://localhost:3000 requires a live HTTP check.
         --session-dir <directory> overrides local session storage.
Chat: /help, /status, /publish owner/repo [private|public], /quit.
Models use OPENROUTER_API_KEY or ANTHROPIC_API_KEY. Set WAYFILE_MODEL or --model.
Load a local environment explicitly: node --env-file=.env apps/waycode/bin/waycode.js ...
Commands execute as your host user. Use a dedicated workspace.`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    workspace: { type: 'string' }, session: { type: 'string' }, model: { type: 'string' },
    message: { type: 'string' }, 'session-dir': { type: 'string' },
    'check-url': { type: 'string' }, 'read-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (!['chat', 'run', 'doctor'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  if (command !== 'doctor' && !values.workspace) throw new Error('Choose a dedicated directory with --workspace <directory>.');
  if (command === 'run' && !values.message?.trim()) throw new Error('run requires --message <task>.');
  if (values.model) process.env.WAYFILE_MODEL = values.model;
  const workspace = resolve(values.workspace || '.');
  if (command === 'doctor') {
    const available = (name) => spawnSync(name, ['--version'], { timeout: 10000, stdio: 'ignore' }).status === 0;
    const checks = [
      ['Node >=20.6.0', (() => { const [major, minor] = process.versions.node.split('.').map(Number); return major > 20 || (major === 20 && minor >= 6); })()],
      ['Model key configured', Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY)],
      ['git available', available('git')],
      ['npm available', available('npm')],
      ['GitHub CLI available (publishing only)', available('gh')],
    ];
    for (const [label, passed] of checks) console.log(`${passed ? 'OK' : 'MISSING'} ${label}`);
    console.log(`Workspace: ${workspace}`);
    if (!checks[0][1] || !checks[1][1]) process.exitCode = 1;
    return;
  }
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error('Configure OPENROUTER_API_KEY or ANTHROPIC_API_KEY before starting. Environment files are not loaded automatically.');
  await mkdir(workspace, { recursive: true });
  const root = await realpath(workspace);
  const { createCodingSession } = await import('../src/coding.js');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Cancelled by user'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let session, rl;
  try {
    session = await createCodingSession({ workspace: root, sessionId: values.session,
      sessionDir: values['session-dir'], signal: controller.signal,
      model: values.model || process.env.WAYFILE_MODEL,
      codingToolsOptions: { allowWrite: !values['read-only'], allowShell: !values['read-only'] },
      checkURL: values['check-url'],
      onEvent(event) {
        const label = event.tool || event.name || event.type || 'progress';
        console.error(`[${label}]${event.message ? ` ${String(event.message).slice(0, 200)}` : ''}`);
      },
    });
    console.log(`Session: ${session.id}\nWorkspace: ${root}`);
    if (command === 'chat') console.log(`Resume later with --session ${session.id}`);
    const perform = async (message) => {
      const result = await session.turn(message);
      if (command === 'run') console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Agent> ${result.answer || result.error || result}`);
        if (result.question) console.log(`Question: ${result.question}`);
        if (result.changedFiles?.length) console.log(`Changed: ${result.changedFiles.join(', ')}`);
        console.log(`Status: ${result.status}${result.trace ? `\nTrace: ${result.trace}` : ''}`);
      }
      if (command === 'run' && result?.status !== 'completed') process.exitCode = 1;
    };
    if (command === 'run') { await perform(values.message); return; }
    console.log('Type a task. /help shows commands. Ctrl-C cancels and closes the session.');
    rl = createInterface({ input: stdin, output: stdout });
    controller.signal.addEventListener('abort', () => rl.close(), { once: true });
    while (!controller.signal.aborted) {
      let message;
      try { message = (await rl.question('You> ')).trim(); } catch { break; }
      if (!message) continue;
      if (message === '/quit') break;
      if (message === '/help') { console.log(help); continue; }
      if (message === '/status') { console.log(`Session ${session.id}\n${session.history?.length || 0} saved entries`); continue; }
      try {
        if (message.startsWith('/publish')) {
          if (values['read-only']) throw new Error('Publication is disabled in read-only mode.');
          const match = message.match(/^\/publish ([\w.-]+\/[\w.-]+)(?: (private|public))?$/);
          if (!match) throw new Error('Use /publish owner/repo [private|public].');
          const { verifyAndPublish } = await import('../src/coding-release.js');
          console.log(await verifyAndPublish({ workspace: root, repo: match[1], visibility: match[2] || 'private', checkURL: values['check-url'], signal: controller.signal, assertPreview: url => session.ownsPreview(url) }));
        } else if (message.startsWith('/')) throw new Error('Unknown command. Use /help.');
        else await perform(message);
      } catch (error) { console.error(`waycode: ${error.message}`); }
    }
  } finally {
    rl?.close(); await session?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`waycode: ${error.message}`); process.exitCode = 1; });
}

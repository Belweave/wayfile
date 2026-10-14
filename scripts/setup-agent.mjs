#!/usr/bin/env node
import { cp, mkdir, writeFile, readdir, lstat, realpath, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(process.argv[2]?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), 'Code', 'waycode-agent'));
let staging;
async function requireEmpty(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length) throw new Error('Choose a new or empty directory; existing agent files will not be overwritten.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
try {
  await requireEmpty(destination);
  await mkdir(dirname(destination), { recursive: true });
  const root = join(await realpath(dirname(destination)), basename(destination));
  staging = await mkdtemp(join(dirname(root), '.waycode-setup-'));
  const runtime = join(staging, 'runtime');
  await mkdir(runtime);
  for (const path of ['package.json', 'packages', 'apps']) {
    await cp(join(repo, path), join(runtime, path), { recursive: true, filter: source => !source.split(/[\\/]/).some(part => ['node_modules', '.git', '.wayfile', 'runs', 'sessions'].includes(part) || /^\.env(?:$|[._-]|rc$)/i.test(part)) });
  }
  // npm excludes package-lock.json from release tarballs. Local-only workspace
  // dependencies can be installed offline without one; preserve it in checkouts.
  try { await cp(join(repo, 'package-lock.json'), join(runtime, 'package-lock.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const install = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime, encoding: 'utf8', timeout: 30000 });
  if (install.status !== 0) throw new Error(`Local runtime installation failed: ${install.stderr || install.error?.message || 'unknown error'}`);
  await mkdir(join(staging, 'site'));
  await writeFile(join(staging, '.env'), 'OPENROUTER_API_KEY=PASTE_YOUR_KEY_HERE\nWAYFILE_MODEL=anthropic/claude-sonnet-4.5\nWAYFILE_MAX_USD=10\n', { mode: 0o600 });
  await writeFile(join(staging, '.gitignore'), '.env\n.env.*\nsessions/\nsite/node_modules/\nsite/.next/\n');
  await writeFile(join(staging, 'start.sh'), `#!/bin/sh
set -eu
agent_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node --env-file="$agent_root/.env" --input-type=module -e '
if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === "PASTE_YOUR_KEY_HERE") {
  console.error("Paste your OpenRouter key into the agent folder .env and save it first.");
  process.exit(1);
}'
exec node --env-file="$agent_root/.env" "$agent_root/runtime/apps/waycode/bin/waycode.js" chat --workspace "$agent_root/site" --session-dir "$agent_root/sessions" --check-url http://localhost:3000 "$@"
`, { mode: 0o755 });
  await requireEmpty(root);
  await rename(staging, root);
  staging = null;
  console.log(`Created ${root}\nPaste your key into ${join(root, '.env')}\nStart: ${join(root, 'start.sh')}`);
} catch (error) { console.error(`setup-agent: ${error.message}`); process.exitCode = 1; }
finally { if (staging) await rm(staging, { recursive: true, force: true }); }

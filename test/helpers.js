import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Write a graph from {filename: text} into a fresh temp dir and return the dir.
export function tmpGraph(files) {
  const dir = mkdtempSync(join(tmpdir(), 'wayfile-'));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), t);
    if (f.endsWith('.sh')) chmodSync(join(dir, f), 0o755);
  }
  return dir;
}

export const node = (meta, routes = [], body = '# T\nbody') =>
  `---\n${meta}\n---\n${body}\n${routes.length ? `\n## Routes\n${routes.join('\n')}\n` : ''}`;

export const fakeJudge = (target, usage = { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 }) => {
  const calls = [];
  const fn = async (graph, n, state, targets) => { calls.push({ n: n.id, targets }); return { target, usage }; };
  fn.calls = calls;
  return fn;
};

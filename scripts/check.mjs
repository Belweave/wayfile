import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { check, format } from '../packages/wayfile/src/check.js';

async function syntax(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) await syntax(path);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${path}`);
    }
  }
}
for (const directory of ['packages', 'apps', 'scripts']) await syntax(directory);
for (const directory of ['packages/wayfile/templates/agent', 'apps/waycode/agent', 'examples/triage', 'examples/ci', 'examples/harness', 'bench/evidence-agent']) {
  const findings = await check(loadGraph(directory));
  findings.forEach(finding => console.log(format(finding)));
  if (findings.some(finding => finding.level === 'error')) throw new Error(`Graph check failed: ${directory}`);
  console.log(`OK ${directory}`);
}

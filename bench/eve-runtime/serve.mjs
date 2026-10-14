import { startRuntime, stopRuntime } from './adapter.mjs';

const args = process.argv.slice(2);
const graph = args.includes('--graph') ? args[args.indexOf('--graph') + 1] : 'triage';
if (args.includes('--mode') && args[args.indexOf('--mode') + 1] !== 'mock') throw new Error('This standalone server is mock-only. Use run.js for a guarded paid experiment.');
const runtime = await startRuntime({ mock: true });
const server = await runtime.ensureServer(graph);
console.log(`Eve 0.79.0 ${graph} mock fixture: ${server.host}\nArtifacts: ${runtime.artifactDir}`);
await new Promise((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
await stopRuntime(runtime);

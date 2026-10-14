# Repository guide

Wayfile is a Node.js monorepo with no external runtime dependencies.

- `packages/wayfile`: file graph, model adapters, tools, contracts, CLI, and starter templates.
- `apps/waycode`: conversational coding host, managed processes, publisher, and coding agent graph.
- `examples`: small runnable agent workflows.
- `bench`: evaluation code and the separately installed, pinned Eve comparison fixture.
- `test`: Node test runner unit, integration, and package-installation checks.

## Testing

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run check`, and `npm test` from the root.
Tests use isolated fixtures and model mocks. Do not run paid model evaluations,
the user's Next.js workload, or live GitHub publication without explicit authorization.
Keep concurrency bounded; the root test command uses two workers.

## Publication

Never commit `.env`, API keys, sessions, run traces, caches, or `node_modules`.
Keep actual Eve results distinct from historical Eve-style simulations.
Preserve evidence limitations next to benchmark claims.

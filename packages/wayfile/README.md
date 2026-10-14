# Wayfile framework

The dependency-free runtime turns Markdown nodes into an explicit agent graph.
It includes deterministic routes, focused model decisions, executable scripts,
bounded tool harnesses, output contracts, human decisions, and source-linked traces.

From the repository root:

```sh
npm install
npm run wayfile -- init ../my-agent
npm run wayfile -- check ../my-agent
npm run wayfile -- explain ../my-agent --input ../my-agent/input.json
```

Use the `wayfile` workspace exports for application integration, including
`wayfile`, `wayfile/harness`, and `wayfile/tools`. The CLI and starter templates
live in `bin/` and `templates/`.

See the [repository guide](../../README.md), [tool harness API](../../docs/HARNESS.md),
and [examples](../../examples).

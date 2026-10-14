# Waycode: a local Wayfile coding agent

Waycode is the coding-agent app in `apps/waycode/`, built around a file-defined
Wayfile workflow from `packages/wayfile/`. It edits and executes programs in an
explicit workspace, saves session history outside that workspace, and checks
results independently of model claims.

## Start

Requires Node 20.6.0+, a configured model provider, and your project's toolchain.
GitHub publishing additionally needs Git and an authenticated `gh` installation.
From the repository root, install the npm workspaces and run the app script:

```sh
npm install
npm run waycode -- doctor
npm run waycode -- chat --workspace ../my-site \
  --check-url http://localhost:3000
```

The workspace may be a new directory. Use a dedicated project directory rather
than this framework's checkout. Export `OPENROUTER_API_KEY` or
`ANTHROPIC_API_KEY` in the shell before running `npm run waycode`; the CLI does not
load `.env` automatically. To use a local `.env` file, invoke the CLI directly:
`node --env-file=.env apps/waycode/bin/waycode.js doctor`. Choose your provider's
coding-capable model with `WAYFILE_MODEL` or `--model`. Model identifiers are
provider-specific; T3 subagent model names are not automatically API model IDs.
The coding default is Sonnet 4.5 through the selected provider. OpenRouter's
`WAYFILE_MAX_USD` guard defaults to $10 across this process's model calls; raise it
explicitly for a larger site if needed. A request in flight can cross the limit.

To create a clean standalone agent folder, run this from the checkout root:

```sh
npm run setup-agent -- ~/Code/waycode-agent
```

The setup command creates a `runtime/` copy of the workspace packages, installs
that runtime from the local npm cache, creates an empty `site/` directory, writes
a `.env` key placeholder and a `.gitignore`, and adds a `start.sh` launcher. It
accepts a new or empty destination and refuses to overwrite existing files. Add
your key to the generated `.env`, then start Waycode with
`~/Code/waycode-agent/start.sh`. The root aggregate package also exposes both
`wayfile` and `waycode` when installed with `npm install -g .`. A single task can
be run with `npm run waycode -- run --workspace <dir> --message <task>`.

## A site-building request

Tell the agent the site's purpose, required pages and interactions, and visual
direction. Specify Next.js and localhost:3000. It can install dependencies, write
source, run checks, and start a managed development server. Port collisions should
be investigated rather than silently switching ports or killing unrelated servers.

`--check-url` requires an HTTP observation at the specified URL. It does not prove
that every interaction is correct or that the page looks good. Review the site
before publishing. Package scripts and local checks are execution evidence, not a
guarantee that generated code satisfies every requirement.

## Conversation controls

- `/help` prints commands.
- `/status` identifies the saved session.
- `/quit` closes the session and stops its managed processes.
- Ctrl-C cancels and closes the session.
- `--session <id>` resumes saved conversation context. An interrupted run is
  recorded; actions are not silently replayed.
- `--read-only` disables writes, command execution, and publishing.

Progress is printed while tools execute. Failures remain visible in saved history.
Each completed or failed turn returns a disk trace path with its tool progress and
verification evidence; traces are stored alongside the session outside the project.
The verifier selects the package manager from a single supported lockfile and
runs defined `typecheck`, `lint`, `test`, and `build` scripts sequentially. Missing
checks remain unverified. Failed checks allow at most two repair rounds by default.
Session persistence is conversation persistence, not a checkpoint that can resume
an arbitrary in-flight tool call. Servers must be restarted after closing the host.

## GitHub publication

After reviewing the site, explicitly invoke:

```text
/publish your-account/your-site private
```

Public visibility must be requested explicitly. This command publishes source to a
GitHub repository; hosting the website is a separate operation. Publication uses
the trusted host path rather than model-selected shell commands. It checks local
verification evidence and repository scope, excludes generated and sensitive files,
and never force-pushes or overwrites a conflicting origin. Configure `gh auth login`
and Git author identity ahead of time.
Pre-existing staged changes must be resolved first. The explicit publication
command authorizes committing the eligible local source changes in this workspace.
Reachable branch history is scanned as well as current files. Detected credentials
or protected files in history block publication; history is never rewritten.
A failed remote operation may have created a
repository or local commit; inspect the reported state before retrying.

## Execution boundaries

The model has a declared tool list and bounded turns, calls, outputs, and repair
attempts. File helpers enforce workspace boundaries and protect sensitive paths.
Shell commands run with host-user permissions: this is not an OS sandbox, and
shell code can bypass file-helper restrictions. Use a container or dedicated
account for untrusted code. Do not provide production credentials to the workspace.

Verification runs project code, too. Dependencies, scripts, and project instructions
must be trusted to execute locally. Model transport errors are not automatically
replayed because earlier tool calls may already have changed files.

The coding graph and schemas live in `apps/waycode/agent/`; the conversation host,
managed process tools, and publisher live in `apps/waycode/src/coding*.js`. The
Wayfile core, CLI, and starter templates live in `packages/wayfile/`. Tests remain
in the repository-root `test/` directory and use mocks and isolated local
fixtures. They do not build a Next.js site, contact a paid model, or publish to GitHub.

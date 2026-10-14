# Waycode coding agent

Waycode adds persistent terminal chat to Wayfile: project file tools, hash-guarded
edits, managed processes, independent verification, and explicit GitHub publication.
The agent graph and its output schemas live in `agent/`; the conversation host
and trusted executors live in `src/`.

From the repository root:

```sh
npm install
npm run setup-agent -- ~/Code/my-waycode-agent
```

Paste a provider key into the new folder's `.env`, then run its `start.sh`.
The setup command assembles a runtime copy of the workspace packages in a
temporary sibling directory, installs it with npm's offline mode, then moves the
completed folder into place. It accepts a new or empty destination and refuses to
overwrite existing files. The setup does not require `package-lock.json`, which
is omitted from npm tarballs. It also creates an empty `site/` workspace, a local
`.env` placeholder, a `.gitignore`, and a `start.sh` launcher. Credentials and
sessions stay local.

Read the [coding guide](../../docs/CODING.md) for model configuration, session
resumption, execution boundaries, verification, and the `/publish` command.

# Antigravity Subagent for Codex

[![CI](https://github.com/IlleJiViN/codex-antigravity-subagent/actions/workflows/ci.yml/badge.svg)](https://github.com/IlleJiViN/codex-antigravity-subagent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/IlleJiViN/codex-antigravity-subagent)](https://github.com/IlleJiViN/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as an external second agent from Codex. Ask Antigravity for a review, research pass, debugging hypothesis, or bounded implementation while Codex remains responsible for verification and the final result.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI.

## What it adds

- `agy_check` verifies that Antigravity CLI is installed and reports its path.
- `agy_delegate` runs one bounded prompt in Antigravity headless mode and returns its response.
- `$delegate-to-antigravity` teaches Codex when and how to delegate safely.

Delegation defaults to `plan` mode. Edit-capable calls are marked as potentially destructive for the MCP host, dangerous permission-bypass flags are not exposed, executions time out, and captured output is capped at 2 MiB.

## Requirements

- Codex CLI or Codex in the ChatGPT desktop app
- Node.js 20 or newer
- [Google Antigravity CLI](https://antigravity.google/docs/cli-getting-started), installed and authenticated as `agy`

Verify the prerequisites:

```powershell
node --version
agy --version
```

## Install

### 1. Add the GitHub marketplace

Run this once:

```powershell
codex plugin marketplace add IlleJiViN/codex-antigravity-subagent --ref main
```

The command is identical on Windows, macOS, and Linux.

### 2. Install the plugin

Open the Codex plugin browser:

```text
codex
/plugins
```

Choose the **Antigravity Subagent** marketplace, open **antigravity-subagent**, and install it. Start a new Codex session afterward so the skill and MCP tools are loaded.

Plugins are not currently available in the Codex IDE extension; use Codex CLI or the ChatGPT desktop app.

## First successful delegation

In a new Codex session, try:

```text
Use $delegate-to-antigravity to ask Antigravity for a second opinion on this bug.
Keep it in plan mode and do not modify files.
```

Codex should first call `agy_check`, then call `agy_delegate` with the current workspace and `mode: plan`. A successful result returns Antigravity's analysis to Codex for verification.

Other useful prompts:

```text
Ask Antigravity to review this implementation for missed edge cases.
Delegate a bounded research pass on these three files to Antigravity.
Use Antigravity to propose a fix, but keep it in plan mode.
```

## Permission and data flow

`agy_delegate` starts the official `agy --print` process on your machine. The prompt, workspace path, and any files Antigravity chooses to read are handled according to your local Antigravity configuration, Google account, sandbox, and permission settings.

The plugin:

- does not collect telemetry or run a remote service;
- does not store prompts or Antigravity responses itself;
- does not expose `--dangerously-skip-permissions`;
- does not bypass Antigravity authentication or approval prompts;
- captures child-process output only to return it to the active Codex session.

Do not delegate secrets, credentials, private customer data, deployments, purchases, or destructive operations unless you explicitly intend to send that scope through Antigravity.

## Modes

| Mode | Intended use | Can change files? |
| --- | --- | --- |
| `plan` | Reviews, research, diagnosis, proposed changes | No edits intended |
| `default` | Follow your persisted Antigravity policy | Depends on local policy |
| `accept-edits` | Explicitly authorized implementation | Yes |

Codex should use `plan` unless you explicitly request workspace changes.

## Update or remove

Refresh this marketplace to the newest `main` version:

```powershell
codex plugin marketplace upgrade antigravity-subagent
```

Use `/plugins` in Codex CLI to update, disable, or uninstall the plugin. Remove the marketplace entirely with:

```powershell
codex plugin marketplace remove antigravity-subagent
```

## Troubleshooting

### `agy_check` says the CLI is missing

Install Antigravity from the [official getting-started guide](https://antigravity.google/docs/cli-getting-started), open a new terminal, authenticate with `agy`, then restart Codex.

### The plugin does not appear

Run `codex plugin marketplace list`, confirm `antigravity-subagent` is present, then restart Codex and open `/plugins` again.

### A delegation waits for approval

Complete the Antigravity authentication or permission prompt in a terminal. The plugin intentionally does not bypass interactive security checks.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm install
npm run check
npm run build
npm test
```

`npm test` performs a real stdio MCP round trip and calls the installed `agy` CLI in `plan` mode. CI uses `npm run test:protocol` so contributors can validate the MCP handshake without an Antigravity account. The checked-in `dist/server.cjs` is the runtime artifact used by the installed plugin.

Security reports and the trust model are documented in [SECURITY.md](SECURITY.md). Contributions are welcome through issues and pull requests.

The project's [Privacy Policy](PRIVACY.md) and [Terms of Use](TERMS.md) apply to public directory distribution.

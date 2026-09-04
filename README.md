# Antigravity Subagent for Codex

[![CI](https://github.com/IlleJiViN/codex-antigravity-subagent/actions/workflows/ci.yml/badge.svg)](https://github.com/IlleJiViN/codex-antigravity-subagent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/IlleJiViN/codex-antigravity-subagent)](https://github.com/IlleJiViN/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as an external delegated worker from Codex. Codex can start a bounded Antigravity task, review the resulting workspace changes, send corrections back into the same Antigravity conversation, and close that worker before starting the next plan step.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI.

## What it adds

- `agy_check` verifies the Antigravity CLI and reports compatibility information such as version, required headless flags, conversation resume support, and model-catalog availability.
- `agy_delegate` runs one bounded one-shot Antigravity prompt for reviews, research, and tasks that do not need follow-up.
- `agy_start` starts a resumable Antigravity worker and returns both a bridge `workerId` and the underlying Antigravity `conversationId`.
- `agy_followup` sends review feedback back to the same Antigravity conversation.
- `agy_close` forgets the bridge worker mapping after review passes without deleting the Antigravity conversation.
- `$delegate-to-antigravity` teaches Codex how to delegate, review, correct, and close workers safely.

Managed delegation uses Antigravity structured JSON output. The plugin exposes compact status, duration, turn count, and token-usage metadata while limiting the model response returned to Codex to 64 KiB. Successful stderr diagnostics are not copied into Codex context.

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

## Managed worker workflow

For implementation work, prefer a managed worker:

```text
Codex plan step
   │
   ▼
agy_start
   │
   ▼
Antigravity worker A
   │
   ▼
Codex reviews diff/tests
   │
   ├── FAIL ──► agy_followup(worker A) ──► review again
   │
   └── PASS ──► agy_close(worker A)
                    │
                    ▼
               next plan step
                    │
                    ▼
               new worker B
```

A new worker asks the user to choose an Antigravity model and reasoning effort through MCP elicitation unless both values were supplied explicitly. Effort-suffixed CLI variants are grouped into a base-model choice where possible, so the picker can present a model and effort separately instead of making the user choose the same concept twice.

`agy_followup` keeps the worker's original workspace, model, effort, mode, and conversation. It does not prompt for model or effort again.

## Auditing delegated sessions

Managed workers preserve the Antigravity `conversation_id`. Closing a worker only removes the MCP-side mapping; it does not delete the Antigravity conversation.

From the same workspace, you can inspect previous sessions interactively:

```text
agy
/resume
```

Or resume a known conversation directly:

```powershell
agy --conversation <conversation-id>
```

This provides an audit trail of the conversation and visible agent/tool activity Antigravity stores. It is not access to hidden model chain-of-thought.

## One-shot delegation

Use `agy_delegate` when a task is bounded and does not need a review/fix loop, for example a second opinion, read-only analysis, or research pass.

Useful prompts include:

```text
Ask Antigravity to review this implementation for missed edge cases.
Delegate this bounded research pass to Antigravity and keep it read-only.
Use Antigravity to implement this plan step, review its diff, and send corrections back to the same worker until it passes.
```

## Permission and data flow

The plugin starts the official `agy --print` process on your machine. The prompt, workspace path, and any files Antigravity chooses to read are handled according to your local Antigravity configuration, Google account, sandbox, and permission settings.

The plugin:

- does not collect telemetry or run a remote service;
- does not expose `--dangerously-skip-permissions`;
- does not bypass Antigravity authentication or approval prompts;
- keeps managed worker state only for the lifetime of the MCP server;
- preserves Antigravity conversation IDs so users can audit delegated sessions later;
- limits response and diagnostic output before returning it to Codex.

Do not delegate secrets, credentials, private customer data, deployments, purchases, or destructive operations unless you explicitly intend to send that scope through Antigravity.

## Modes

| Mode | Intended use | Can change files? |
| --- | --- | --- |
| `plan` | Reviews, research, diagnosis, proposed changes | No edits intended |
| `default` | Follow your persisted Antigravity policy | Depends on local policy |
| `accept-edits` | Explicitly authorized implementation | Yes |

`agy_start` defaults to `accept-edits` because managed workers are intended primarily for implementation workflows. Use `plan` for read-only review or research work.

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

### `agy_check` reports incompatible capabilities

Update Antigravity CLI and rerun `agy_check`. Managed workers require headless JSON output, model selection, reasoning effort, conversation resume, mode support, and a readable model catalog.

### The model/effort picker cannot be displayed

Some MCP clients may not support elicitation forms. Pass both `model` and `effort` explicitly in that environment.

### The plugin does not appear

Run `codex plugin marketplace list`, confirm `antigravity-subagent` is present, then restart Codex and open `/plugins` again.

### A delegation waits for approval

Complete the Antigravity authentication or permission prompt in a terminal. The plugin intentionally does not bypass interactive security checks.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm ci
npm run check
npm run build
npm run test:protocol
npm test
```

`npm test` performs a real stdio MCP round trip against the installed `agy` CLI. It validates capability reporting and the managed lifecycle (`agy_start` → `agy_followup` → `agy_close`) with a real Antigravity conversation. `npm run test:protocol` validates MCP schemas and the stdio handshake without consuming an Antigravity account quota.

The checked-in `dist/server.cjs` is the runtime artifact used by the installed plugin and must be regenerated after source changes.

Security reports and the trust model are documented in [SECURITY.md](SECURITY.md). Contributions are welcome through issues and pull requests.

The project's [Privacy Policy](PRIVACY.md) and [Terms of Use](TERMS.md) apply to public directory distribution.

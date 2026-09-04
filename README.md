# Antigravity Subagent for Codex

[![Release](https://img.shields.io/github/v/release/vacnex/codex-antigravity-subagent)](https://github.com/vacnex/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as an external delegated worker from Codex. Codex can start a bounded Antigravity task, review workspace changes, send corrections into the same conversation, recover that worker after Codex/MCP restarts, and close it only after review passes.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI. This fork is based on the original project by [IlleJiViN](https://github.com/IlleJiViN/codex-antigravity-subagent).

## What it adds

- `agy_check` verifies the Antigravity CLI, model catalog, required headless flags, and persistent `stream-json` support. Short-lived discovery caches can be bypassed with `refresh=true`.
- `agy_delegate` runs one bounded one-shot Antigravity prompt and honors MCP cancellation.
- `agy_start` starts a named resumable worker and returns both a bridge `workerId` and Antigravity `conversationId`.
- `agy_followup` reuses the same warm AGY process when possible, or resumes the exact persisted conversation after restart/process loss.
- `agy_status` shows active, recoverable, or closed worker metadata without reading stored prompts/responses (because the ledger never stores them).
- `agy_cancel` stops the active turn while preserving the worker conversation for later recovery.
- `agy_close` closes the managed worker while retaining local audit metadata and the Antigravity conversation.
- `$delegate-to-antigravity` teaches Codex how to delegate one plan step per worker, review, correct, recover, cancel, and close safely.

Managed responses are capped at 64 KiB. Stream step updates are summarized rather than dumped into Codex context. Results expose cumulative `sessionUsage` plus per-turn `turnUsage` deltas.

## Requirements

- Codex CLI or a supported Codex desktop surface that can run local MCP servers
- Node.js 20 or newer
- [Google Antigravity CLI](https://antigravity.google/docs/cli-getting-started), installed and authenticated as `agy`

```powershell
node --version
agy --version
```

## Install

```powershell
codex plugin marketplace add vacnex/codex-antigravity-subagent --ref main
```

Then open Codex, run `/plugins`, choose **Antigravity Subagent**, and install it. Start a new Codex session afterward so the skill and MCP tools are loaded.

Because this plugin declares a local MCP server, imported ChatGPT plugins can be labeled **Desktop only**; this local MCP runtime is not intended for ChatGPT web.

## Managed worker workflow

```text
Codex plan step
   │
   ▼
agy_start(name="Plan 2 - persistence")
   │
   ▼
Antigravity worker A
   │
   ▼
Codex reviews diff/tests
   │
   ├── FAIL ──► agy_followup(worker A) ──► review again
   │
   ├── STOP ──► agy_cancel(worker A) ──► recover later
   │
   └── PASS ──► agy_close(worker A)
                    │
                    ▼
               next plan step
                    │
                    ▼
               new worker B
```

A new worker asks the user to choose an Antigravity base model and reasoning effort unless both were supplied explicitly. Effort-suffixed model variants are grouped into base-model choices where possible.

### Warm persistent workers

When the installed AGY exposes both `--input-format stream-json` and `--output-format stream-json`, managed workers keep one warm AGY process alive between turns:

```text
agy_start
   ↓
spawn AGY once
   ↓
turn 1 over stdin
   ↓
result
   │
   ├─ process remains warm
   │
agy_followup
   ↓
turn 2 over same stdin/process
```

Only one turn may be active on a worker at a time. Older AGY versions automatically fall back to the v0.3 one-shot `--conversation <id>` path.

### Persistent registry and recovery

Worker metadata is stored outside the plugin installation directory:

```text
$CODEX_HOME/antigravity-subagent/workers
```

or `~/.codex/antigravity-subagent/workers` when `CODEX_HOME` is not set. Override it with `AGY_MCP_STATE_DIR`.

The ledger stores worker/conversation identity, friendly name, workspace, model/effort/mode, timestamps, lifecycle state, last transport/PID, turn count, and usage metadata. It **does not store prompts, responses, source code, or tool output**.

After Codex/MCP restarts, an open worker is loaded as `recoverable`. The next `agy_followup` starts a new AGY process with the exact saved `--conversation <id>`. A cross-process lease prevents two MCP instances from driving the same worker concurrently; stale leases are reclaimed when their owning process is gone or the lease expires.

> [!NOTE]
> v0.3 managed workers existed only in MCP memory, so workers created before upgrading to v0.4 cannot be reconstructed after a restart. Persistent recovery applies to workers created by v0.4 or later.

Warm AGY processes are released after an idle period while the logical worker remains recoverable. Set `AGY_MCP_IDLE_DRIVER_MS` to tune the idle duration (minimum 10 seconds; default 10 minutes).

Closed worker ledger records are intentionally retained for local audit. The plugin does not currently auto-prune them. If you no longer want that history, remove the corresponding worker JSON records while no MCP server instance is using that state directory. Removing a local ledger record does not delete Antigravity's own conversation history.

## Status and cancellation

```text
agy_status(workerId)
agy_status(includeClosed=true)
agy_cancel(workerId)
```

Status reports lifecycle state, warm/recoverable state, driver PID, lease information, last result, turns, and token usage. `agy_cancel` targets only the active turn; it does not delete the worker or Antigravity conversation.

MCP request cancellation is propagated to AGY, so a client Stop action can terminate the underlying stream or one-shot invocation rather than waiting for its timeout.

## Token and context handling

AGY persistent streams report cumulative usage. The plugin preserves that as `sessionUsage` (and the backward-compatible `usage` field) and computes `turnUsage` from the previous persisted usage snapshot.

Stream `step_update` payloads are parsed for observability but only compact counters are returned to Codex. Text deltas, tool payloads, subagent payloads, full diffs, and source content are not copied into the handoff.

CLI path discovery, capability reports, and model catalogs use short-lived caches to avoid repeated `agy --version`, `agy --help`, and `agy models` startup costs. Use `agy_check(refresh=true)` when a forced refresh is needed.

## Auditing delegated sessions

Managed workers preserve the Antigravity `conversation_id`. The friendly worker name is guaranteed in the local ledger; Antigravity may generate its own native conversation title.

From the same workspace:

```text
agy
/resume
```

Or resume a known conversation directly:

```powershell
agy --conversation <conversation-id>
```

This is an audit trail of persisted worker metadata plus visible Antigravity conversation/tool activity, not hidden chain-of-thought.

## One-shot delegation

Use `agy_delegate` when a task does not need a review/fix loop, for example a second opinion or read-only analysis. The bundled fallback runner remains available when MCP tools are unavailable, but it does not provide the persistent registry, leases, status/cancel tools, or managed recovery runtime.

## Permission and data flow

The plugin starts the official `agy` process on your machine. Prompts, workspace paths, and files Antigravity reads are handled according to your local Antigravity configuration, Google account, sandbox, and permission settings.

The plugin:

- does not collect telemetry or run a remote service;
- does not expose dangerous permission-bypass flags;
- does not bypass Antigravity authentication or approval prompts;
- persists only bounded worker metadata, never prompt/response/file contents;
- preserves Antigravity conversation IDs for audit and recovery;
- limits response and diagnostic output returned to Codex.

Do not delegate secrets, credentials, private customer data, deployments, purchases, or destructive operations unless you explicitly intend to send that scope through Antigravity.

## Modes

| Mode | Intended use | Can change files? |
| --- | --- | --- |
| `plan` | Reviews, research, diagnosis, proposed changes | No edits intended |
| `default` | Follow your persisted Antigravity policy | Depends on local policy |
| `accept-edits` | Explicitly authorized implementation | Yes |

`agy_start` defaults to `accept-edits`. Use `plan` for read-only review or research.

## Update or remove

```powershell
codex plugin marketplace upgrade antigravity-subagent
```

Use `/plugins` to update, disable, or uninstall the plugin. Remove the marketplace with:

```powershell
codex plugin marketplace remove antigravity-subagent
```

## Troubleshooting

### `agy_check` reports incompatible capabilities

Update Antigravity CLI and rerun `agy_check(refresh=true)`. Persistent streaming is an optimization; managed workers retain the one-shot conversation-resume fallback when stream input is unavailable.

### A worker is `recoverable`

This is expected after MCP/Codex restart, cancellation, warm-process loss, or idle cleanup. Send the next correction with `agy_followup(workerId)`; the plugin resumes the exact persisted conversation.

### A worker is leased by another MCP process

Use `agy_status(workerId)` first. Do not work around the lease by manually driving the same conversation from another managed worker. Dead/stale lease owners are reclaimed automatically.

### The model/effort picker cannot be displayed

Pass both `model` and `effort` explicitly in MCP clients that cannot display elicitation forms.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm ci
npm run verify
npm test
```

`npm run verify` performs TypeScript checking, rebuilds `dist/server.cjs`, runs stream parser tests, cancellable CLI tests, persistent-driver tests, worker store/lease tests, and the protocol-only MCP smoke test without using AGY quota.

`npm test` performs a real stdio MCP round trip against the authenticated AGY CLI. It validates warm-process reuse, persisted ledger metadata, status, an actual MCP restart, exact conversation recovery with a new PID, and final close/audit state.

Release builds are validated locally on Windows with an authenticated AGY CLI. GitHub Actions is currently unavailable for this repository/account, so it is not used as the release gate.

The checked-in `dist/server.cjs` is the runtime artifact used by the installed plugin and must be regenerated after source changes.

Security reports and the trust model are documented in [SECURITY.md](SECURITY.md). The [Privacy Policy](PRIVACY.md) and [Terms of Use](TERMS.md) apply to public distribution.

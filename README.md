# Antigravity Subagent for Codex

[![Release](https://img.shields.io/github/v/release/vacnex/codex-antigravity-subagent)](https://github.com/vacnex/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as an external delegated worker from Codex. Codex can start a bounded Antigravity task, let it continue in the background, review workspace changes, send corrections into the same conversation, recover that worker after Codex/MCP restarts, and close it only after review passes.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI. This fork is based on the original project by [IlleJiViN](https://github.com/IlleJiViN/codex-antigravity-subagent).

## What it adds

- `agy_check` verifies the Antigravity CLI, model catalog, required headless flags, and persistent `stream-json` support. Short-lived discovery caches can be bypassed with `refresh=true`.
- `agy_delegate` runs one bounded blocking one-shot Antigravity prompt and honors MCP cancellation.
- `agy_start` starts a named resumable worker. On stream-capable AGY it returns after the conversation handshake and durable registration while the first turn continues in the background.
- `agy_followup` launches a correction on the same worker, reusing the warm AGY process when possible or resuming the exact persisted conversation after restart/process loss.
- `agy_result` reads the current/final state of the latest managed turn without submitting another prompt.
- `agy_status` shows active, recoverable, closed, timeout/cancel/error, progress, and duplicate-worker metadata without reading stored prompts/responses, because the ledger never stores them.
- `agy_cancel` stops the active background turn while preserving the worker conversation for later recovery.
- `agy_close` closes the managed worker while retaining local audit metadata and the Antigravity conversation.
- Stable `idempotencyKey` values make retries of the same plan step/correction reuse existing work instead of spawning duplicate Antigravity conversations.
- `$delegate-to-antigravity` teaches Codex how to delegate one plan step per worker, wait through managed state rather than a long blocking tool call, review, correct, recover, cancel, and close safely.

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
   ├─ choose stable idempotencyKey
   │
   ▼
agy_start(name="Plan 2 - persistence", idempotencyKey="run-X-plan-2")
   │
   ├─ spawn AGY
   ├─ receive stream init + conversationId
   ├─ persist state=running BEFORE the long turn
   └─ return RUNNING quickly
            │
            ▼
      AGY works in background
            │
            ▼
      agy_result(worker A)
            │
            ├── done=false ──► keep same worker; no duplicate start
            │
            └── done=true ───► Codex reviews diff/tests
                                  │
                                  ├── FAIL ─► agy_followup(worker A,
                                  │             idempotencyKey="...fix-1")
                                  │             └─► agy_result ─► review again
                                  │
                                  ├── STOP ─► agy_cancel(worker A)
                                  │
                                  └── PASS ─► agy_close(worker A)
                                                   │
                                                   ▼
                                              next plan step
                                                   │
                                                   ▼
                                              new worker B
```

A new worker asks the user to choose an Antigravity base model and reasoning effort unless both were supplied explicitly. Effort-suffixed model variants are grouped into base-model choices where possible. A retry that matches an existing `idempotencyKey` is resolved before model elicitation, so it does not ask for the choice again.

Use one stable start key per logical plan step. If the tool response is lost or uncertain, retry with the **same** key. Use a new key only for a genuinely new plan step. The same rule applies to each correction turn sent through `agy_followup`.

### Warm persistent workers

When the installed AGY exposes both `--input-format stream-json` and `--output-format stream-json`, managed workers keep one warm AGY process alive between turns:

```text
agy_start
   ↓
spawn AGY once
   ↓
stream init / conversationId
   ↓
persist running worker
   ↓
return to Codex
   │
   └──────────────► turn 1 continues over stdin
                         ↓
                       result
                         │
                         ├─ process remains warm
                         │
agy_followup ────────────┘
   ↓
return after launch
   │
   └──────────────► turn 2 over same stdin/process
```

Only one turn may be active on a worker at a time. `agy_result` does not submit a new turn, so it is safe to use for completion checks. Older AGY versions automatically fall back to the v0.3 one-shot `--conversation <id>` path.

The legacy initial start is still blocking when AGY cannot expose a stream init/conversation ID before the turn completes. The bundled MCP configuration sets `tool_timeout_sec` to 1200 seconds as a safety net for that compatibility path and for explicitly blocking one-shot delegation. Current stream-capable AGY should use the background managed path.

### Retry and duplicate safety

`idempotencyKey` is the primary duplicate guard. A repeated `agy_start` with the same key returns the existing logical worker rather than creating a second Antigravity conversation. A repeated active/completed `agy_followup` with the same correction key reuses that turn/result instead of submitting the correction twice.

When no start key is supplied, the runtime also uses a short compatibility heuristic for a recent open worker with the same friendly name and workspace. This is a safety net, not a replacement for explicit keys.

`agy_status` can expose `duplicateWorkerIds` for older/orphaned records that share a logical identity. This helps identify stale duplicates left by earlier blocking-runtime failures rather than quietly creating yet another worker, because humans apparently needed distributed-systems semantics for “please edit four files.”

### Persistent registry and recovery

Worker metadata is stored outside the plugin installation directory:

```text
$CODEX_HOME/antigravity-subagent/workers
```

or `~/.codex/antigravity-subagent/workers` when `CODEX_HOME` is not set. Override it with `AGY_MCP_STATE_DIR`.

The ledger stores worker/conversation identity, friendly name, idempotency key, workspace, model/effort/mode, lifecycle and active/last-turn timestamps, last transport/PID, timeout/cancel/error state, turn count, and usage metadata. It **does not store prompts, responses, source code, or tool output**.

For persistent streaming, the runtime now registers the conversation and writes `state=running` **before** sending the long prompt. That ordering prevents the old race where Codex could time out, call `agy_status`, briefly see no worker, and accidentally start the same plan step again.

After Codex/MCP restarts, an open worker is loaded as `recoverable`. If its ledger said a turn was running when MCP disappeared, the stale active marker is cleared and recorded as `INTERRUPTED`/recoverable instead of pretending a vanished process is still running. The next `agy_followup` starts a new AGY process with the exact saved `--conversation <id>`.

A cross-process lease prevents two MCP instances from driving the same worker concurrently; stale leases are reclaimed when their owning process is gone or the lease expires.

> [!NOTE]
> v0.3 managed workers existed only in MCP memory, so workers created before upgrading to v0.4 cannot be reconstructed after a restart. Persistent recovery applies to workers created by v0.4 or later.

Warm AGY processes are released after an idle period while the logical worker remains recoverable. Set `AGY_MCP_IDLE_DRIVER_MS` to tune the idle duration (minimum 10 seconds; default 10 minutes).

Closed worker ledger records are intentionally retained for local audit. The plugin does not currently auto-prune them. If you no longer want that history, remove the corresponding worker JSON records while no MCP server instance is using that state directory. Removing a local ledger record does not delete Antigravity's own conversation history.

## Status, result, and cancellation

```text
agy_result(workerId)
agy_status(workerId)
agy_status(includeClosed=true)
agy_cancel(workerId)
```

`agy_result` never sends a prompt. While a managed turn is active it reports `done=false`. When the current MCP process receives the final AGY result it returns `done=true`, the bounded response text, status, and usage metadata.

Final response text is intentionally kept only in MCP memory, not in the persistent worker ledger. After an MCP restart, `agy_result` can still report persisted completion/status/usage metadata but returns `resultAvailable=false`; Codex should inspect the shared workspace directly or use Antigravity's own conversation history for manual audit.

`agy_status` reports lifecycle state, warm/recoverable state, driver PID, lease information, active and last turn keys, last result, timeout/cancel/error flags, compact progress counters, duplicate-worker IDs, turns, and token usage.

`agy_cancel` targets only the active turn; it does not delete the worker or Antigravity conversation. MCP request cancellation can stop work while a stream handshake or blocking one-shot call is still the active MCP request. Once a managed start/follow-up has returned and its long turn is running in the background, use `agy_cancel(workerId)` explicitly.

## Token and context handling

AGY persistent streams report cumulative usage. The plugin preserves that as `sessionUsage` (and the backward-compatible `usage` field) and computes `turnUsage` from the previous persisted usage snapshot.

Stream `step_update` payloads are parsed for observability but only compact counters are returned to Codex. Text deltas, tool payloads, subagent payloads, full diffs, and source content are not copied into the handoff.

Background managed launches also avoid holding a single MCP tool call open for the entire Antigravity task. This removes the failure mode where a long call repeatedly caused Codex to wake up merely to wait on the same tool process. Codex may still choose to check `agy_result`/`agy_status` later, but it no longer needs to keep one 5–15 minute tool invocation alive.

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

Use `agy_delegate` when a task does not need a review/fix loop, for example a second opinion or read-only analysis. It remains blocking by design. The bundled fallback runner remains available when MCP tools are unavailable, but it does not provide the persistent registry, idempotency, leases, status/result/cancel tools, or managed recovery runtime.

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

### `agy_start` returns `running`

That is the expected stream-capable fast path. The worker and `conversationId` have already been registered durably and the long Antigravity turn is continuing in the background. Use `agy_result(workerId)` for completion/result state; do not call a second `agy_start` for the same plan step.

### A worker is `recoverable`

This is expected after MCP/Codex restart, cancellation, warm-process loss, idle cleanup, or an interrupted background turn. Send the next genuine correction with `agy_followup(workerId)`; the plugin resumes the exact persisted conversation.

### `agy_result` says `resultAvailable=false`

The MCP process restarted after the turn completed, so its in-memory final response text is gone by design. Completion/status/usage metadata is still in the ledger, and the Antigravity conversation remains resumable. Inspect the workspace diff/tests as the source of truth.

### A worker is leased by another MCP process

Use `agy_status(workerId)` first. Do not work around the lease by manually driving the same conversation from another managed worker. Dead/stale lease owners are reclaimed automatically.

### `agy_status` reports `duplicateWorkerIds`

This usually indicates older or orphaned work with the same logical plan identity. Do not create another worker merely to escape the ambiguity. Check which conversation/diff is authoritative, then close obsolete workers once they are no longer active.

### The model/effort picker cannot be displayed

Pass both `model` and `effort` explicitly in MCP clients that cannot display elicitation forms.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm ci
npm run verify
npm test
```

`npm run verify` performs TypeScript checking, rebuilds `dist/server.cjs`, runs stream parser tests, cancellable CLI tests, persistent-driver/init-handshake tests, worker store/lease/background-metadata tests, and the protocol-only MCP smoke test without using AGY quota.

`npm test` performs a real stdio MCP round trip against the authenticated AGY CLI. On a stream-capable installation it validates fast background `agy_start`, durable running-state persistence before the long turn, retry deduplication, `agy_result`, warm background follow-up, follow-up deduplication, an actual MCP restart, exact conversation recovery with a new PID, post-restart metadata behavior, and final close/audit state.

Release builds are validated locally on Windows with an authenticated AGY CLI. GitHub Actions is currently unavailable for this repository/account, so it is not used as the release gate.

The checked-in `dist/server.cjs` is the runtime artifact used by the installed plugin and must be regenerated after source changes.

Security reports and the trust model are documented in [SECURITY.md](SECURITY.md). The [Privacy Policy](PRIVACY.md) and [Terms of Use](TERMS.md) apply to public distribution.

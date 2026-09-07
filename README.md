# Antigravity Subagent for Codex

[![Release](https://img.shields.io/github/v/release/vacnex/codex-antigravity-subagent)](https://github.com/vacnex/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as an external delegated worker from Codex. Codex can start a bounded Antigravity task, review workspace changes, send corrections into the same conversation, recover that worker after Codex/MCP restarts, and close it only after the supervising workflow no longer needs corrections.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI. This fork is based on the original project by [IlleJiViN](https://github.com/IlleJiViN/codex-antigravity-subagent).

## What it adds

- `agy_check` verifies the Antigravity CLI, model catalog, required headless flags, and persistent `stream-json` support. Short-lived discovery caches can be bypassed with `refresh=true`.
- `agy_delegate` runs one bounded one-shot Antigravity prompt and honors MCP cancellation.
- `agy_start` starts a named resumable worker and returns both a bridge `workerId` and Antigravity `conversationId` after the stream handshake while the long first turn continues in the background.
- `agy_followup` launches a correction turn on the same worker in the background, reusing the same warm AGY process when possible or resuming the exact persisted conversation after restart/process loss.
- `agy_result` reads an immediate non-blocking current/final snapshot of the latest managed turn without sending another prompt. Final response text is kept only in MCP memory and is never written to the durable ledger.
- `agy_wait` passively waits inside the MCP server for the latest managed turn to finish, without sending prompts or owning/canceling the AGY worker. A wait timeout/cancel returns control while the worker keeps running.
- `agy_status` shows active, recoverable, or closed worker metadata without reading stored prompts/responses (because the ledger never stores them).
- `agy_cancel` stops the active turn while preserving the worker conversation for later recovery.
- `agy_close` closes the managed worker while retaining local audit metadata and the Antigravity conversation.
- `$delegate-to-antigravity` owns one bounded AGY worker's lifecycle, Project/model/effort selection, retry safety, correction turns, recovery, and result semantics.
- `$execute-plan` coordinates an approved READY `PLAN-XX` blueprint: one fresh worker per PLAN, Codex review/correction loops, final whole-blueprint audit, then worker cleanup.

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

Then open Codex, run `/plugins`, choose **Antigravity Subagent**, and install it. Start a new Codex session afterward so the skills and MCP tools are loaded.

Because this plugin declares a local MCP server, imported ChatGPT plugins can be labeled **Desktop only**; this local MCP runtime is not intended for ChatGPT web.

## Managed worker workflow

`delegate-to-antigravity` manages one bounded worker. The caller decides whether a reviewed PASS is final for that worker or whether to keep it open for later integration corrections.

```text
bounded assignment
   │
   ▼
agy_start(name="persistence", idempotencyKey="run:persistence")
   │
   ▼
worker registered as running
   │
   ├─► agy_status(worker A)  ─► lifecycle/progress snapshot
   ├─► agy_result(worker A)  ─► immediate non-blocking snapshot
   └─► agy_wait(worker A)    ─► passive wait until terminal result
                                  │
                                  ▼
                          Codex/caller reviews
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
                 FAIL            STOP            PASS
                  │               │               │
                  ▼               ▼               ▼
        agy_followup(worker A,  agy_cancel     caller decides
        idempotencyKey="...fix")               keep-open/close
                  │
                  └─► agy_wait ─► review again
```

A new worker asks the user to choose an Antigravity base model and reasoning effort unless both were supplied explicitly. Effort-suffixed model variants are grouped into base-model choices where possible.

Use a stable `idempotencyKey` for every logical `agy_start` and correction turn. Retrying the same key reuses the existing worker/turn instead of starting duplicate AGY work. If a caller omits a key, recent same-name + same-workspace starts are also reused as a compatibility safety net.

For approved sequential multi-step execution, use `$execute-plan`. It uses `agy_wait` as the completion barrier, reviews each PLAN independently, keeps passed PLAN workers available for final integration corrections, and closes them after the whole blueprint passes. A worker that is still `RUNNING`, or an `agy_wait` that returns `done=false` because its passive wait interval ended, is not a reason to skip the current PLAN or return a final status summary.

### Warm persistent workers

When the installed AGY exposes both `--input-format stream-json` and `--output-format stream-json`, managed workers keep one warm AGY process alive between turns. `agy_start` waits only for the stream `init` event so the bridge can durably register `conversationId` and `state=running`; it then sends the prompt and returns immediately while AGY continues in the background.

```text
agy_start
   ↓
spawn AGY once
   ↓
receive init / conversationId
   ↓
persist state=running
   ↓
return workerId to Codex
   ↓
turn 1 continues over stdin
   ↓
agy_wait blocks only the passive waiter
   ↓
result stored in MCP memory + ledger metadata
   │
   ├─ process remains warm
   │
agy_followup
   ↓
register background correction turn
   ↓
turn 2 over same stdin/process
```

Only one turn may be active on a worker at a time. Older AGY versions automatically fall back to the v0.3 one-shot `--conversation <id>` path; that legacy compatibility path cannot expose a conversation ID before the one-shot command finishes, so it remains blocking.

### Persistent registry and recovery

Worker metadata is stored outside the plugin installation directory:

```text
$CODEX_HOME/antigravity-subagent/workers
```

or `~/.codex/antigravity-subagent/workers` when `CODEX_HOME` is not set. Override it with `AGY_MCP_STATE_DIR`.

The ledger stores worker/conversation identity, friendly name, optional idempotency key, workspace, model/effort/mode, timestamps, lifecycle/active-turn metadata, last transport/PID, turn count, timeout/cancel/error flags, and usage metadata. It **does not store prompts, responses, source code, or tool output**.

The persistent-stream start path writes `conversationId`, `state=running`, and active-turn metadata before sending the long prompt. Therefore `agy_status` can identify a worker immediately even if a caller loses the `agy_start` response.

After Codex/MCP restarts, an open worker is loaded as `recoverable`. A persisted `running` turn with no live owner is marked `INTERRUPTED` rather than left as a ghost running task. The next `agy_followup` starts a new AGY process with the exact saved `--conversation <id>`. A cross-process lease prevents two MCP instances from driving the same worker concurrently; stale leases are reclaimed when their owning process is gone or the lease expires.

> [!NOTE]
> v0.3 managed workers existed only in MCP memory, so workers created before upgrading to v0.4 cannot be reconstructed after a restart. Persistent recovery applies to workers created by v0.4 or later.

Warm AGY processes are released after an idle period while the logical worker remains recoverable. Set `AGY_MCP_IDLE_DRIVER_MS` to tune the idle duration (minimum 10 seconds; default 10 minutes).

Closed worker ledger records are intentionally retained for local audit. The plugin does not currently auto-prune them. If you no longer want that history, remove the corresponding worker JSON records while no MCP server instance is using that state directory. Removing a local ledger record does not delete Antigravity's own conversation history.

## Status, result, wait, and cancellation

```text
agy_status(workerId)
agy_status(includeClosed=true)
agy_result(workerId)
agy_wait(workerId, timeoutSeconds=900)
agy_cancel(workerId)
```

`agy_status` reports lifecycle state, warm/recoverable state, driver PID, lease information, active/last turn keys, timeout/cancel/error state, turn count, compact progress, duplicate-worker metadata, and token usage.

`agy_result` never submits a prompt and never waits. While a turn is active it explicitly reports that the existing worker is still running; after completion it returns the final AGY response when that response is still available in the current MCP process. Final response text is intentionally memory-only. After an MCP restart, `agy_result` can still report durable completion/status/usage/error metadata, but cannot reconstruct the previous response text because the ledger never stores it.

`agy_wait` never submits a prompt. It performs the waiting loop inside the MCP server so Codex does not need repeated model-driven `sleep`/`agy_result` polling. The wait does not own the worker: if the passive wait reaches its timeout, or the MCP client cancels only the wait call, the AGY turn continues in the background and can be awaited again. `waitTimedOut` and `waitCanceled` describe the waiter; they are distinct from the worker's own `lastTimedOut` / `lastCanceled` metadata.

`agy_cancel` targets only the active background turn; it does not delete the worker or Antigravity conversation. For a background turn, cancellation is explicit through `agy_cancel`; the original `agy_start`/`agy_followup` MCP request has already returned by then. Canceling `agy_wait` does not implicitly cancel AGY.

The bundled Codex MCP declaration sets `tool_timeout_sec` to 1200 seconds for compatibility with legacy blocking AGY paths and explicit one-shot delegation. `agy_wait` is capped below that client deadline so it can return a clean continuation state. Persistent managed starts/follow-ups normally return long before the timeout.

## Token and context handling

AGY persistent streams report cumulative usage. The plugin preserves that as `sessionUsage` (and the backward-compatible `usage` field) and computes `turnUsage` from the previous persisted usage snapshot.

Stream `step_update` payloads are parsed for observability but only compact counters are returned to Codex. Text deltas, tool payloads, subagent payloads, full diffs, and source content are not copied into the handoff.

Using `agy_wait` as the completion barrier avoids repeatedly waking the Codex model just to poll a still-running worker. The MCP server performs the small internal status loop while the model remains blocked on one tool call.

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

Do not attach `/resume` to a conversation that the managed bridge is currently driving; Antigravity may interrupt the active session. Use `agy_status`/`agy_result`/`agy_wait` for passive inspection or completion while work is active.

This is an audit trail of persisted worker metadata plus visible Antigravity conversation/tool activity, not hidden chain-of-thought.

## One-shot delegation

Use `agy_delegate` when a task does not need a review/fix loop, for example a second opinion or read-only analysis. The bundled fallback runner remains available when MCP tools are unavailable, but it does not provide the persistent registry, background-turn API, idempotency/dedupe, leases, status/result/wait/cancel tools, or managed recovery runtime.

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

This is expected after MCP/Codex restart, cancellation, warm-process loss, idle cleanup, or interruption of a running turn. Send the next correction with `agy_followup(workerId)`; the plugin resumes the exact persisted conversation.

### A worker is leased by another MCP process

Use `agy_status(workerId)` first. Do not work around the lease by manually driving the same conversation from another managed worker. Dead/stale lease owners are reclaimed automatically.

### A start/follow-up response was lost or the caller is unsure whether it launched

Retry with the **same `idempotencyKey`**. The bridge reuses the existing logical worker/turn instead of creating duplicate AGY work. For starts without an explicit key, a recent same-name + same-workspace worker is reused as a compatibility fallback.

### `agy_wait` returns `done=false`

This means only that the passive wait interval ended before the AGY turn finished. The worker was not canceled. If the caller still requires this worker's result, call `agy_wait` again on the same `workerId`. In `$execute-plan`, do not start the next PLAN and do not treat this as a genuine blocker.

### `agy_result` has no final response text after restart

This is expected. Final response text is never persisted. After restart, use `agy_status` / `agy_result` for durable completion/error/usage metadata and inspect the workspace diff/tests directly. Send `agy_followup` only when a new correction is actually needed.

### The model/effort picker cannot be displayed

Pass both `model` and `effort` explicitly in MCP clients that cannot display elicitation forms.

### MCP fails to start when Node is managed by mise/asdf/another version manager

The plugin declaration launches the server with `command: "node"`. Codex may not inherit shell initialization performed by a Node version manager. Verify what your interactive shell resolves:

```powershell
where.exe node
node --version
mise which node
```

If `node` is available only through shell initialization or a version-manager shim that Codex cannot resolve, make Node directly reachable from the environment used to launch Codex or configure the MCP command to a concrete Node executable path.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm ci
npm run verify
npm test
```

`npm run verify` performs TypeScript checking, rebuilds `dist/server.cjs`, runs stream parser tests, cancellable CLI tests, persistent-driver tests, worker store/lease tests, and the protocol-only MCP smoke test without using AGY quota.

`npm test` performs a real stdio MCP round trip against the authenticated AGY CLI. It validates background start registration, durable running state, retry dedupe, passive `agy_wait` completion, `agy_result`, warm background follow-up, an actual MCP restart, exact conversation recovery with a new PID, and final close/audit state.

Release builds are validated locally on Windows with an authenticated AGY CLI. GitHub Actions is currently unavailable for this repository/account, so it is not used as the release gate.

The checked-in `dist/server.cjs` is the runtime artifact used by the installed plugin and must be regenerated after source changes.

Security reports and the trust model are documented in [SECURITY.md](SECURITY.md). The [Privacy Policy](PRIVACY.md) and [Terms of Use](TERMS.md) apply to public distribution.
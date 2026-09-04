---
name: delegate-to-antigravity
description: Delegate a bounded coding, research, review, debugging, or implementation task to the local Google Antigravity CLI (`agy`) and use its response as a second-agent result. Use when the user explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity, or asks Codex to offload an independent task to `agy`.
---

# Delegate to Antigravity

Treat Antigravity as an external delegated worker. It is not a native Codex collaboration agent: collect its result, verify it, and remain responsible for the final answer and workspace changes.

## Managed worker workflow

Prefer managed workers for implementation or any task likely to need review corrections:

1. Establish availability with `agy_check` and require a compatible Antigravity CLI capability report before managed work.
2. Before each new plan step, choose a stable `idempotencyKey` for that logical step and reuse the exact same key if the `agy_start` request/result is retried or uncertain. A practical key can combine the current task/run identifier with the plan-step identifier. Do not generate a different retry key merely because the previous tool response was lost.
3. Start the bounded plan step with `agy_start`, passing the stable `idempotencyKey` plus a short friendly `name`, for example `Plan 2 - persistence layer`.
4. Unless both values were supplied explicitly, let the MCP client ask the user to choose the Antigravity base model and reasoning effort. Do not silently invent either choice. A retry matched by `idempotencyKey` is resolved before model elicitation, so it must not ask again.
5. On a persistent-stream capable AGY, `agy_start` returns after the stream handshake and durable worker registration, while the first Antigravity turn continues in the background. Treat `state=running` / `done=false` as an accepted launch, not as a completed task. Keep the returned `workerId` and `conversationId`.
6. Use `agy_result(workerId)` to read the latest turn state. If `done=false`, do not start another worker and do not send a follow-up. `agy_status(workerId)` may be used for lifecycle/progress metadata. Avoid repeated shell/cell wait loops whose only purpose is to keep Codex awake while AGY is running; do useful independent work or check the managed result again when appropriate.
7. When `agy_result` reports `done=true`, inspect the shared workspace diff and run relevant tests independently. The delegated response is advisory; the workspace and Codex review are the source of truth.
8. If review fails, choose a stable correction `idempotencyKey` for that specific correction turn and call `agy_followup` with the same `workerId`. Persistent follow-ups also launch in the background. Use `agy_result` for completion, review again, and repeat with a new correction key only when a genuinely new correction turn is needed. If a follow-up tool response is lost, retry with the same correction key.
9. Use `agy_status` when worker state is uncertain, especially after a Codex/MCP restart. A persisted open worker may be `recoverable`; `agy_followup` resumes its exact `conversationId`. A turn that was active when MCP died is recovered as interrupted/recoverable rather than being reported as a ghost running turn.
10. If the current turn is no longer useful, call `agy_cancel(workerId)`. Cancellation targets the active background turn and keeps the conversation recoverable. Once a background launch has returned, explicit `agy_cancel` is the cancellation mechanism; there is no longer an active MCP request whose cancellation can control that turn.
11. Call `agy_close` only after the worker passes review. Closing marks the worker closed in the local ledger; it does not delete the Antigravity conversation or its audit history.
12. For a distinct plan step, start a new worker with a new logical idempotency key rather than reusing the previous worker's context.

For sequential multi-step plans, use one Antigravity worker per plan step. Finish the result/review/fix loop for the current step before starting the next one unless the user explicitly requests parallel work.

## Retry and duplicate safety

`idempotencyKey` is the primary duplicate guard. Repeating `agy_start` with the same key returns the existing logical worker instead of spawning another Antigravity conversation. Repeating an active/completed `agy_followup` with the same correction key reuses that turn/result rather than submitting the prompt twice.

As a compatibility safety net, `agy_start` also detects a recent open worker with the same friendly name and workspace when no key was supplied. Do not rely on that heuristic in planned workflows; pass the explicit key.

`agy_status` may expose `duplicateWorkerIds` for older/orphaned ledger entries that share a logical identity. Do not silently create a third worker to work around such a state. Review the existing workers and close obsolete ones only after confirming they are no longer active/useful.

## Persistence and recovery

Managed workers persist metadata outside the plugin installation directory, under `$CODEX_HOME/antigravity-subagent/workers` by default. `AGY_MCP_STATE_DIR` can override the location. The ledger stores worker identity, conversation ID, friendly name, idempotency key, workspace, model/effort/mode, lifecycle/turn timestamps, transport details, timeout/cancel/error state, and usage metadata. It must not store prompts, responses, source code, or tool output.

A warm worker uses Antigravity persistent `stream-json` input/output when the installed CLI supports it. The MCP layer waits only for the initial stream handshake, persists `conversationId` plus `state=running`, and then starts the long turn. This ordering ensures `agy_status` can find the worker immediately even if a later client/tool timeout or connection failure occurs.

Successful background turn responses are kept only in the current MCP process memory so `agy_result` can return them without bloating the durable ledger. If Codex/MCP restarts after a turn has completed, the response text is intentionally unavailable from the plugin ledger; `agy_result` returns persisted completion/status/usage metadata with `resultAvailable=false`, and Codex should inspect the workspace directly. Antigravity's own conversation remains available for manual audit.

If Codex/MCP restarts or a warm process is lost, the worker becomes recoverable. The next follow-up starts a new AGY process with the exact persisted `--conversation <id>`. If MCP restarts while a turn is marked running, recovery clears the stale active-turn marker and records it as interrupted/recoverable instead of pretending that a vanished process is still working.

A cross-process worker lease prevents two MCP instances from driving the same worker concurrently. Do not work around a lease conflict by starting another follow-up against the same conversation. Use `agy_status` to inspect the worker instead.

Idle warm processes may be released automatically while the logical worker remains recoverable. This is normal and does not close the worker.

## Status, result, and cancellation

`agy_status` with a `workerId` returns lifecycle information for one worker. Without a worker ID it lists open workers; `includeClosed=true` also includes ledger history. Status metadata may include whether the worker is warm, the active driver PID, lease state, active/last turn keys, last result status, timeout/cancel/error flags, turn count, usage, compact progress counters, and duplicate-worker IDs.

`agy_result(workerId)` never sends a prompt. During an active turn it returns `done=false`. Once the current MCP process receives the final AGY result it returns `done=true`, the bounded final response, and structured usage/status metadata. After an MCP restart it can still report persisted completion metadata, but final response text is not reconstructed from the ledger.

`agy_cancel` targets only an active turn. After cancellation the worker remains available for a later `agy_followup`. MCP request cancellation is still honored while a start/follow-up stream handshake or a blocking one-shot call is itself in progress; after a background managed call has returned, use `agy_cancel` explicitly.

## One-shot delegation

Use `agy_delegate` for bounded research, second opinions, or work that does not need a follow-up session. It remains a blocking one-shot compatibility tool and honors MCP request cancellation.

Older AGY versions without persistent stream input retain the legacy one-shot initial-start path. That compatibility start cannot know its `conversationId` before AGY finishes, so it remains blocking. The plugin's Codex MCP configuration raises the tool timeout for this legacy path; current stream-capable AGY should use the non-blocking managed path instead.

## Model and effort selection

For a new delegation or managed worker, `model` and `effort` are optional MCP arguments. When either is omitted, the MCP server requests the missing values from the user through MCP elicitation.

Available models are discovered from the authenticated Antigravity installation. The MCP server tolerates current and older model-catalog command layouts, groups effort-suffixed CLI variants into base-model choices where possible, and resolves the selected effort back to the exact CLI slug. If a model family does not expose the selected effort, return a clear error instead of silently substituting another model or effort.

If the MCP client cannot display elicitation, pass both values explicitly. Valid effort values are `low`, `medium`, and `high`.

Do not ask for model or effort again on `agy_followup`; the existing worker keeps its original selection.

## Managed result handling

Managed start/follow-up acknowledgements are intentionally compact. Preserve `workerId`, `conversationId`, state, transport, and the logical idempotency key. Do not mistake an acknowledgement for the final worker response.

Final managed results preserve useful metadata such as status, lifecycle state, duration, number of turns, transport, timeout/cancel flags, and token usage, but do not dump Antigravity progress diagnostics into Codex context on successful runs.

Persistent stream results report cumulative session usage. The MCP layer also computes `turnUsage` as the delta from the previous persisted usage snapshot and preserves cumulative values as `sessionUsage` (and the backward-compatible `usage` field).

Stream step updates are summarized as counts for observability rather than copying text deltas, tool payloads, or subagent output into Codex context. Codex can inspect the shared workspace and diff directly, so the handoff should remain concise.

CLI discovery, capability probes, and model catalogs use short-lived caches. `agy_check` accepts `refresh=true` when a fresh capability/model probe is explicitly needed.

## Auditing Antigravity sessions

Managed workers retain the returned Antigravity conversation ID. After delegation, the user can inspect the same Antigravity conversation manually from the workspace with interactive `agy` and `/resume`, or resume a known conversation directly with `agy --conversation <conversation-id>`.

The local friendly worker name is guaranteed in the plugin ledger. Antigravity may generate its own native conversation title; do not attempt unsupported headless slash-command hacks merely to force that title to match the ledger name.

Treat the persisted worker metadata and AGY conversation as an audit trail of visible conversation/tool activity. Do not describe either as access to hidden model chain-of-thought.

## Bundled runner

When MCP tools are unavailable, use the bundled `scripts/agy-delegate.mjs` runner. It requires Node.js 20 or newer and a locally installed, authenticated `agy` CLI.

Write the complete prompt to a temporary UTF-8 file and pass its absolute path to the runner. Do not interpolate an untrusted prompt into shell syntax.

```text
node <skill-dir>/scripts/agy-delegate.mjs --cwd <absolute-workspace> --mode plan --prompt-file <absolute-prompt-file> --model <model> --effort <low|medium|high>
```

To resume a known Antigravity conversation through the fallback runner, add `--conversation <conversation-id>`.

The runner accepts `--output-format text|json`, `--timeout-seconds 1..1800`, `--agent`, `--model`, `--effort`, and `--conversation`. It avoids passing a duplicate `--effort` flag when the chosen model slug already pins the effort. The fallback runner does not provide the managed worker registry, idempotency, leases, status/result/cancel tools, or MCP picker.

Delete the temporary prompt file after the runner finishes. Do not add or emulate dangerous permission-bypass flags.

If neither the MCP tools nor local process execution is available, explain that this plugin requires a local Codex environment with Node.js and an authenticated `agy` installation.

## Safety

- Never weaken the user's persisted sandbox or permission policy.
- Do not delegate secrets, credentials, private data, destructive operations, releases, deployments, purchases, or external messages without explicit authorization for that scope.
- Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication or interactive approval is required, return control to the user rather than bypassing it.
- Use a finite `timeoutSeconds`; split oversized work into bounded tasks.
- Keep the Antigravity conversation ID available for audit, but do not expose it outside the user's local workflow unless requested.

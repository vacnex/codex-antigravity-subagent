---
name: delegate-to-antigravity
description: Delegate a bounded coding, research, review, debugging, or implementation task to the local Google Antigravity CLI (`agy`) and use its response as a second-agent result. Use when the user explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity, or asks Codex to offload an independent task to `agy`.
---

# Delegate to Antigravity

Treat Antigravity as an external delegated worker. It is not a native Codex collaboration agent: collect its output, verify it, and remain responsible for the final answer and workspace changes.

## Managed worker workflow

Prefer managed workers for implementation or any task likely to need review corrections:

1. Establish availability with `agy_check` and require a compatible Antigravity CLI capability report before managed work.
2. Start each bounded plan step with `agy_start`. Pass a short friendly `name` that identifies the plan step, for example `Plan 2 - persistence layer`.
3. Unless both values were supplied explicitly, let the MCP client ask the user to choose the Antigravity base model and reasoning effort. Do not silently invent either choice.
4. Keep the returned `workerId` and `conversationId`. The worker is persisted locally and the Antigravity conversation remains available for manual inspection and resume.
5. Inspect the workspace diff and run relevant tests independently.
6. If review fails, call `agy_followup` with the same `workerId` and concrete correction instructions. Repeat review and follow-up until the work passes.
7. Use `agy_status` when the current worker state is uncertain, especially after a Codex/MCP restart. A persisted open worker may be reported as `recoverable`; `agy_followup` will resume its exact `conversationId`.
8. If the user cancels the current work or a turn is no longer useful, use `agy_cancel`. Cancellation stops the active turn but keeps the conversation recoverable. Do not treat cancellation as worker deletion.
9. Call `agy_close` only after the worker passes review. Closing marks the worker closed in the local ledger; it does not delete the Antigravity conversation or its audit history.
10. For a distinct plan step, start a new worker rather than reusing the previous worker's context.

For sequential multi-step plans, use one Antigravity worker per plan step. Finish the review/fix loop for the current step before starting the next one unless the user explicitly requests parallel work.

## Persistence and recovery

Managed workers persist metadata outside the plugin installation directory, under `$CODEX_HOME/antigravity-subagent/workers` by default. `AGY_MCP_STATE_DIR` can override the location. The ledger stores worker identity, conversation ID, friendly name, workspace, model/effort/mode, lifecycle timestamps, transport details, and usage metadata. It must not store prompts, responses, source code, or tool output.

A warm worker uses Antigravity persistent `stream-json` input/output when the installed CLI supports it. Multiple successful follow-ups reuse the same AGY process. If Codex/MCP restarts or the warm process is lost, the worker becomes recoverable; the next follow-up starts a new AGY process with the exact persisted `--conversation <id>`.

A cross-process worker lease prevents two MCP instances from driving the same worker concurrently. Do not work around a lease conflict by starting another follow-up against the same conversation. Use `agy_status` to inspect the worker instead.

Idle warm processes may be released automatically while the logical worker remains recoverable. This is normal and does not close the worker.

## Status and cancellation

`agy_status` with a `workerId` returns lifecycle information for one worker. Without a worker ID it lists open workers; `includeClosed=true` also includes ledger history. Status metadata may include whether the worker is warm, the active driver PID, lease state, last result status, turn count, and session/turn usage.

`agy_cancel` targets only an active turn. After cancellation the worker should remain available for a later `agy_followup`. MCP request cancellation is also propagated to the underlying AGY invocation; user Stop actions must not be ignored or converted into worker closure.

## One-shot delegation

Use `agy_delegate` for bounded research, second opinions, or work that does not need a follow-up session. It remains a one-shot compatibility tool and honors MCP request cancellation.

## Model and effort selection

For a new delegation or managed worker, `model` and `effort` are optional MCP arguments. When either is omitted, the MCP server requests the missing values from the user through MCP elicitation.

Available models are discovered from the authenticated Antigravity installation. The MCP server tolerates current and older model-catalog command layouts, groups effort-suffixed CLI variants into base-model choices where possible, and resolves the selected effort back to the exact CLI slug. If a model family does not expose the selected effort, return a clear error instead of silently substituting another model or effort.

If the MCP client cannot display elicitation, pass both values explicitly. Valid effort values are `low`, `medium`, and `high`.

Do not ask for model or effort again on `agy_followup`; the existing worker keeps its original selection.

## Managed result handling

Managed workers return a compact response plus structured metadata. Preserve useful metadata such as status, lifecycle state, duration, number of turns, transport, and token usage, but do not dump Antigravity progress diagnostics into Codex context on successful runs.

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

The runner accepts `--output-format text|json`, `--timeout-seconds 1..1800`, `--agent`, `--model`, `--effort`, and `--conversation`. It avoids passing a duplicate `--effort` flag when the chosen model slug already pins the effort. The fallback runner does not provide the managed worker registry, leases, status/cancel tools, or MCP picker.

Delete the temporary prompt file after the runner finishes. Do not add or emulate dangerous permission-bypass flags.

If neither the MCP tools nor local process execution is available, explain that this plugin requires a local Codex environment with Node.js and an authenticated `agy` installation.

## Safety

- Never weaken the user's persisted sandbox or permission policy.
- Do not delegate secrets, credentials, private data, destructive operations, releases, deployments, purchases, or external messages without explicit authorization for that scope.
- Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication or interactive approval is required, return control to the user rather than bypassing it.
- Use a finite `timeoutSeconds`; split oversized work into bounded tasks.
- Keep the Antigravity conversation ID available for audit, but do not expose it outside the user's local workflow unless requested.

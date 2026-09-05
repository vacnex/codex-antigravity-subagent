---
name: delegate-to-antigravity
description: Delegate a bounded coding, research, review, debugging, or implementation task to the local Google Antigravity CLI (`agy`) and use its response as a second-agent result. Use when the user explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity, or asks Codex to offload an independent task to `agy`.
---

# Delegate to Antigravity

Treat Antigravity as an external delegated worker. It is not a native Codex collaboration agent: collect its result, verify it independently, and remain responsible for the final answer and workspace changes.

## Managed worker workflow

Prefer managed workers for implementation or any task likely to need review corrections:

1. Establish availability with `agy_check` and require a compatible Antigravity CLI capability report before managed work.
2. Before each new plan step, choose a stable `idempotencyKey` for that logical step and reuse the exact same key if the `agy_start` request/result is retried or uncertain. Do not generate a different retry key merely because a previous tool response was lost.
3. Before delegation, Codex resolves the applicable project/user instructions for the current checkout, including relevant `AGENTS.md` or equivalent project guidance, and distills only the task-relevant constraints into the delegated prompt. Do not make AGY rediscover the full instruction hierarchy by default.
4. For the first plan step in a blueprint, call `agy_start` with the real absolute checkout `cwd`. If `projectId`, `model`, or `effort` is unresolved, let the MCP setup flow obtain only the missing values. Do not silently invent a Project, model, or effort selection.
5. The MCP project resolver maps `cwd` to Antigravity Projects. Zero matches creates a new AGY Project for the workspace; one most-specific match is selected automatically; equally specific overlapping Projects require user selection. Never work around an ambiguous Project by guessing.
6. Preserve the returned `agyProjectId`. For every later **new worker** in the same blueprint/workspace, pass that exact `projectId` to `agy_start`. This pins all plan steps to the same multi-root Antigravity Project. If a newly created Project has not exposed its ID yet, let the next start resolve the now-existing Project rather than inventing an ID.
7. Do not pass or re-select a Project on `agy_followup`. Resuming the existing `conversationId` inherits the conversation's Antigravity Project.
8. On a persistent-stream capable AGY, `agy_start` returns after the stream handshake, workspace attestation, and durable worker registration while the first turn continues in the background. Treat `state=running` / `done=false` as an accepted launch, not as a completed task. Keep the returned `workerId` and `conversationId`.
9. Call `agy_wait(workerId)` as the normal completion barrier. It sends no prompt and does not own or cancel the worker. If it returns `done=false` because the passive wait interval elapsed, call `agy_wait` again rather than ending the task or starting another worker.
10. When `agy_wait` or `agy_result` reports `done=true`, inspect the shared workspace diff and run the required validation independently. The delegated response is advisory; the workspace and Codex review are the implementation source of truth.
11. A terminal AGY `agyStatus=ERROR` is **not automatically an implementation failure**. Inspect `transportStatus`, `failureKind`, the workspace diff, and validation results first. In particular, `failureKind=agy_response_timeout` means AGY returned a terminal response-timeout condition; it does not prove the code is wrong.
12. If the independent review PASSes despite an AGY terminal error, do **not** submit a no-op correction merely to make the AGY report say SUCCESS. Close the worker and proceed. If the independent review FAILs, choose a stable correction `idempotencyKey`, call `agy_followup` with the same worker, wait, and review again.
13. Use `agy_status` when worker state is uncertain, especially after a Codex/MCP restart. A persisted open worker may be `recoverable`; `agy_followup` resumes its exact `conversationId`.
14. Use `agy_cancel(workerId)` only when the active turn is no longer useful. Canceling an `agy_wait` call must never be treated as permission to cancel the AGY worker.
15. Call `agy_close` only after Codex review PASSes. Closing retains local metadata and Antigravity conversation history.
16. For a distinct plan step, start a fresh worker with a new logical idempotency key. Do not reuse the previous plan step's conversation as implementation context.

For sequential multi-step plans, use one Antigravity worker per plan step. Finish the wait/result/review/fix/close loop for the current step before starting the next unless the user explicitly requests parallel work.

## Antigravity Project contract

Antigravity Projects define the readable workspace context and may contain multiple roots. `cwd` identifies the checkout currently being worked on; it does not by itself define the whole AGY Project.

Project resolution follows these rules:

- If an explicit `projectId` is supplied, it must exist and contain `cwd`. Otherwise fail rather than changing the Project.
- If no Project contains `cwd`, start AGY with a new Project rooted at that workspace.
- If one Project is the unique most-specific ancestor/equal root for `cwd`, select it automatically.
- If multiple Projects are equally valid, require user selection. This includes the case where two Projects both contain the same exact workspace but have different additional roots.
- Once a blueprint's first worker returns an `agyProjectId`, reuse it for later new workers in that blueprint.
- Never silently add an unrelated path to an existing Project.
- Follow-ups inherit their Project from the existing AGY conversation and must not ask again.

A persistent AGY worker must attest its stream `init.cwd` before the prompt is sent. If AGY reports a workspace different from the requested `cwd`, treat `WORKSPACE_MISMATCH`/the launch error as a hard blocker for that worker. Do not ask AGY to search parent directories, other drives, scratch directories, or duplicate clones to find the repository.

Project roots are **read/search scope**, not write permission. The delegated prompt's Owned Paths remain the write scope.

## Rule ownership and bounded research

Codex is the repository-level orchestrator. AGY is the bounded executor for one already-scoped task.

Before starting a worker, Codex should read and resolve the instruction sources that govern the target checkout or module, then pass the relevant constraints explicitly as `PROJECT CONSTRAINTS`. This includes applicable repository/module `AGENTS.md` files, user/project build rules, and task-specific conventions. Do not copy unrelated global guidance into every worker prompt.

AGY still needs enough local context to implement correctly. It should read the Owned Paths and supplied Read-only Context, and it may inspect additional adjacent files when needed to resolve a **concrete implementation uncertainty**. It should not broadly rediscover requirements, coding conventions, build strategy, repository location, or architecture that Codex has already resolved and supplied.

A good first pass is preferable to “code blindly and let Codex fix it.” Codex review is the independent safety net, not a substitute for AGY reading the directly relevant code.

## Delegated execution contract

Every implementation prompt sent to a plan worker should make the execution boundaries explicit. Include the following information when it is available:

```text
EXPECTED WORKSPACE
<absolute cwd>

ANTIGRAVITY PROJECT
<project id/name and roots when known>

ROLE
You are the bounded implementation worker for this single task.
Codex has already performed repository-level planning and will independently
review the resulting workspace diff afterward.

OWNED PATHS
<paths this plan may modify>

READ-ONLY CONTEXT
<direct dependencies or supporting paths that should be inspected>

PROJECT CONSTRAINTS
<only task-relevant rules already resolved by Codex from project/user instructions>

TASK
<the exact bounded implementation task and acceptance criteria>

CANONICAL VALIDATION
<the single project-appropriate validation/build/test command resolved by Codex, if required>

EXECUTION RULES
- Read Owned Paths and supplied Read-only Context before editing.
- Inspect additional adjacent files only when needed to resolve a concrete implementation uncertainty.
- Do not broadly rediscover requirements or conventions already supplied in this task.
- Do not search parent trees or drives to locate the repository.
- Do not modify outside Owned Paths.
- Project roots are read/search scope only; they do not expand write scope.
- Prefer targeted edits to existing files. Use the smallest edit that satisfies the task.
- Do not regenerate or replace an entire existing file when localized edits are sufficient.
- Preserve the target file's existing encoding, BOM state, and line endings. Do not run encoding experiments, conversions, or generic BOM normalization unless the task/project constraints explicitly require them or an actual encoding problem is detected.
- If Vietnamese text appears corrupted or mojibake is detected, stop rather than guessing an encoding/transcoding fix.
- When run_command is already executing PowerShell on Windows, run PowerShell expressions directly; do not wrap them in nested `powershell -Command` / `powershell -NoProfile -Command` invocations.
- Run only CANONICAL VALIDATION when one is supplied. Do not probe for alternate build tools, restore strategies, or build variants unless the task itself is build/toolchain diagnosis.
- If CANONICAL VALIDATION fails only because of an out-of-scope problem, report that fact and stop instead of chasing it.
- Do not investigate or repair unrelated failures outside this plan's scope.
- Once the Owned Paths satisfy acceptance criteria and canonical validation passes, stop investigating and emit FINAL_STATUS immediately.
```

For narrow DTO/view/config/documentation work, keep investigation narrow. Do not run multiple whole-solution build variants merely to obtain a cleaner report unless the task itself concerns the build/toolchain.

Machine-specific validation paths or commands belong in Codex/user/project rules, not in this plugin skill. Codex resolves the applicable command and supplies it under `CANONICAL VALIDATION`.

## Correction-turn edit strategy

Correction turns should be materially narrower than initial implementation turns.

When Codex review reports specific findings:

- Patch only the reported findings unless resolving them strictly requires a broader change.
- Re-read only the affected region plus the minimum surrounding context needed to edit safely.
- Prefer localized replace/edit operations over full-file regeneration.
- Do not re-run repository discovery, architecture research, or unrelated validation.
- Preserve unrelated user/workspace changes exactly as they are.
- Re-run the supplied canonical validation only when the correction can affect it or Codex explicitly requests it.
- Return `FINAL_STATUS` as soon as the findings are resolved and required validation passes.

Full-file replacement is appropriate for a new file, or when the requested change genuinely affects most of an existing file. It is not the default correction mechanism.

## Sequential completion contract

When the user asked to execute a finite multi-step plan, do not produce the final user response while any requested plan step is incomplete or while the current plan step still has a running worker turn.

A `RUNNING` worker is not a blocker. An `agy_wait` interval ending with `done=false` is not a blocker. Continue with another passive `agy_wait` call unless the user explicitly stops the work or a genuine external condition requires user input.

For each requested plan step:

1. `agy_start` with a stable step key and the blueprint's pinned `projectId` when known.
2. `agy_wait` until the turn reaches a terminal result.
3. Independently review the diff and run the required canonical validation.
4. Judge PASS/FAIL from that independent review, not solely from `agyStatus`.
5. On review FAIL, `agy_followup` with a stable correction key containing only concrete review findings, then `agy_wait` and review again.
6. Repeat until PASS or a genuine BLOCKED condition requires user action.
7. `agy_close` after PASS.
8. Move to the next requested plan step.

Only finish the user-facing turn after all requested plan steps have either PASSed or reached a genuine BLOCKED condition that cannot be resolved without user input. Do not substitute a progress/status summary for completion merely because a worker is still running.

Do not orchestrate long AGY work with repeated shell sleeps, terminal wait commands, or frequent `agy_result` polling. Use `agy_wait` so the MCP server waits internally without repeatedly waking the Codex model.

## Terminal result semantics

Managed results distinguish transport/lifecycle from the AGY agent's terminal report:

- `transportStatus=running`: the managed turn is still active.
- `transportStatus=ok`: the MCP runtime successfully received a terminal AGY envelope, even if `agyStatus=ERROR`.
- `transportStatus=timeout|canceled|crashed|protocol_error`: the transport/lifecycle itself failed or was interrupted.
- `agyStatus=SUCCESS|ERROR|...`: the status reported by AGY in a valid terminal envelope.
- `failureKind=agy_response_timeout`: AGY ended with a response timeout such as `timeout waiting for response`; audit the workspace before deciding whether correction is needed.
- `failureKind=agy_error`: AGY reported another terminal error; still audit the workspace.
- `failureKind=transport_timeout|process_exit|canceled|protocol_error`: treat the runtime condition separately from implementation correctness.

Do not convert `agyStatus=ERROR` directly into “the code failed.” A PLAN-03-style case may have valid edits and a successful build before AGY fails to produce its final narrative report. If Codex audit PASSes, close and continue without a correction turn.

## Retry and duplicate safety

`idempotencyKey` is the primary duplicate guard. Repeating `agy_start` with the same key returns the existing logical worker instead of spawning another conversation. This duplicate lookup occurs before Project/model/effort setup, so a lost start result must be retried with the same key rather than re-running setup with a new key.

Repeating an active/completed `agy_followup` with the same correction key reuses that turn/result rather than submitting the prompt twice. As a compatibility safety net, `agy_start` also detects a recent open worker with the same friendly name and workspace when no key was supplied; planned workflows should still pass explicit keys.

`agy_status` may expose `duplicateWorkerIds` for older/orphaned ledger entries. Do not silently create another worker to work around such a state.

## Persistence and recovery

Managed workers persist metadata outside the plugin installation directory, under `$CODEX_HOME/antigravity-subagent/workers` by default. `AGY_MCP_STATE_DIR` can override the location. The ledger stores worker/conversation identity, friendly name, idempotency key, workspace, model/effort/mode, resolved AGY Project metadata, lifecycle/turn timestamps, transport details, timeout/cancel/error state, and usage metadata. It must not store prompts, responses, source code, or tool output.

A warm worker uses Antigravity persistent `stream-json` input/output when the installed CLI supports it. The MCP layer waits for the initial stream handshake and workspace attestation, persists `conversationId` plus `state=running`, and then starts the long turn. This ensures a worker never receives its delegated prompt before its workspace is verified.

Successful background response text is kept only in the current MCP process memory. After an MCP restart, result/wait calls may have persisted completion/status metadata with `resultAvailable=false`; inspect the workspace directly. Antigravity's conversation remains available for manual audit.

If Codex/MCP restarts or a warm process is lost, the worker becomes recoverable. The next follow-up starts a new AGY process with the exact persisted `--conversation <id>`, which also restores the conversation's associated Project. A cross-process worker lease prevents two MCP instances from driving the same worker concurrently.

Idle warm processes may be released automatically while the logical worker remains recoverable. This is normal and does not close the worker.

## Status, result, wait, and cancellation

`agy_status` with a `workerId` returns lifecycle information for one worker. Without a worker ID it lists open workers; `includeClosed=true` also includes ledger history. Project-aware status may include `agyProjectId`, `agyProjectName`, `agyProjectRoots`, project resolution mode, and workspace attestation metadata.

`agy_result(workerId)` never sends a prompt and never waits. During an active turn it returns `done=false`. Once the current MCP process receives the final AGY result it returns `done=true`, bounded response text, transport/AGY status classification, and usage metadata.

`agy_wait(workerId, timeoutSeconds)` also never sends a prompt. It waits inside the MCP server for the current managed turn to become terminal. If the passive wait interval ends or the MCP client cancels only the wait request, the worker continues running and can be awaited again.

`agy_cancel` targets only an active turn. After cancellation the worker remains available for a later `agy_followup`.

## Project, model, and effort selection

For a new delegation or managed worker, `projectId`, `model`, and `effort` are optional MCP arguments. The Project is first resolved from `cwd`; model families are discovered from the authenticated Antigravity installation.

When one or more values remain unresolved, the MCP server returns the modern `input_required` setup flow. The form contains only the fields that genuinely require user input and may combine an ambiguous Project choice with model/effort choices in one interaction. The SDK's compatibility layer serves older MCP clients without requiring a separate push-style picker implementation.

Do not report “the picker could not be shown” merely because a later input round failed. Distinguish decline/cancel, invalid selections, catalog errors, and protocol/client failures from the fact that the UI was displayed.

If a model family does not expose the selected effort, return a clear error instead of silently substituting another model or effort. Valid effort values are `low`, `medium`, and `high`.

Do not ask for Project, model, or effort again on `agy_followup`.

## One-shot delegation

Use `agy_delegate` for bounded research, second opinions, or work that does not need a follow-up session. It remains a blocking one-shot compatibility tool and honors MCP request cancellation. It can use the same Project/model/effort setup flow, but managed worker workspace attestation is specific to persistent stream starts.

Older AGY versions without persistent stream input retain the legacy one-shot initial-start path. That compatibility start cannot know its `conversationId` before AGY finishes, so it remains blocking.

## Managed result handling

Managed start/follow-up acknowledgements are intentionally compact. Preserve `workerId`, `conversationId`, Project identity, state, transport, and logical idempotency key. Do not mistake an acknowledgement for the final worker response.

Persistent stream results report cumulative session usage. The MCP layer also computes `turnUsage` as the delta from the previous persisted usage snapshot and preserves cumulative values as `sessionUsage`/`usage`.

Stream step updates are summarized as counts for observability rather than copying text deltas, tool payloads, or subagent output into Codex context. Codex can inspect the shared workspace directly.

CLI discovery, capability probes, model catalogs, and Project metadata use bounded/local discovery. `agy_check` accepts `refresh=true` for a fresh capability/model probe.

## Auditing Antigravity sessions

Managed workers retain the returned Antigravity conversation ID. The same conversation can be inspected manually with interactive `agy` and `/resume`, or resumed directly with `agy --conversation <conversation-id>`.

The local friendly worker name is guaranteed in the plugin ledger. Antigravity may generate its own native conversation title; do not attempt unsupported headless slash-command hacks to force it to match.

Treat the persisted worker metadata and AGY conversation as an audit trail of visible conversation/tool activity. Do not describe either as access to hidden model chain-of-thought.

## Bundled runner

When MCP tools are unavailable, use the bundled `scripts/agy-delegate.mjs` runner. It requires Node.js 20 or newer and a locally installed, authenticated `agy` CLI.

Write the complete prompt to a temporary UTF-8 file and pass its absolute path to the runner. This temporary prompt-file encoding rule does not imply anything about source-file encoding in the target repository. Do not interpolate an untrusted prompt into shell syntax.

```text
node <skill-dir>/scripts/agy-delegate.mjs --cwd <absolute-workspace> --mode plan --prompt-file <absolute-prompt-file> --model <model> --effort <low|medium|high>
```

To resume a known conversation through the fallback runner, add `--conversation <conversation-id>`. The fallback runner does not provide managed Project resolution, registry/idempotency/leases/status/result/wait/cancel tools, or the MCP setup form.

Delete temporary prompt files after use. Do not add or emulate dangerous permission-bypass flags.

## Safety

- Never weaken the user's persisted sandbox or permission policy.
- Do not delegate secrets, credentials, private data, destructive operations, releases, deployments, purchases, or external messages without explicit authorization for that scope.
- Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication or interactive approval is required, return control to the user rather than bypassing it.
- Use finite task/turn timeouts and split oversized work into bounded plan steps.
- Keep Project/conversation IDs inside the user's local workflow unless the user requests them.

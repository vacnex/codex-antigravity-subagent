---
name: delegate-to-antigravity
description: >-
  Delegate one bounded coding, research, review, debugging, or implementation assignment to
  the local Google Antigravity CLI (`agy`) and manage that worker safely. Use when the user
  explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity,
  asks Codex to offload an independent task to `agy`, or when a parent execution workflow asks
  for a managed Antigravity worker.
---

# Delegate to Antigravity

Treat Antigravity as an external bounded worker. It is not a native Codex collaboration agent. Codex or the calling parent workflow remains responsible for scope, review, and final judgment.

This skill owns AGY worker mechanics. It does **not** own blueprint readiness, multi-task sequencing, cross-task dependency policy, or whole-blueprint completion. A parent workflow such as `execute-plan` owns those concerns.

## Managed worker workflow

Prefer managed workers for implementation or any bounded assignment likely to need review corrections:

1. Establish availability with `agy_check` and require a compatible Antigravity CLI capability report before managed work.
2. Choose a stable `idempotencyKey` for each logical `agy_start` and reuse the exact same key if the request/result is retried or uncertain.
3. When invoked standalone, Codex resolves applicable project/user instructions for the current checkout and distills only task-relevant constraints into the delegated prompt. When invoked by a parent workflow, treat its resolved execution contract as authoritative and do not broaden it.
4. Call `agy_start` with the real absolute checkout `cwd`. If `projectId`, `model`, or `effort` is unresolved, let the MCP setup flow obtain only the missing values. Do not silently invent a Project, model, or effort selection.
5. The MCP project resolver maps `cwd` to Antigravity Projects. Zero matches creates a new AGY Project for the workspace; one most-specific match is selected automatically; equally specific overlapping Projects require user selection. Never work around an ambiguous Project by guessing.
6. Preserve returned Project/model/effort metadata so a parent workflow can pin them for related fresh workers when it chooses to do so.
7. Do not pass or re-select a Project on `agy_followup`. Resuming the existing `conversationId` inherits the conversation's Antigravity Project.
8. On persistent-stream capable AGY, `agy_start` returns after stream handshake, workspace attestation, and durable worker registration while the first turn continues in the background. Treat `state=running` / `done=false` as accepted launch, not completion. Preserve `workerId` and `conversationId`.
9. Call `agy_wait(workerId)` as the normal completion barrier. If it returns `done=false` because the passive wait interval ended, call `agy_wait` again when the caller still requires completion.
10. When a managed turn is terminal, inspect the shared workspace and required validation independently. The delegated response is advisory; workspace state and supervisor review are the implementation source of truth.
11. A terminal `agyStatus=ERROR` is not automatically an implementation failure. Inspect `transportStatus`, `failureKind`, workspace changes, and validation before deciding whether a correction is necessary.
12. On independent review failure, choose a stable correction `idempotencyKey`, call `agy_followup` on the same worker, wait, and review again.
13. Use `agy_status` when worker state is uncertain, especially after Codex/MCP restart. A persisted open worker may be recoverable; `agy_followup` resumes its exact `conversationId`.
14. Use `agy_cancel(workerId)` only when the active turn is no longer useful. Canceling an `agy_wait` request must never be treated as permission to cancel the AGY worker.
15. Call `agy_close` only when the caller's independent review says the logical bounded assignment no longer needs correction. A parent workflow may deliberately keep a passed worker open for later integration corrections.

## Parent workflow ownership

When a parent workflow invokes this skill:

- Do not decide whether an approved blueprint is READY or stale.
- Do not decide which task runs next.
- Do not merge two independently scoped tasks into one worker.
- Do not reuse one worker for a different logical assignment.
- Do not close a worker earlier than the parent workflow requests.
- Do not perform a whole-blueprint or cross-task review on the parent's behalf unless explicitly delegated as a separate read-only assignment.

The parent workflow supplies task scope and review policy. This skill supplies worker lifecycle and AGY-specific safety semantics.

## Antigravity Project contract

Antigravity Projects define readable workspace context and may contain multiple roots. `cwd` identifies the checkout currently being worked on; it does not by itself define the whole AGY Project.

Project resolution rules:

- If an explicit `projectId` is supplied, it must exist and contain `cwd`. Otherwise fail rather than changing the Project.
- If no Project contains `cwd`, start AGY with a new Project rooted at that workspace.
- If one Project is the unique most-specific ancestor/equal root for `cwd`, select it automatically.
- If multiple Projects are equally valid, require user selection.
- Never silently add an unrelated path to an existing Project.
- Follow-ups inherit their Project from the existing AGY conversation and must not ask again.

A persistent AGY worker must attest stream `init.cwd` before the prompt is sent. If AGY reports a workspace different from requested `cwd`, treat `WORKSPACE_MISMATCH` or equivalent launch error as a hard blocker for that worker. Do not ask AGY to search parent directories, other drives, scratch directories, or duplicate clones to find the repository.

Project roots are read/search scope, not write permission. The delegated prompt's Owned Paths remain the write boundary.

## Rule ownership and bounded research

AGY needs enough local context to implement correctly, but it should not rediscover repository-level decisions already resolved by Codex or the parent workflow.

Before starting a standalone worker, Codex should read instruction sources governing the target checkout/module and pass only relevant constraints as `PROJECT CONSTRAINTS`. When a parent workflow provides those constraints, reuse them instead of reconstructing a parallel rule set.

AGY should read Owned Paths and supplied Read-only Context. It may inspect narrowly adjacent files when needed to resolve a concrete implementation uncertainty, but must not broaden write scope or redesign approved architecture.

Codex review is an independent safety net, not a substitute for AGY reading directly relevant code before editing.

## Delegated execution contract

For implementation assignments, pass a bounded contract when the information is available:

```text
EXPECTED WORKSPACE
<absolute cwd>

ANTIGRAVITY PROJECT
<project id/name and roots when known>

ROLE
You are the bounded implementation worker for this single assignment.
Codex or the parent workflow will independently review the resulting workspace delta.

OWNED PATHS
<paths this worker may modify>

FORBIDDEN PATHS
<paths this worker must not modify, or None>

READ-ONLY CONTEXT
<direct dependencies or supporting paths that should be inspected>

PROJECT CONSTRAINTS
<only task-relevant rules already resolved by the supervisor>

TASK
<exact bounded implementation task>

ACCEPTANCE CRITERIA
<observable success conditions>

CANONICAL VALIDATION
<single project-appropriate validation/build/test command or check when supplied>

STOP CONDITIONS
<conditions requiring escalation rather than inference>
```

Generic execution rules for AGY:

- Read Owned Paths and supplied Read-only Context before editing.
- Inspect additional adjacent files only when needed for a concrete implementation uncertainty.
- Do not broadly rediscover requirements or conventions already supplied.
- Do not search parent trees or drives to locate the repository.
- Do not modify outside Owned Paths.
- Forbidden Paths are always non-writable.
- Project roots are read/search scope only; they do not expand write scope.
- Prefer targeted edits to existing files and the smallest edit that satisfies the task.
- Do not regenerate or replace an entire existing file when localized edits are sufficient.
- Preserve existing file encoding, BOM state, and line endings unless the project/task explicitly requires a change or a real encoding problem is detected.
- If text appears corrupted or mojibake is detected, stop rather than guessing a transcoding fix.
- When `run_command` is already executing PowerShell on Windows, run PowerShell expressions directly; do not wrap them in nested `powershell -Command` calls.
- Run only supplied CANONICAL VALIDATION unless the task itself is build/toolchain diagnosis.
- If canonical validation fails solely because of an out-of-scope problem, report it and stop instead of chasing unrelated failures.
- Once acceptance criteria and required validation are satisfied, stop investigating and report completion.

Machine-specific validation commands belong in user/project rules or the parent execution workflow, not in this generic plugin skill.

## Correction-turn edit strategy

Correction turns must be narrower than initial implementation turns.

When the supervisor reports concrete findings:

- Patch only those findings unless resolving them strictly requires a broader approved change.
- Re-read only the affected region plus minimum surrounding context needed to edit safely.
- Prefer localized replace/edit operations over full-file regeneration.
- Do not re-run repository discovery, architecture research, or unrelated validation.
- Preserve unrelated user/workspace changes exactly as they are.
- Re-run supplied canonical validation only when the correction can affect it or the supervisor explicitly requests it.
- Stop and escalate if the correction would require a new unapproved product, architecture, API, database, security, compatibility, or scope decision.

Full-file replacement is appropriate for a new file or when the requested change genuinely affects most of an existing file. It is not the default correction mechanism.

## Terminal result semantics

Managed results distinguish transport/lifecycle from AGY's terminal report:

- `transportStatus=running`: the managed turn is still active.
- `transportStatus=ok`: the MCP runtime received a terminal AGY envelope, even if `agyStatus=ERROR`.
- `transportStatus=timeout|canceled|crashed|protocol_error`: transport/lifecycle failed or was interrupted.
- `agyStatus=SUCCESS|ERROR|...`: status reported by AGY in a valid terminal envelope.
- `failureKind=agy_response_timeout`: AGY ended with a response-timeout condition; audit the workspace before deciding whether correction is needed.
- `failureKind=agy_error`: AGY reported another terminal error; still audit the workspace.
- `failureKind=transport_timeout|process_exit|canceled|protocol_error`: treat runtime condition separately from implementation correctness.

Do not convert `agyStatus=ERROR` directly into "the code failed." If independent audit passes, do not submit a no-op correction merely to make AGY report SUCCESS.

## Retry and duplicate safety

`idempotencyKey` is the primary duplicate guard. Repeating `agy_start` with the same key returns the existing logical worker instead of spawning another conversation. Duplicate lookup happens before Project/model/effort setup, so a lost start result must be retried with the same key.

Repeating an active/completed `agy_followup` with the same correction key reuses that turn/result instead of submitting the prompt twice.

`agy_status` may expose `duplicateWorkerIds` for older/orphaned ledger entries. Do not silently create another worker to work around such a state.

## Persistence and recovery

Managed workers persist metadata outside the plugin installation directory, under `$CODEX_HOME/antigravity-subagent/workers` by default. `AGY_MCP_STATE_DIR` can override the location.

The ledger stores worker/conversation identity, friendly name, idempotency key, workspace, model/effort/mode, resolved AGY Project metadata, lifecycle/turn timestamps, transport details, timeout/cancel/error state, and usage metadata. It must not store prompts, responses, source code, or tool output.

A warm worker uses Antigravity persistent `stream-json` input/output when supported. The MCP layer waits for initial handshake and workspace attestation, persists `conversationId` plus `state=running`, and only then sends the long prompt.

Successful background response text is kept only in current MCP process memory. After MCP restart, result/wait calls may have persisted completion/status metadata with `resultAvailable=false`; inspect the workspace directly. The Antigravity conversation remains available for manual audit.

If Codex/MCP restarts or a warm process is lost, the worker becomes recoverable. The next follow-up starts a new AGY process with exact persisted `--conversation <id>`. A cross-process worker lease prevents two MCP instances from driving the same worker concurrently.

Idle warm processes may be released automatically while the logical worker remains recoverable. This is normal and does not close the worker.

## Status, result, wait, and cancellation

`agy_status(workerId)` returns lifecycle information for one worker. Without a worker ID it lists open workers; `includeClosed=true` also includes ledger history.

`agy_result(workerId)` never sends a prompt and never waits. During an active turn it returns `done=false`. Once the current MCP process receives final AGY result it returns `done=true`, bounded response text, transport/AGY status classification, and usage metadata.

`agy_wait(workerId, timeoutSeconds)` never sends a prompt. It waits inside MCP for the current managed turn to become terminal. If passive wait interval ends or the MCP client cancels only the wait request, the worker continues running and can be awaited again.

`agy_cancel` targets only an active turn. After cancellation the worker remains available for later `agy_followup`.

`agy_close` closes the logical managed worker and retains local audit metadata plus Antigravity conversation history.

## Project, model, and effort selection

For a new delegation or managed worker, `projectId`, `model`, and `effort` are optional MCP arguments. Project is first resolved from `cwd`; model families are discovered from the authenticated Antigravity installation.

When values remain unresolved, the MCP server returns the `input_required` setup flow containing only fields that genuinely require user input.

Do not report that a picker "could not be shown" merely because a later input round failed. Distinguish decline/cancel, invalid selection, catalog errors, and protocol/client failures.

If a model family does not expose selected effort, return a clear error rather than silently substituting another model or effort. Valid effort values are `low`, `medium`, and `high`.

Do not ask for Project, model, or effort again on `agy_followup`.

## One-shot delegation

Use `agy_delegate` for bounded research, second opinions, or work that does not need a follow-up session. It remains a blocking one-shot compatibility tool and honors MCP request cancellation.

Older AGY versions without persistent stream input retain the legacy one-shot initial-start path. That compatibility start cannot know its `conversationId` before AGY finishes, so it remains blocking.

## Managed result handling

Managed start/follow-up acknowledgements are intentionally compact. Preserve `workerId`, `conversationId`, Project identity, state, transport, and logical idempotency key. Do not mistake an acknowledgement for the final worker response.

Persistent stream results report cumulative session usage. The MCP layer also computes `turnUsage` as delta from previous persisted usage snapshot and preserves cumulative values as `sessionUsage`/`usage`.

Stream step updates are summarized as counts for observability rather than copying text deltas, tool payloads, or subagent output into Codex context. Codex can inspect shared workspace directly.

CLI discovery, capability probes, model catalogs, and Project metadata use bounded/local discovery. `agy_check` accepts `refresh=true` for a fresh capability/model probe.

## Auditing Antigravity sessions

Managed workers retain returned Antigravity conversation ID. The same conversation can be inspected manually with interactive `agy` and `/resume`, or resumed directly with `agy --conversation <conversation-id>`.

The local friendly worker name is guaranteed in plugin ledger. Antigravity may generate its own native conversation title; do not attempt unsupported headless slash-command hacks to force it to match.

Treat persisted worker metadata and AGY conversation as an audit trail of visible conversation/tool activity. Do not describe either as access to hidden model chain-of-thought.

## Bundled runner

When MCP tools are unavailable, use bundled `scripts/agy-delegate.mjs`. It requires Node.js 20 or newer and a locally installed, authenticated `agy` CLI.

Write complete prompt to a temporary UTF-8 file and pass its absolute path to the runner. This temporary prompt-file encoding rule does not imply anything about source-file encoding in target repository. Do not interpolate an untrusted prompt into shell syntax.

```text
node <skill-dir>/scripts/agy-delegate.mjs --cwd <absolute-workspace> --mode plan --prompt-file <absolute-prompt-file> --model <model> --effort <low|medium|high>
```

To resume a known conversation through fallback runner, add `--conversation <conversation-id>`. The fallback runner does not provide managed Project resolution, registry/idempotency/leases/status/result/wait/cancel tools, or MCP setup form.

Delete temporary prompt files after use. Do not add or emulate dangerous permission-bypass flags.

## Safety

- Never weaken the user's persisted sandbox or permission policy.
- Do not delegate secrets, credentials, private data, destructive operations, releases, deployments, purchases, or external messages without explicit authorization for that scope.
- Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication or interactive approval is required, return control to the user rather than bypassing it.
- Use finite task/turn timeouts.
- Keep Project/conversation IDs inside the user's local workflow unless the user requests them.

---
name: delegate-to-antigravity
description: >-
  Delegate one bounded coding, research, review, debugging, or implementation assignment to the local
  Google Antigravity CLI (`agy`) and manage that worker safely. Use for standalone AGY work or when a
  parent workflow needs AGY worker mechanics. Approved multi-PLAN blueprints are orchestrated by `$execute-plan`.
---

# Delegate to Antigravity

Antigravity is an external bounded worker. Codex or the parent workflow remains responsible for scope, semantic review, and final judgment.

This skill owns generic AGY worker mechanics. It does **not** own blueprint readiness, PLAN sequencing, whole-blueprint review, or canonical blueprint capture. `$execute-plan` owns those concerns and uses the high-level `agy_start_plan` path.

## Managed standalone worker workflow

For a standalone bounded assignment:

1. Call `agy_check` before the first delegation and require compatible capabilities.
2. Resolve the real absolute checkout `cwd`.
3. Read applicable project/user instructions and distill only task-relevant constraints.
4. Choose a stable `idempotencyKey` for the logical assignment.
5. Call `agy_start` with the bounded prompt.
6. Preserve `workerId`, `conversationId`, Project/model/effort metadata.
7. Use `agy_wait(workerId)` as the normal completion barrier.
8. Independently inspect the shared workspace/required evidence.
9. On review failure, call `agy_followup` on the same worker with a narrower correction prompt.
10. Use `agy_status` only when lifecycle/recovery state is uncertain.
11. Use `agy_cancel` only when an active turn is no longer useful.
12. Call `agy_close` only after independent review says no further correction is needed.

`agy_start` is the low-level generic prompt API. Do not use it to manually re-encode an approved `AGY_BLUEPRINT:v1`; `$execute-plan` must use `agy_start_plan` so repeated PLAN text is constructed server-side without Codex output tokens.

## Parent workflow ownership

When a parent workflow invokes this skill:

- accept its resolved scope/constraints as authoritative;
- do not decide whether a blueprint is READY/stale;
- do not decide which PLAN runs next;
- do not merge independently scoped tasks into one worker;
- do not reuse one worker for a different logical assignment;
- do not close a worker earlier than the parent requests;
- do not perform cross-PLAN/whole-blueprint review unless explicitly delegated as a separate read-only assignment.

## Antigravity Project contract

Project resolution remains MCP-owned:

- explicit `projectId` must exist and contain `cwd`;
- zero matching Projects creates a new Project rooted at the workspace;
- one unique most-specific Project is selected automatically;
- equally specific overlapping Projects require user selection;
- never guess an ambiguous Project or silently add an unrelated root;
- follow-ups inherit the existing conversation's Project and must not re-select it.

Persistent streams must attest the requested workspace before the prompt is sent. A workspace mismatch is a hard blocker.

Project roots are read/search scope, not write permission.

## Standalone delegated contract

For an implementation-capable standalone worker, include only information materially needed by that task:

```text
EXPECTED WORKSPACE
<absolute cwd>

ROLE
<single bounded assignment>

OWNED PATHS
<write scope>

FORBIDDEN PATHS
<forbidden scope or None>

READ-ONLY CONTEXT
<direct dependencies / proven precedents>

PROJECT CONSTRAINTS
<task-relevant resolved rules>

TASK
<exact assignment>

ACCEPTANCE CRITERIA
<observable completion criteria>

CANONICAL VALIDATION
<project-appropriate validation when supplied>

STOP CONDITIONS
<conditions requiring supervisor escalation>
```

For standalone work, Codex may inspect repository evidence first. Do not make AGY rediscover instruction hierarchy or broad architecture that Codex has already resolved.

## AGY execution rules

- Read target files and supplied reference context before editing.
- Inspect only a narrowly direct dependency when a concrete implementation uncertainty requires it.
- Do not search parent directories/other drives or broadly rediscover architecture.
- Do not modify outside Owned Paths.
- Forbidden Paths are never writable.
- Prefer targeted edits over file regeneration.
- Preserve unrelated user changes, encoding/BOM, and line endings.
- Stop on suspected mojibake/encoding corruption rather than guessing a conversion.
- Run only supplied validation unless the task is explicitly toolchain diagnosis.
- Stop when acceptance criteria are satisfied; do not keep exploring.
- Escalate material product/architecture/API/database/security/scope decisions rather than inventing them.

## Correction turns

Corrections are narrower than initial work:

- patch only concrete findings unless the approved assignment strictly requires more;
- re-read only affected regions/minimum direct dependency context;
- do not restart repository discovery;
- preserve unrelated correct work;
- reuse a stable correction `idempotencyKey` when retrying uncertain submissions.

For PLAN-bound workers, `$execute-plan` sends structured `findings` to `agy_followup`; MCP reconstructs the original PLAN and static correction policy server-side. Codex must not repeat the full PLAN in that tool call.

## Terminal semantics

Transport/lifecycle and AGY report status are separate:

- `transportStatus=running`: current turn still active;
- `transportStatus=ok`: a terminal AGY envelope was received, even if AGY reported `ERROR`;
- timeout/cancel/crash/protocol errors describe runtime transport;
- AGY `ERROR` is not automatically proof that implementation failed.

Always inspect workspace/validation before deciding whether correction is needed. Do not send a no-op follow-up merely to turn an AGY status from ERROR into SUCCESS.

## Retry, persistence, and recovery

`idempotencyKey` is the duplicate guard for `agy_start` and correction turns. Reuse the exact key when a result is lost/uncertain.

Worker metadata persists under `$CODEX_HOME/antigravity-subagent/workers` by default (or `AGY_MCP_STATE_DIR`). The worker ledger stores IDs, workspace, model/effort/mode, Project/lifecycle/usage metadata, but not prompts, responses, source code, or tool output.

After MCP restart, open workers may become recoverable. `agy_followup` resumes the exact persisted Antigravity `conversationId`; a cross-process lease prevents concurrent drivers for the same worker.

`agy_wait` waits inside MCP and does not send another prompt. Wait timeout/cancellation never cancels the worker. This avoids frequent model-driven polling while preserving a finite client deadline.

## Tool surface v0.5

Generic worker mechanics use:

- `agy_check`
- `agy_start`
- `agy_followup`
- `agy_wait`
- `agy_status`
- `agy_cancel`
- `agy_close`

Blueprint execution additionally uses:

- `agy_start_plan`
- `agy_review_plan`

The old one-shot `agy_delegate` and non-blocking `agy_result` surfaces are intentionally removed in v0.5 to keep the MCP schema smaller. Use `agy_start` + `agy_wait` for standalone bounded work.

## Safety

- Never weaken persisted sandbox/permission policy.
- Do not delegate secrets, credentials, private customer data, destructive external operations, deployments, purchases, or external messages without explicit authorization for that exact scope.
- Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication/interactive approval is required, return control to the user instead of bypassing it.
- Use finite turn/wait timeouts.

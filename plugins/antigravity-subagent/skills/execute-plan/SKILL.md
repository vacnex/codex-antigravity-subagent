---
name: execute-plan
description: >-
  Execute an approved READY execution blueprint with Google Antigravity CLI (`agy`) in the
  user's current local checkout. Codex acts as supervisor: it resolves project rules,
  delegates each PLAN to a fresh bounded worker, independently reviews the workspace delta,
  sends corrections to the same worker until the PLAN passes, performs a final whole-blueprint
  audit, and closes workers only after execution is complete.
---

# Execute Plan with Antigravity

Codex is the supervisor and source of execution judgment. Antigravity is the bounded implementation worker for one `PLAN-XX` task at a time.

Use this skill when the user asks to execute, run, implement, or begin coding an already-approved plan/blueprint with Antigravity. This skill owns multi-PLAN sequencing and review policy. The `delegate-to-antigravity` skill owns AGY worker mechanics.

## 1. Execution gate

Before any implementation delegation:

1. Locate the approved blueprint.
2. Require exactly `Blueprint status: READY`.
3. Require `## Implementation Tasks` with stable `PLAN-XX` tasks.
4. Do not execute a `BLOCKED` blueprint.
5. Do not silently fill missing material decisions or rewrite the approved architecture during execution.
6. If the blueprint is stale enough that its target paths, symbols, contracts, or prerequisites no longer match the checkout, stop and request re-planning rather than improvising.

A missing optional `Blueprint basis` is not by itself a blocker. When basis metadata exists, compare it with the current checkout as a freshness signal; ordinary unrelated drift is acceptable if the PLAN change surface and contracts remain valid.

## 2. Responsibility boundary

During this workflow:

- Codex reads repository/project instructions, resolves the execution contract, records baselines, reviews actual workspace changes, runs or verifies canonical validation, and decides PASS / FAIL / BLOCKED.
- AGY performs bounded repository inspection, implementation edits, and delegated validation inside the current checkout.
- Codex does not patch implementation files itself unless the user explicitly asks for supervisor fallback. Review failures go back to the owning AGY worker.
- `delegate-to-antigravity` is the source of truth for AGY Project resolution, workspace attestation, managed-worker lifecycle, idempotency/retry semantics, wait/status/result behavior, recovery, and cancellation.
- This skill is the source of truth for blueprint readiness, PLAN ordering, baselines, per-PLAN review, cross-PLAN final audit, and worker close timing for an execution run.

Do not create worktrees, branches, commits, or merges unless the user explicitly requested them or a higher-priority project instruction requires them.

Never delegate credentials, production operations, destructive external actions, database mutations, generated-model refreshes, deployments, purchases, or external messages unless the user explicitly authorized that exact scope and project policy allows it.

## 3. Resolve the execution run

Before `PLAN-01`:

1. Read applicable `AGENTS.md` files and authoritative project/user instructions for the selected checkout.
2. Read the complete approved blueprint.
3. Resolve the absolute checkout path.
4. Verify Git status when the project requires Git-backed execution.
5. Record the execution baseline:
   - current Git HEAD when available;
   - `git status --short`;
   - existing user changes relevant to the blueprint change surface.
6. Call `agy_check` before the first AGY delegation and require compatible managed-worker support for implementation.
7. Initialize an execution-run identity used to derive stable worker idempotency keys.

Do not dump the whole repository diff into model context merely to establish a baseline. Inspect and preserve the smallest evidence needed to distinguish pre-existing user changes from worker changes.

## 4. Resolve each PLAN contract

Before starting a PLAN, resolve these fields from the blueprint plus project instructions:

- `Task ID`
- `Goal`
- `Owned Paths` from the PLAN write scope
- `Forbidden Paths`
- `Read-only Context`
- `Acceptance Criteria`
- `Project Constraints` relevant to this PLAN only
- `Canonical Validation`
- `Stop Conditions`

If a required field is missing but can be resolved unambiguously from authoritative project instructions or repository evidence, Codex may resolve it without changing the approved product/architecture decision. If resolving it would require a material design choice, the run is BLOCKED and must return to planning.

`PROJECT CONSTRAINTS` must contain only task-relevant rules. Do not make AGY rediscover instruction hierarchy that Codex has already resolved.

## 5. Per-PLAN baseline

Immediately before each fresh PLAN worker starts:

- capture `git status --short`;
- capture the pre-existing diff for Owned Paths;
- record hashes or equivalent file identity only when useful for separating overlapping user edits.

Never auto-revert user changes. If execution produces changes outside Owned Paths, Codex must inspect ownership before continuing.

## 6. Start a fresh PLAN worker

Use one fresh managed AGY worker per `PLAN-XX`. A PLAN worker is never reused for a different PLAN.

For the first worker, `projectId`, `model`, or `effort` may be left unresolved so the plugin can obtain only the missing selections. After a successful first start, pin and reuse the returned:

- `agyProjectId` when available;
- `model`;
- `effort`.

Pass those values to later fresh PLAN workers so the execution run does not repeatedly ask for the same selection. Follow-ups on an existing worker inherit its Project and must not re-select it.

Choose a stable `idempotencyKey` for the logical PLAN start. A recommended form is derived from the execution-run identity plus task ID, for example:

```text
<run-key>:PLAN-01
```

If an `agy_start` request/result is lost or uncertain, retry with the exact same key.

Start implementation with `mode: "accept-edits"` only because the user has already requested execution.

The delegated prompt should contain the bounded execution contract, not the whole chat history:

```text
EXPECTED WORKSPACE
<absolute checkout>

ROLE
You are the bounded implementation worker for <PLAN-XX>.
Codex has already planned the repository-level change and will independently review the workspace delta.

OWNED PATHS
<write scope>

FORBIDDEN PATHS
<explicit forbidden scope or None>

READ-ONLY CONTEXT
<direct dependencies / precedents / contracts>

PROJECT CONSTRAINTS
<task-relevant resolved rules only>

TASK
<goal, required changes, implementation logic, failure/boundary behavior>

ACCEPTANCE CRITERIA
<observable completion criteria>

CANONICAL VALIDATION
<resolved command/check/scenario>

STOP CONDITIONS
<exact conditions requiring escalation rather than inference>
```

Do not duplicate generic AGY execution rules already owned by `delegate-to-antigravity` unless a project-specific constraint overrides or tightens them.

## 7. Wait for the worker correctly

After `agy_start` or `agy_followup`:

1. Preserve `workerId` and `conversationId`.
2. Use `agy_wait(workerId)` as the normal completion barrier.
3. If `agy_wait` returns `done=false` only because the passive wait interval ended, call `agy_wait` again on the same worker.
4. A running worker is not a blocker and is not permission to start the next PLAN.
5. Use `agy_status` when lifecycle state is uncertain, especially after Codex/MCP restart.

Do not orchestrate long work with shell sleeps or frequent model-driven polling.

## 8. Independent PLAN audit

When the worker turn reaches a terminal state, Codex reviews the current workspace itself. The AGY narrative is advisory, not proof.

Audit at minimum:

- actual diff relative to the PLAN baseline;
- no unauthorized changes outside Owned Paths;
- pre-existing user changes were preserved;
- implementation matches the approved PLAN and acceptance criteria;
- project constraints and forbidden paths were respected;
- encoding/BOM/line-ending concerns when relevant to the project;
- canonical validation and its actual result;
- no unrelated refactor or scope expansion.

Judge implementation correctness independently from AGY transport/report status. `agyStatus=ERROR` does not automatically mean the code failed; inspect the workspace and validation first.

Return exactly one internal verdict for the current PLAN:

- `PLAN_PASS`
- `PLAN_FAIL`
- `PLAN_BLOCKED`

`PLAN_BLOCKED` is only for a genuine unresolved prerequisite or material decision that cannot be safely corrected inside the approved blueprint.

## 9. Correction loop

On `PLAN_FAIL`:

1. Convert Codex review findings into a concrete, minimal correction prompt.
2. Use `agy_followup` with the same `workerId`.
3. Use a stable correction key such as:

```text
<run-key>:PLAN-01:FIX-01
```

4. Reuse the exact same correction key if submission/result is uncertain.
5. Wait again with `agy_wait`.
6. Re-audit the workspace.
7. Repeat until `PLAN_PASS` or `PLAN_BLOCKED`.

Corrections must patch only concrete findings unless a broader change is strictly required by the approved PLAN. If the required fix changes architecture, public contracts, database/schema decisions, or approved scope, stop and return to planning instead of broadening the worker's authority.

Do not send a no-op correction merely to convert an AGY terminal report from ERROR to SUCCESS when Codex audit already passes.

## 10. PLAN transition policy

Only a `PLAN_PASS` may advance dependency execution.

After a PLAN passes:

- record its final reviewed delta and validation evidence;
- keep its worker open but idle until the final whole-blueprint audit completes;
- begin the next dependency-ready PLAN with a fresh worker.

Keeping passed workers open allows a later integration finding to be corrected in the original owning conversation. The plugin may release the warm process while preserving the logical worker as recoverable; that is acceptable.

Do not use a passed PLAN worker as implementation context for another PLAN.

## 11. Final whole-blueprint audit

After every requested PLAN has individually passed, Codex must review the cumulative implementation against the entire approved blueprint.

Verify:

- all requested PLANs are implemented;
- cross-PLAN contracts and data/control flow agree;
- cumulative diff stays within the blueprint's total approved change surface;
- explicit non-goals remain unchanged;
- final integration/build/test/manual verification required by the blueprint passes;
- no PLAN-local implementation introduced an integration regression hidden by its local check.

Final audit verdict:

- `BLUEPRINT_PASS`
- `BLUEPRINT_FAIL`
- `BLUEPRINT_BLOCKED`

On `BLUEPRINT_FAIL`, route each concrete finding back to the worker that owns the affected change surface using `agy_followup`, then re-run the affected PLAN audit and the final whole-blueprint audit. If a finding spans multiple PLANs, use the narrowest owning worker(s) necessary and preserve approved task boundaries.

If the final finding requires a new material architecture/product/API/database decision not present in the blueprint, return `BLUEPRINT_BLOCKED` and require re-planning.

## 12. Close workers

Call `agy_close` only after `BLUEPRINT_PASS`, or when the user explicitly ends the run and no further correction will be attempted.

After `BLUEPRINT_PASS`:

1. Close every PLAN worker created by this execution run.
2. Retain their local audit metadata/conversation history as provided by the plugin.
3. Do not create commits or merges unless separately requested.

If closing one worker fails after implementation already passed, report the cleanup problem separately; do not reinterpret correct code as an implementation failure.

## 13. Recovery and interruption

If Codex/MCP restarts or a worker becomes recoverable:

- use `agy_status` to inspect durable worker state;
- do not start a duplicate worker for the same PLAN merely because response text is unavailable;
- inspect the workspace and durable status before deciding whether a correction is necessary;
- resume corrections with `agy_followup` on the original worker/conversation when appropriate.

If the user cancels the execution run, use `agy_cancel` only for active turns that are no longer useful. Do not treat cancellation of an `agy_wait` request as cancellation of the worker itself.

## 14. Final user report

After completion, report compactly:

- blueprint executed;
- PLANs completed;
- files/change areas affected;
- validation performed;
- final whole-blueprint verdict;
- any deviations, blockers, or cleanup issues.

Do not dump worker transcripts or hidden reasoning. The source of truth is the reviewed workspace and validation evidence.

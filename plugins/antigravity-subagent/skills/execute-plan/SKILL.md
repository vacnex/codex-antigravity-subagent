---
name: execute-plan
description: >-
  Execute an approved READY AGY_BLUEPRINT:v1 with Google Antigravity CLI workers while Codex remains
  the repository supervisor and semantic reviewer. Use when the user asks to implement/run an approved
  blueprint. The MCP server captures the already-rendered blueprint from the Codex thread, builds long
  worker prompts server-side, enforces mechanical boundaries, and keeps repeated PLAN text out of Codex tool output.
---

# Execute Plan with Antigravity

Codex is the control plane. MCP is the deterministic orchestration plane. Antigravity is the implementation/data plane.

The goal is not to minimize useful Codex reasoning. Codex should read repository evidence and review deeply. The goal is to avoid making Codex regenerate large PLAN/context/boilerplate text that the MCP server can copy or reconstruct without model tokens.

## 1. Execution gate

Before implementation:

1. Locate the approved blueprint already rendered in this Codex thread.
2. Require the exact `<!-- AGY_BLUEPRINT:v1:START -->` / `<!-- AGY_BLUEPRINT:v1:END -->` canonical form.
3. Require `Blueprint status: READY`.
4. Require `## Implementation Tasks` with stable `PLAN-XX` tasks.
5. Do not execute a `BLOCKED` blueprint.
6. Do not silently fill a missing material decision during execution. Return to `$execution-blueprint` when architecture/product/API/database/security/scope decisions change.

The first `agy_start_plan` call captures the latest canonical READY blueprint from the current Codex thread through MCP `threadId` metadata and persists it under local plugin state. **Do not copy the blueprint into a tool argument as a fallback.** If capture is unavailable or malformed, stop and report that concrete capture problem.

## 2. Responsibility boundary

### Codex owns

- planning and repository understanding;
- applicable project/user instruction hierarchy;
- semantic interpretation of conventions and precedents;
- material architecture/API/database/product decisions;
- deep review of actual implementation and edge cases;
- `PLAN_PASS` / `PLAN_FAIL` / `PLAN_BLOCKED`;
- final whole-blueprint semantic audit.

### MCP owns deterministic mechanics

- capture/persistence/parsing of the canonical blueprint;
- execution-run identity and worker ↔ PLAN mapping;
- server-side AGY prompt construction;
- selected source-file materialization from PLAN context;
- per-PLAN baselines;
- changed-path / write-scope / forbidden-scope checks;
- preservation checks for pre-existing outside-scope changes;
- bounded diff preparation;
- canonical validation execution when the PLAN declares an executable command;
- worker lifecycle/idempotency/recovery metadata;
- correction prompt reconstruction from original PLAN + Codex findings.

### AGY owns

- implementation edits;
- code generation and correction output;
- reading the supplied target/reference context plus only narrowly necessary direct dependencies;
- supplied validation work;
- reporting BLOCKED instead of inventing a material decision.

Codex does not patch implementation files itself unless the user explicitly requests supervisor fallback.

## 3. Start the execution run

Call `agy_check` before the first delegation and require compatible managed-worker support.

For the first PLAN, call only the compact high-level tool:

```text
agy_start_plan({
  planId: "PLAN-01",
  cwd: <absolute checkout>,
  // projectId/model/effort only when already explicitly selected
})
```

Do **not** generate or pass:

- PLAN text;
- whole blueprint text;
- AGY execution boilerplate;
- source-file contents;
- project conventions already present in the canonical PLAN.

The MCP server will:

1. read current Codex `threadId` metadata;
2. capture the latest canonical blueprint from the local Codex rollout;
3. validate workspace/readiness/schema;
4. persist the blueprint once;
5. create `runId`;
6. capture the PLAN baseline;
7. build the long AGY prompt server-side;
8. materialize approved target/reference source where bounded;
9. start the fresh AGY worker.

Preserve returned `runId`, `blueprintId`, `workerId`, and `conversationId`.

For every later PLAN in the same blueprint, call:

```text
agy_start_plan({
  runId: <same run>,
  planId: "PLAN-02"
})
```

The run reuses workspace, blueprint, Project/model/effort selections. Each PLAN still gets a fresh logical worker and conversation.

## 4. PLAN ordering

Follow `#### Depends on` exactly. Do not start a dependent PLAN before every prerequisite PLAN has received Codex `PLAN_PASS`.

One PLAN worker is never reused for another PLAN. Parallel execution is allowed only when the approved blueprint explicitly makes tasks independent and the user/workflow allows parallel work; otherwise preserve blueprint order.

After a PLAN passes, keep its worker open but idle until the final whole-blueprint audit so an integration finding can return to the original owning conversation.

## 5. Completion barrier

After `agy_start_plan` or `agy_followup`:

1. call `agy_wait(workerId)`;
2. preserve the same worker when a passive wait interval expires;
3. if `done=false` only because the wait timed out, call `agy_wait` again;
4. do not start the next dependent PLAN merely because the worker is still running;
5. use `agy_status` only when lifecycle/recovery state is genuinely uncertain.

Do not orchestrate long work with shell sleeps, frequent `agy_status`, or model-driven polling. `agy_wait` performs the passive polling inside MCP, with a long default interval.

A terminal AGY `ERROR` is not automatically an implementation failure. The workspace plus independent review remain authoritative.

## 6. Deterministic review evidence

Once the PLAN worker reaches a terminal state, call:

```text
agy_review_plan({
  runId,
  planId
})
```

This tool may run the PLAN's canonical validation and therefore can mutate ordinary build/test artifacts; it does not make the semantic verdict.

The review bundle supplies:

- original approved PLAN contract;
- changed files relative to the per-PLAN baseline;
- unauthorized changes;
- forbidden-scope changes;
- detected modification of pre-existing outside-scope user changes;
- validation command/result/output when executable;
- bounded owned-path diff;
- explicit truncation/incomplete flags.

If the bundle says a diff is truncated/incomplete, Codex should inspect the listed changed files and surrounding source directly rather than lowering review quality.

## 7. Deep Codex semantic review

Codex should spend reasoning budget here. Review the actual code, not merely AGY's narrative.

Audit at minimum:

- implementation matches the approved PLAN intent and exact material decisions;
- naming and structure follow the precedents/conventions Codex identified while planning;
- no invented helper/abstraction/API/DTO/schema pattern slipped in;
- null/error/loading/boundary behavior matches the PLAN and repository conventions;
- no missed edge case or regression in directly affected control/data flow;
- public contracts remain compatible unless explicitly approved otherwise;
- changed files and mechanical scope evidence are acceptable;
- pre-existing user changes remain preserved;
- validation result is real and relevant;
- no unrelated refactor, speculative cleanup, or scope expansion was introduced.

Return one internal verdict:

- `PLAN_PASS`
- `PLAN_FAIL`
- `PLAN_BLOCKED`

Do not force PASS just because mechanical checks pass. Conversely, do not fail correct code solely because AGY's terminal narrative/status is imperfect.

## 8. Correction loop without PLAN duplication

On `PLAN_FAIL`, produce detailed review findings. Quality matters more than making findings artificially tiny.

Send **findings only**:

```text
agy_followup({
  workerId,
  findings: [
    {
      file: "...",
      symbol: "...",
      problem: "...",
      expected: "...",
      rationale: "..."
    }
  ]
})
```

Do not append the original PLAN, source context, static AGY rules, or blueprint text. MCP maps `workerId → runId → blueprintId → PLAN`, reconstructs the correction prompt server-side, and uses a stable derived correction key when none is supplied.

Then:

1. `agy_wait(workerId)`;
2. `agy_review_plan({ runId, planId })` again;
3. repeat deep Codex review;
4. continue until `PLAN_PASS` or `PLAN_BLOCKED`.

A correction may address only concrete findings unless the approved PLAN itself requires a broader change. If the fix needs a new material decision, return to planning.

## 9. Final whole-blueprint audit

After all requested PLANs individually pass, Codex reviews the cumulative workspace against the entire canonical blueprint.

Verify:

- every requested PLAN is implemented;
- cross-PLAN contracts/data/control flow agree;
- cumulative behavior still matches the architectural decisions and non-goals;
- no PLAN-local choice introduced an integration regression;
- final integration/build/test/manual verification required by the blueprint passes;
- naming/convention consistency remains intact across PLAN boundaries.

Final verdict:

- `BLUEPRINT_PASS`
- `BLUEPRINT_FAIL`
- `BLUEPRINT_BLOCKED`

On `BLUEPRINT_FAIL`, route each concrete finding to the original owning worker using `agy_followup(findings)`, then re-review affected PLANs and repeat the final audit. Use the narrowest owning worker(s) necessary.

If the final issue requires a new unapproved material decision, return `BLUEPRINT_BLOCKED` and re-plan instead of granting AGY new authority.

## 10. Close and cleanup

Call `agy_close` only after `BLUEPRINT_PASS`, or when the user explicitly abandons the run.

After the last PLAN worker in a run is closed, MCP removes temporary baseline source snapshots while retaining bounded blueprint/run/worker audit metadata. Do not create commits/branches/merges unless separately requested.

A cleanup failure is not an implementation failure; report it separately.

## 11. Recovery

After Codex/MCP restart:

- use `agy_status` for persisted worker state;
- reuse the original `runId` and PLAN worker mapping when available;
- never create a duplicate worker merely because response text is no longer in MCP memory;
- resume corrections through `agy_followup` on the original `conversationId`;
- use the persisted PLAN baseline for review when available.

## 12. Final user report

Report compactly:

- blueprint/run executed;
- PLANs completed;
- affected files/change areas;
- validation performed;
- final whole-blueprint verdict;
- any genuine deviations, blockers, or cleanup issues.

Do not dump worker transcripts or hidden reasoning. The source of truth is the canonical blueprint, reviewed workspace, and validation evidence.

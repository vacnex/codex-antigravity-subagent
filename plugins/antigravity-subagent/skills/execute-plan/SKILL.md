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

A blueprint that records a concrete `Git HEAD` is valid only while that checkout remains on the same HEAD. PLAN resolution performs a deterministic freshness check before PLAN-bound execution/review/correction. If an MCP error contains `BLUEPRINT_STALE` or `BLUEPRINT_FRESHNESS_UNAVAILABLE`, stop the existing execution path and return to `$execution-blueprint`; do not bypass the check, reuse the stale PLAN, or ask AGY to reconcile repository drift. A blueprint whose basis explicitly records `Git HEAD: unavailable` skips this freshness gate.

## 2. Responsibility boundary

### Codex owns

- planning and repository understanding;
- applicable project/user instruction hierarchy;
- semantic interpretation of conventions and precedents;
- material architecture/API/database/product decisions;
- deep review of actual implementation and edge cases;
- independent verification that the implementation makes sense in repository reality even if the approved blueprint itself contained a mistaken assumption;
- `PLAN_PASS` / `PLAN_FAIL` / `PLAN_BLOCKED`;
- final whole-blueprint semantic/architecture audit.

### MCP owns deterministic mechanics

- capture/persistence/parsing of the canonical blueprint;
- execution-run identity and worker ↔ PLAN mapping;
- server-side AGY prompt construction;
- selected source-file materialization from PLAN context;
- per-PLAN baselines;
- workspace-relative changed-path / write-scope / forbidden-scope checks even when the Git root is above the execution workspace;
- preservation checks for pre-existing outside-scope changes, including sibling paths outside the execution workspace;
- optional bounded diff preparation;
- direct canonical validation execution when the PLAN declares one executable argv-style command;
- PLAN-bound logical-worker supervision across retryable AGY response-timeout turns;
- worker lifecycle/idempotency/recovery metadata;
- correction/manual-recovery prompt reconstruction from the original PLAN without Codex repeating PLAN text.

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

For PLAN-bound work, omit `timeoutSeconds`. The server applies the long PLAN
deadline. Do not pass short values such as `120`; a worker deadline is not the
same thing as the passive `agy_wait` interval.

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
9. start the fresh logical PLAN worker.

Preserve returned `runId`, `blueprintId`, `workerId`, and `conversationId`. The compact text acknowledgement includes `workerId` and `runId`; do not recover them through extra status calls when they were already returned.

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

## 5. Logical PLAN completion barrier

After `agy_start_plan` or `agy_followup`:

1. call exactly one long-poll `agy_wait({ workerId })` with the default interval;
2. rely on MCP progress notifications while that request is open; they are not intermediate tool results and do not add repeated worker output to Codex context;
3. if the passive wait interval genuinely ends or the transport is interrupted while the logical PLAN worker is still active, preserve the same worker and call `agy_wait` again; never poll in a short model-driven loop;
4. do not use `agy_status` as routine polling; use it only when lifecycle state is genuinely contradictory/uncertain or after restart;
5. do not start the next dependent PLAN until the current PLAN has been reviewed and received Codex `PLAN_PASS`.

The normal PLAN path is therefore one compact `agy_start_plan`, one long-poll
`agy_wait`, and one compact `agy_review_plan`. A repeated wait is an exception
for a real transport interruption or a wait interval that actually expired.

A PLAN-bound worker is a **logical worker**, not necessarily one AGY provider turn. MCP may internally resume the same Antigravity conversation when a terminal AGY envelope reports retryable `agy_response_timeout`. Normal Codex orchestration should not see or manually service those provider-response checkpoints. Internal resumes must keep the same worker/conversation/PLAN and remain bounded by MCP safety limits.

MCP should surface an interruption to Codex only when the logical PLAN actually completes, hits a hard/non-retryable failure, is canceled, exhausts its bounded automatic recovery budget, stalls without meaningful progress, or reaches a lifecycle state that MCP cannot safely reconcile.

Do not orchestrate long work with shell sleeps, frequent `agy_status`, or model-driven timeout recovery loops.

## 6. Deterministic review evidence

Once the logical PLAN worker reaches a surfaced terminal state, call by default:

```text
agy_review_plan({
  runId,
  planId
})
```

The default review is intentionally summary-first and token-bounded. It supplies:

- logical worker terminal failure kind / retryability when relevant;
- automatic-resume metadata when available;
- whether any owned-path delta exists;
- changed files relative to the per-PLAN baseline;
- unauthorized changes;
- forbidden-scope changes;
- detected modification of pre-existing outside-scope user changes;
- canonical validation status;
- validation failure tail only when validation fails;
- explicit diff metadata.

The default tool output does **not** repeat the approved PLAN and does **not** include the owned-path diff. Codex already has the canonical PLAN in context and should inspect changed files directly for semantic review.

Request the bounded MCP diff only when it materially helps:

```text
agy_review_plan({
  runId,
  planId,
  includeDiff: true
})
```

If `diffTruncated` / `diffIncomplete` is true, inspect the listed changed files and targeted Git diff directly rather than repeatedly requesting the same large bundle.

Canonical validation is skipped when no executable command exists or when the PLAN has no owned-path delta. Successful validation stdout is suppressed. Failed validation returns only a bounded tail plus structured exit/timeout/cancel metadata.

## 7. Exceptional/manual recovery

`agy_followup({ resume: true })` remains a recovery escape hatch, but normal provider-response timeouts are handled inside the logical PLAN worker and should not require this call.

Use manual `resume:true` only when MCP has surfaced a terminal retryable interruption such as:

- automatic recovery budget exhausted;
- logical worker stalled and Codex has reviewed the existing workspace state;
- MCP/Codex restart left a persisted retryable turn requiring deliberate recovery;
- another unusual recoverable lifecycle state where resuming the same conversation is safer than starting over.

Before manual resume, review the PLAN delta. Then, if continuing unchanged is still correct:

```text
agy_followup({
  workerId,
  resume: true
})
```

MCP reconstructs the original approved PLAN and recovery policy server-side. Do not manufacture a fake finding describing an internal timeout, and do not repeat the PLAN text.

If concrete defects exist, use structured findings instead of `resume:true`.

For PLAN corrections, send only concise findings (`file`, optional `symbol`,
and a focused `problem`). Add `expected` or `rationale` only when they carry a
decision the server cannot infer. Do not repeat the blueprint, diff,
validation output, or the correction prompt; MCP reconstructs those parts.

## 8. Deep Codex semantic review

Codex should spend reasoning budget here. Review the actual code, not merely AGY's narrative.

The approved blueprint is an implementation contract for AGY; it is **not proof that the blueprint's architecture or assumptions were correct**. Review through two independent lenses:

1. **Implementation ↔ approved blueprint:** did AGY implement the bounded decisions it was given?
2. **Implementation ↔ repository reality/user intent:** does the resulting code actually work through the real control/data/runtime path and preserve the architecture, service/trust boundaries, authentication ownership, and behavior established by authoritative repository evidence?

Audit at minimum:

- implementation matches the approved PLAN intent and exact material decisions;
- naming and structure follow the proven precedents/conventions;
- the actual affected runtime/effect path reaches the intended result rather than merely compiling;
- configured destinations, routes, providers/proxies and authentication/trust boundaries line up when the task crosses those boundaries;
- no existing service/proxy/authentication/persistence boundary was silently bypassed just because the implementation is shorter;
- no invented helper/abstraction/API/DTO/schema pattern slipped in;
- null/error/loading/boundary behavior matches repository conventions and user intent;
- no missed edge case or regression in directly affected control/data flow;
- public contracts remain compatible unless explicitly approved otherwise;
- changed files and mechanical scope evidence are acceptable;
- pre-existing user changes remain preserved;
- validation result is real and relevant, while recognizing that compile success alone does not prove runtime integration correctness;
- no unrelated refactor, speculative cleanup, or scope expansion was introduced.

If repository evidence proves a material blueprint assumption wrong, do **not** grant `PLAN_PASS` merely because AGY implemented that assumption faithfully. Return `PLAN_BLOCKED`/re-plan when fixing it requires a new material decision, or `PLAN_FAIL` with concrete findings when the correct behavior was already determinable and remains inside approved authority.

Return one internal verdict:

- `PLAN_PASS`
- `PLAN_FAIL`
- `PLAN_BLOCKED`

## 9. Correction loop without PLAN duplication

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
3. repeat independent deep Codex review;
4. continue until `PLAN_PASS` or `PLAN_BLOCKED`.

A correction may address only concrete findings unless the approved PLAN itself requires a broader change. If the fix needs a new material decision, return to planning.

## 10. Final whole-blueprint audit

After all requested PLANs individually pass, Codex reviews the cumulative workspace against both the canonical blueprint and repository reality.

Retrace the **actual implemented runtime/effect path** from trigger/caller through every changed boundary to the intended observable effect. Do not assume PLAN-local PASSes prove cross-PLAN or cross-service correctness.

Verify:

- every requested PLAN is implemented;
- cross-PLAN contracts/data/control flow agree;
- cumulative behavior still matches user intent and authoritative repository architecture even if the blueprint made a mistaken assumption;
- configured destinations resolve to the process/service that actually owns the proposed route;
- cross-service routes exist or were created by the correct PLAN and downstream hops/authentication transformations remain intact;
- no PLAN-local shortcut introduced an integration, persistence, trust-boundary, authorization, lifecycle, or data-flow regression;
- final integration/build/test/manual verification required by the blueprint passes;
- compilation/build PASS is not treated as proof of a runtime path that was never traced;
- naming/convention consistency remains intact across PLAN boundaries.

Final verdict:

- `BLUEPRINT_PASS`
- `BLUEPRINT_FAIL`
- `BLUEPRINT_BLOCKED`

On `BLUEPRINT_FAIL`, route each concrete finding to the original owning worker using `agy_followup(findings)`, then re-review affected PLANs and repeat the final audit. Use the narrowest owning worker(s) necessary.

If the final issue requires a new unapproved material decision, return `BLUEPRINT_BLOCKED` and re-plan instead of granting AGY new authority.

## 11. Close and cleanup

Call `agy_close` only after `BLUEPRINT_PASS`, or when the user explicitly abandons the run.

After the last PLAN worker in a run is closed, MCP removes temporary baseline source snapshots while retaining bounded blueprint/run/worker audit metadata. Do not create commits/branches/merges unless separately requested.

A cleanup failure is not an implementation failure; report it separately.

## 12. Recovery after Codex/MCP restart

After restart:

- use `agy_status` once when persisted lifecycle state must be recovered;
- reuse the original `runId` and PLAN worker mapping when available;
- never create a duplicate worker merely because response text is no longer in MCP memory;
- inspect the persisted baseline delta before manual recovery of a surfaced retryable PLAN;
- resume corrections/recovery on the original worker/conversation;
- use the persisted PLAN baseline for review when available.

## 13. Final user report

Report compactly:

- blueprint/run executed;
- PLANs completed;
- affected files/change areas;
- validation performed;
- final whole-blueprint verdict;
- any genuine deviations, blockers, logical-worker recovery exhaustion/stall, or cleanup issues.

Do not dump worker transcripts or hidden reasoning. The source of truth is the user intent, authoritative repository evidence, reviewed workspace, canonical blueprint contract, and validation evidence.

# Antigravity Subagent for Codex

[![Release](https://img.shields.io/github/v/release/vacnex/codex-antigravity-subagent)](https://github.com/vacnex/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as a bounded implementation worker while Codex remains the planner and independent semantic/architecture reviewer.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI. This fork is based on the original project by [IlleJiViN](https://github.com/IlleJiViN/codex-antigravity-subagent).

## v0.5 architecture

```text
CODEX
repository understanding + planning + independent deep review
        │
        │ compact control calls
        ▼
MCP
blueprint capture + prompt construction + logical PLAN supervision
baselines + scope checks + direct validation + recovery mechanics
        │
        │ large implementation context
        ▼
AGY
implementation + code output + bounded corrections
```

The goal is **not** to starve Codex of useful repository input or review reasoning. The goal is to stop using expensive Codex output as a transport layer for text that already exists.

Codex may spend substantial input/reasoning budget reading the repository, tracing runtime behavior, making architecture decisions, and reviewing edge cases. The complete blueprint is generated once. MCP then copies/reconstructs repeated PLAN context with ordinary TypeScript and sends implementation context to Antigravity.

## Skills

The plugin bundles three related skills:

- `$execution-blueprint` inspects repository instructions/source/precedents, proves the affected runtime/effect path, applies relevant conditional planning checks, and produces one canonical implementation-ready `AGY_BLUEPRINT:v1`.
- `$execute-plan` supervises an approved READY blueprint: dependency ordering, one logical worker per PLAN, independent Codex semantic/architecture review, correction loops, final whole-blueprint audit, and cleanup.
- `$delegate-to-antigravity` manages standalone bounded AGY assignments outside an approved multi-PLAN blueprint workflow.

### Stable architecture, flexible implementation

Blueprint text does not need to be identical between two planning runs. What must remain stable are material repository invariants.

For every non-trivial task, `$execution-blueprint` traces the affected runtime/effect path far enough to prove that the proposed implementation can produce the requested result. It then applies only the conditional checks supported by repository evidence. A task may belong to several categories at once:

- integration/cross-service: configured destination, receiving process/service, route ownership, downstream hops, authentication/token transformation, proven sibling flow;
- database/data: source of truth, generated/schema ownership, cardinality/paging, transaction and mutation boundaries;
- UI/state: state owner, API/state flow, loading/error/lifecycle/stale-request behavior;
- async/jobs/events: producer, transport, consumer, retry/idempotency/failure behavior;
- security/trust: identity, authorization point, credential ownership, server-side validation, trust boundaries.

A shorter implementation must not silently remove or bypass an existing service, proxy, authentication, persistence, or trust boundary merely because fewer files look attractive.

## Canonical blueprint

`$execution-blueprint` renders the complete plan once between machine-readable markers:

```text
<!-- AGY_BLUEPRINT:v1:START -->
Blueprint status: READY
Blueprint depth: Standard Blueprint

Blueprint basis:
- Workspace: D:\src\example
- Git HEAD: abc123

## Implementation Tasks

### PLAN-01: ...
...
<!-- AGY_BLUEPRINT:v1:END -->
```

The blueprint stays human-readable in chat. It contains bounded write scope, forbidden scope, controlled reference/read context, concrete repository conventions, required behavior, validation, stop conditions, and the material runtime/integration path when relevant.

On the next user turn, `agy_start_plan` receives Codex's MCP `threadId` metadata, reads the local Codex rollout under `$CODEX_HOME`, extracts the latest complete canonical blueprint, and persists it. Codex does **not** send the full blueprint through a tool argument again.

> [!NOTE]
> Canonical transcript capture is intentionally a local Codex integration. It depends on Codex providing `threadId` MCP metadata and retaining the local rollout. If capture cannot be performed safely, execution fails clearly instead of asking Codex to regenerate the full blueprint into a tool call.

## MCP tools

v0.5 exposes nine tools:

| Tool | Purpose |
| --- | --- |
| `agy_check` | Verify AGY installation/capabilities and report MCP version |
| `agy_start` | Start one standalone bounded managed worker from a prompt |
| `agy_start_plan` | Start one approved PLAN without a PLAN/prompt argument |
| `agy_followup` | Continue a worker with structured findings; `resume=true` is exceptional/manual PLAN recovery |
| `agy_wait` | Passive completion barrier for the logical worker |
| `agy_review_plan` | Compact deterministic PLAN review/validation evidence; diff is opt-in |
| `agy_status` | Inspect lifecycle state when it is genuinely uncertain |
| `agy_cancel` | Interrupt an active worker turn |
| `agy_close` | Close a logical worker and retain audit metadata |

The v0.4 `agy_delegate` and `agy_result` tool surfaces are removed. Standalone bounded work uses `agy_start` + `agy_wait`; lifecycle snapshots use `agy_status` only when state is genuinely uncertain.

## Token-efficient PLAN execution

The first PLAN call is deliberately small:

```text
agy_start_plan({
  planId: "PLAN-01",
  cwd: "D:\\src\\example"
})
```

There is **no `prompt` field** in `agy_start_plan`.

MCP performs deterministic handoff work itself:

```text
threadId
  ↓
read Codex rollout
  ↓
capture canonical blueprint
  ↓
persist + parse PLAN
  ↓
capture write-scope baseline
  ↓
read approved source/reference files
  ↓
append static AGY execution policy
  ↓
build long prompt with TypeScript
  ↓
AGY input
```

Later tasks reuse the run:

```text
agy_start_plan({
  runId: "run_...",
  planId: "PLAN-02"
})
```

The run pins its workspace, canonical blueprint, Project/model/effort selections, baseline metadata, and worker-to-PLAN mapping. PLAN start acknowledgements include compact `workerId` and `runId` values needed for later control calls.

## Logical PLAN workers in v0.5.3

A PLAN worker is a logical worker, not necessarily one provider turn.

Antigravity can occasionally return a terminal `ERROR` containing `timeout waiting for response` after doing substantial work. In v0.5.2 that provider checkpoint was surfaced to Codex, which then reviewed the delta and explicitly resumed the same conversation. v0.5.3 moves the normal case into the deterministic layer:

```text
Codex
  ↓
agy_start_plan
  ↓
agy_wait
  ↓
MCP logical PLAN worker
  ├─ AGY process / turn #1
  │      ↓ response timeout
  ├─ relaunch same conversation internally
  ├─ AGY process / turn #2
  │      ↓ response timeout
  ├─ relaunch same conversation internally
  └─ AGY process / turn #3 → SUCCESS
  ↓
Codex receives logical completion
  ↓
agy_review_plan
```

Normal provider response-timeout checkpoints therefore do not require Codex to perform `review → resume → wait` orchestration.

Automatic recovery is bounded, not infinite:

- maximum 4 automatic conversation resumes per logical PLAN turn;
- maximum 30 minutes logical PLAN wall time;
- two consecutive response-timeout turns without stream progress surface `logical_plan_stalled`;
- hard/non-retryable errors, cancellation, transport timeout, conversation mismatch, or failed resume initialization still surface to the supervisor.

`agy_followup({ workerId, resume: true })` remains available for exceptional/manual recovery after a surfaced retryable interruption or restart. It is no longer the normal response to provider `agy_response_timeout`.

Standalone `agy_start` workers do not receive PLAN-specific automatic resume behavior.

## Controlled AGY context

Codex remains responsible for understanding the repository during planning. A PLAN identifies exact target files and proven reference/precedent files AGY needs.

MCP materializes bounded textual content from the PLAN's write targets and required read set into the AGY prompt. Large/binary/unavailable files are passed as exact references rather than blindly copied.

AGY is instructed to:

- implement the approved PLAN, not redesign it;
- modify only approved write scope;
- never write forbidden scope;
- start from supplied source/reference context;
- avoid repository-wide discovery and parent-drive searches;
- read an additional file only when it is a direct dependency needed for concrete approved implementation;
- stop as BLOCKED rather than inventing architecture, service topology, authentication boundaries, public contracts, DTO/schema decisions, naming conventions, or cross-module abstractions.

This read policy is a semantic boundary, not a claim that AGY is filesystem-sandboxed to those paths. The write boundary is independently checked after the logical turn.

## Deterministic review + independent Codex review

After the logical PLAN worker reaches a surfaced terminal state:

```text
agy_wait(workerId)
        ↓
agy_review_plan({ runId, planId })
        ↓
Codex independent semantic/architecture review
```

`agy_review_plan` is summary-first. By default it returns compact mechanical evidence:

- logical worker terminal failure kind/retryability when relevant;
- whether an owned-path delta exists;
- changed files;
- newly modified paths outside approved write scope;
- forbidden-scope changes;
- detected modification of pre-existing outside-scope user changes;
- canonical validation status;
- bounded validation failure tail only when validation fails;
- diff inclusion/truncation metadata.

The default result does **not** repeat the approved PLAN and does **not** include the owned-path diff. When a prepared bounded diff materially helps:

```text
agy_review_plan({
  runId: "run_...",
  planId: "PLAN-02",
  includeDiff: true
})
```

Successful validation stdout is suppressed. Validation is skipped when there is no executable command or no owned-path delta. Mechanical scope paths are normalized into execution-workspace coordinates even when the Git repository root is above the workspace.

### The blueprint is not proof

The approved blueprint is an implementation contract for AGY, not proof that the planner's assumptions were correct.

Codex reviews through two independent lenses:

```text
Implementation ↔ approved blueprint
Implementation ↔ repository reality / user intent
```

A faithfully implemented but architecturally wrong blueprint must not receive PASS. Codex retraces the actual affected control/data/runtime path, including configured destinations, routes, proxies/providers, authentication ownership, persistence/trust boundaries, and relevant edge cases. Compilation alone is not proof that an integration path exists at runtime.

The final whole-blueprint audit repeats this check against the cumulative implementation before `BLUEPRINT_PASS`.

## Corrections and exceptional recovery

Concrete findings are sent without repeating the PLAN:

```text
agy_followup({
  workerId: "agy_...",
  findings: [
    {
      file: "Services/FooService.cs",
      symbol: "Save",
      problem: "...",
      expected: "...",
      rationale: "..."
    }
  ]
})
```

MCP maps the worker back to its run/blueprint/PLAN, reconstructs the original contract plus correction policy, and sends the correction to the existing Antigravity conversation.

Manual recovery remains available when automatic logical-worker recovery is exhausted or another retryable lifecycle state is surfaced:

```text
agy_followup({
  workerId: "agy_...",
  resume: true
})
```

Review the existing workspace delta before manual resume. Do not manufacture fake findings merely to describe a timeout.

## Canonical validation

Canonical validation in v0.5.3 is a **direct executable invocation**, not a shell script. MCP tokenizes the command into executable + argv and calls the process with `shell=false`.

Example:

```text
"D:\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe" "PMT.HauGiang.Portal\PMT.HauGiang.Portal.csproj" /t:Build /p:VisualStudioVersion=18.0 /m
```

Rules:

- quote executable/argument paths containing whitespace;
- use one executable command;
- no `&&`, `||`, pipes, semicolon chaining, redirection, command substitution, or shell-variable expansion;
- prefer an existing repository build/test entry point when validation needs several internal steps.

This avoids Windows `cmd.exe` quoting behavior turning a valid path such as `D:\Microsoft Visual Studio\...\MSBuild.exe` into a fake executable name.

## Worker lifecycle

Persistent AGY workers use `stream-json` when supported. Managed starts/follow-ups return after stream handshake/turn registration while the logical worker continues in the background.

`agy_wait` remains the completion barrier:

```text
agy_wait(workerId, timeoutSeconds=900)
```

The waiter polls inside MCP, not through repeated Codex model turns. Its maximum interval is 1100 seconds, below the bundled MCP `tool_timeout_sec=1200`.

If a passive MCP wait interval expires while the logical worker is still running, the worker continues and can be awaited again. Provider response-timeout recovery happens internally and does not turn a healthy logical PLAN into routine Codex polling.

Passed PLAN workers remain open and idle until the final whole-blueprint audit so a cross-PLAN finding can be routed back to the original owning conversation. Close PLAN workers after `BLUEPRINT_PASS`.

## State and recovery

Worker metadata remains under:

```text
$CODEX_HOME/antigravity-subagent/workers
```

v0.5 additionally stores:

```text
$CODEX_HOME/antigravity-subagent/blueprints
$CODEX_HOME/antigravity-subagent/runs
```

Blueprint storage contains the canonical marked blueprint plus bounded metadata. Run storage contains execution identity, PLAN-worker mapping, and temporary per-PLAN baseline state.

To distinguish AGY changes from pre-existing user edits, PLAN execution may temporarily snapshot files inside approved write scope. Snapshots are size-bounded and local. After every worker in a run is closed, MCP removes temporary baseline source snapshots while retaining bounded blueprint/run/worker audit metadata.

New execution runs that never attach a worker because startup/handshake fails are automatically eligible for empty-run cleanup instead of accumulating indefinitely.

The worker ledger does not store prompts, responses, source code, or AGY tool output.

After MCP/Codex restart, open AGY workers can become recoverable. Persisted Antigravity `conversationId` values are reused for corrections/manual recovery, and the run retains PLAN mapping/baseline metadata when available.

## Typical workflow

```text
User: "lên kế hoạch"
        ↓
$execution-blueprint
        ↓
Codex reads repo + traces effect/runtime path
        ↓
conditional planning checks where applicable
        ↓
canonical blueprint printed once

User: "thực thi"
        ↓
$execute-plan
        ↓
agy_start_plan(PLAN-01)
        ↓
MCP captures blueprint + builds AGY prompt
        ↓
AGY logical PLAN worker
  ├─ provider timeout? → internal same-conversation relaunch/resume
  └─ logical completion
        ↓
agy_wait
        ↓
agy_review_plan
        ↓
Codex review:
  implementation ↔ blueprint
  implementation ↔ repository reality/user intent
        ↓
  PASS ───────────────→ next PLAN
  concrete FAIL ──────→ agy_followup(findings) → wait/review again
  exceptional retry ─→ agy_followup(resume=true) → wait/review again

all PLANs PASS
        ↓
Codex retraces cumulative actual runtime/effect path
        ↓
BLUEPRINT_PASS
        ↓
agy_close all PLAN workers
```

## Requirements

- Codex CLI or a supported local Codex desktop surface capable of running local MCP servers
- Node.js 20 or newer
- Google Antigravity CLI installed and authenticated as `agy`

```powershell
node --version
agy --version
```

## Install

```powershell
codex plugin marketplace add vacnex/codex-antigravity-subagent --ref main
```

Then open `/plugins`, install **Antigravity Subagent**, and start a new Codex session so the new skill/tool schemas are loaded.

To update:

```powershell
codex plugin marketplace upgrade antigravity-subagent
```

## Safety

The plugin starts the official local `agy` process and respects your Antigravity authentication/sandbox/permission configuration. It does not provide permission-bypass flags or a remote relay.

Do not delegate credentials, secrets, private customer data, destructive external operations, deployments, purchases, or messages unless that exact scope is intentionally authorized.

The plugin treats persisted AGY conversation IDs and local run metadata as an audit trail of visible activity, not access to hidden model chain-of-thought.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm ci
npm run verify
```

CI runs Node 20 and Node 24, type-checks, rebuilds the bundled MCP server, runs protocol/architecture regression tests, and verifies that `dist/server.cjs` is current.

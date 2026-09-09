---
name: execution-blueprint
description: >-
  Inspect the current repository and produce an implementation-ready execution blueprint before coding.
  Use when the user asks for a plan, blueprint, implementation plan, phased change plan, or wants Codex
  to analyze repository conventions and define bounded PLAN-XX tasks for later execution.
---

# Execution Blueprint

Codex owns repository understanding and material design decisions. This skill produces the canonical plan that a later `$execute-plan` run can execute with Antigravity workers without regenerating the PLAN text.

## 1. Planning responsibility

Before writing the blueprint, Codex should inspect enough authoritative repository evidence to make the implementation deterministic:

- applicable `AGENTS.md` / repository instructions;
- target files and symbols;
- direct dependencies and public contracts;
- nearest existing implementation patterns and naming conventions;
- validation/build/test commands appropriate to the affected area;
- user changes or constraints that must be preserved;
- user-provided external specifications/documents when they are needed to decide the implementation contract.

For every non-trivial task, trace the affected runtime/effect path far enough to prove that the proposed change can actually produce the requested result. Do not stop at the first compilable file boundary. Follow the real control/data path through the relevant caller, handler/controller, service/provider, persistence or process/service boundary, and final effect as applicable.

Classify the affected flow from repository evidence, not merely from ticket wording. Apply every relevant conditional planning check described below. A task may belong to multiple categories at once; a UI change can also be an integration/security task, and a backend change can also be a database/async task.

Do not delegate this planning pass to Antigravity. AGY is the implementation worker; Codex is the planner and later semantic reviewer.

Remove material choices from the executor, but do not waste output tokens by copying source files into the blueprint. Point to exact repository files/symbols and state the convention or decision that matters.

External files outside the workspace are **planning evidence only**. Codex may read them while planning, but must not put their absolute paths into `Write scope`, `Forbidden scope`, or `Required read set`. Distill every execution-relevant fact from such evidence into `Required conventions`, `Required changes`, `Implementation logic`, `Failure and boundary behavior`, `Acceptance criteria`, or `Stop if`. If an external specification contains details that cannot be captured precisely enough for deterministic execution, return `Blueprint status: BLOCKED` instead of expecting AGY to rediscover/read that external document.

## 2. Output language

Write explanatory content in the same primary language as the user's request. If the user writes in Vietnamese, write the blueprint content in Vietnamese.

Canonical field labels, PLAN IDs, marker comments, code identifiers, file paths, symbols, commands, API names, enum values, configuration keys, and established repository terminology are protocol/technical tokens and must remain exact rather than being translated.

## 3. Canonical blueprint markers

The implementation-ready blueprint must appear once in the assistant response and be enclosed exactly by:

```text
<!-- AGY_BLUEPRINT:v1:START -->
...
<!-- AGY_BLUEPRINT:v1:END -->
```

Do not repeat the marked canonical blueprint later in the same response. These markers allow the local MCP server to capture the already-rendered assistant output from the Codex thread on a later user turn, so Codex does not have to copy the blueprint into a tool call.

Do not call an MCP tool merely to save the blueprint. The user should see the full blueprint directly in chat.

## 4. Readiness and basis

A canonical blueprint begins with exactly one readiness line:

```text
Blueprint status: READY
```

or:

```text
Blueprint status: BLOCKED
```

Then one depth line:

```text
Blueprint depth: Lightweight Plan
Blueprint depth: Standard Blueprint
Blueprint depth: Full Blueprint
```

Then:

```text
Blueprint basis:
- Workspace: <absolute checkout root>
- Git HEAD: <sha or unavailable>
```

`Workspace` must be the absolute local checkout root that later execution is expected to modify. Do not substitute a repository URL or friendly project name here.

Use `BLOCKED` only when a material product/architecture/API/database/security/scope decision or prerequisite cannot be resolved safely from the user request and authoritative repository evidence.

Before `READY`, Codex must be able to explain from repository evidence why the proposed implementation path reaches the intended effect. A shorter or more reusable-looking design is not sufficient evidence by itself.

## 5. Implementation Tasks format

Every executable blueprint must contain:

```text
## Implementation Tasks
```

Each task must use:

```text
### PLAN-01: Short objective
```

PLAN IDs are stable and sequential. Dependencies are explicit. Each PLAN represents one bounded implementation responsibility suitable for one fresh worker.

For every PLAN, use all canonical `####` headings below exactly. Content may be in the user's language.

### Required PLAN schema

````markdown
### PLAN-01: <short objective>

#### Depends on
None

#### Goal
<what this PLAN must accomplish>

#### Write scope
- `relative/path/to/file`

#### Forbidden scope
None

#### Required read set
- `relative/path/to/reference` — <why this file/symbol is authoritative>

#### Required conventions
<exact naming/style/API/pattern decisions Codex confirmed from repository evidence>

#### Required changes
<observable code changes required>

#### Implementation logic
<logic/flow that is already decided and must not be redesigned by the worker>

#### Failure and boundary behavior
<error/null/boundary/compatibility behavior that must be preserved or added>

#### Acceptance criteria
<testable completion criteria>

#### Canonical validation
```text
<one executable direct command when appropriate>
```

#### Stop if
<conditions that require supervisor re-planning instead of worker inference>
````

For `Depends on`, use `None` or list PLAN IDs. For optional empty scopes, use exactly `None`.

### Execution-path contract

`Write scope`, `Forbidden scope`, and `Required read set` are machine-consumed execution path sections, not prose sections.

- Every entry in those sections must be a workspace-relative path wrapped in backticks.
- Never use an absolute path, `..` escape, drive path, UNC path, URL, friendly label, symbol description, or free-form prohibition in those sections.
- `Write scope` should be narrow and concrete; use a directory only when the approved change genuinely owns that directory. Avoid glob-heavy scopes.
- `Forbidden scope` contains only concrete files/directories that must not be touched. Semantic prohibitions such as “do not change generated EDMX”, “do not modify legacy methods”, “do not change database schema”, or product/API non-goals belong in `Required conventions`, `Failure and boundary behavior`, or `Stop if` unless there is a concrete workspace path to list.
- `Required read set` contains only workspace-local target/direct-dependency/proven-precedent files that AGY may inspect during execution. External user documents/specifications must be consumed by Codex during planning and distilled into the PLAN contract instead.

`Required read set` is controlled context, not write permission. Include enough workspace-local target/direct-dependency/precedent context for AGY to implement without rediscovering repository conventions. A worker may inspect a narrowly direct dependency only when implementation requires it, but it must stop rather than perform broad architecture discovery.

### Canonical validation command contract

`Canonical validation` is executed directly by MCP with `shell=false`. It is intentionally a small argv-style command language, not a shell script.

- Use one direct executable command, not prose mixed with a command.
- Quote every executable or argument path that contains whitespace.
- Shell composition/operators are not allowed: do not use `&&`, `||`, `|`, `;`, redirection, command substitution, or shell-variable expansion. If validation genuinely requires multiple commands or shell state, choose one existing repository test/build entry point that performs those steps or state the limitation in the PLAN instead of embedding a script.
- On Windows, an absolute executable path containing spaces must be double-quoted, for example:

```text
"D:\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe" "PMT.HauGiang.Portal\PMT.HauGiang.Portal.csproj" /t:Build /p:Configuration=Debug /p:VisualStudioVersion=18.0 /m
```

- Prefer a command whose exit code reliably expresses validation success/failure. Do not append extra diagnostic commands merely for narrative output.

## 6. End-to-end effect-path proof

For every non-trivial task, identify the real path from the changed trigger/caller to the requested observable effect. The depth depends on the task; do not turn a one-file pure function fix into an architecture expedition, but do not stop early merely because code compiles.

Examples:

- UI/state: user action → handler/composable → state/request → render/result.
- Backend: route/controller → service/domain logic → repository/provider → persistence/result.
- Integration: caller → HTTP/client wrapper → configured destination → receiving service/route → downstream proxy/provider → external effect.
- Async/job: scheduler/producer → queue/event → consumer → persistence/side effect.

When multiple PLANs implement different portions of one path, capture the cross-PLAN contract in `Implementation logic` / `Acceptance criteria` so each worker receives a bounded task while the complete blueprint preserves the full effect path.

## 7. Conditional planning checks

Apply these checks only when repository evidence shows they are relevant. Do not mechanically force every category onto every task.

### Integration / cross-service

When the runtime path crosses a process, service, HTTP, RPC, connector, or external-system boundary, verify before `READY`:

- the actual configured base URL/destination or resolver used by the caller;
- which process/service owns and receives that destination;
- that the proposed receiving route/handler exists or is explicitly created by an earlier PLAN;
- every required downstream hop to the intended external effect;
- where authentication/token/header transformation happens and which component owns credentials;
- the nearest proven end-to-end sibling flow in the repository.

A shorter implementation must not remove or bypass an existing service, proxy, authentication, persistence, or trust boundary unless authoritative repository evidence proves that boundary is intentionally unnecessary for the new flow. Reusing an existing helper/provider is encouraged only after this topology is proven.

When relevant, encode the proven topology and authentication ownership explicitly in `Required conventions` or `Implementation logic`; do not leave AGY to rediscover it.

### Database / data

When the task reads or writes persistent data, verify the source of truth, ownership of generated/schema artifacts, query scope/cardinality/paging, transaction or mutation boundaries, and the nearest repository precedent. Do not infer a Code First/schema change in a Database First/generated-model project without explicit evidence and approval.

### UI / state

When the task changes interactive state, verify component/composable ownership, API/state flow, loading/error/empty behavior, stale-request/lifecycle behavior when relevant, and the nearest established UI pattern.

### Async / jobs / events

When work crosses asynchronous boundaries, verify producer, transport/queue/event, consumer, retry/idempotency semantics, cancellation where applicable, and failure/dead-letter behavior already established by the system.

### Security / trust boundary

When identity, authorization, credentials, untrusted input, or cross-service trust is involved, verify caller identity, authorization point, credential/token ownership, server-side validation, and any boundary that must not be moved to the client or a less trusted component.

If an applicable conditional check cannot be resolved from authoritative evidence and materially affects correctness, return `Blueprint status: BLOCKED` rather than selecting the shortest plausible design.

## 8. Convention capture

Codex should spend input/reasoning budget where it improves correctness. Read the repository and state concrete conventions such as:

- exact existing method/component naming pattern;
- exact reference implementation to follow;
- existing request/response or DTO contract to preserve;
- established error/loading/null handling pattern;
- project-specific helpers/wrappers that must be reused;
- generated or forbidden artifacts that must not be edited;
- encoding/BOM/line-ending constraints when relevant;
- exact externally specified API fields/values/endpoint rules when an external document was part of planning evidence.

Do not merely say "follow project conventions" when Codex can identify the actual convention and precedent. Do not say “follow the external document” when that document is outside the workspace; encode the execution-relevant contract directly in the blueprint.

## 9. Executor authority boundary

A READY blueprint must leave AGY implementation work but not material design authority.

AGY may:

- read the supplied workspace-local target/reference files;
- inspect one direct dependency when necessary to implement an approved symbol;
- make bounded edits inside Write scope;
- run the supplied canonical validation;
- report a missing material decision as BLOCKED.

AGY must not be expected to choose a new architecture, public contract, DTO/schema shape, naming convention, cross-module abstraction, service topology, authentication boundary, or product behavior. Those belong in the blueprint.

## 10. Final integration verification

When multiple PLANs interact, include the integration behavior/validation in the relevant final PLAN acceptance criteria or describe it immediately after the PLAN list inside the canonical markers. The later execution workflow will also perform a whole-blueprint semantic audit independently from the blueprint's assumptions.

For cross-service/integration tasks, acceptance must prove that the route/control path resolves through the actual configured receiver(s), not merely that each project compiles independently.

## 11. Self-review before output

Before emitting `Blueprint status: READY`, verify:

- the workspace is correct and absolute;
- every PLAN has all canonical headings;
- PLAN dependencies reference real PLAN IDs;
- every Write/Forbidden/Required-read entry is a workspace-relative path and cannot escape the workspace;
- no external document path appears in any execution path section;
- external planning evidence has been distilled into a deterministic execution contract, or the blueprint is `BLOCKED` if that is not possible;
- Write scope and Forbidden scope do not conflict;
- Forbidden scope contains paths only; semantic non-goals/prohibitions are captured in semantic PLAN sections;
- Required read set gives the worker enough proven workspace-local context without inviting broad exploration;
- the affected end-to-end effect/runtime path has been traced far enough to prove the proposed implementation reaches the requested result;
- every applicable integration/database/UI/async/security conditional check has been resolved from repository evidence or the blueprint is `BLOCKED`;
- a shorter/reused implementation has not silently removed an existing service/proxy/authentication/persistence/trust boundary;
- conventions and public behavior are explicit enough to prevent invention;
- acceptance criteria and validation are concrete and capable of catching important runtime/integration mistakes that compilation alone cannot prove;
- every executable canonical validation command is one direct argv-style command, quotes paths containing whitespace, and contains no shell composition operators;
- Stop if catches missing material decisions;
- the blueprint contains no model/provider/effort selection, worker IDs, routing mechanics, worktree/branch policy, or repeated AGY boilerplate;
- the complete canonical blueprint appears only once between the exact v1 markers.

This skill defines WHAT is approved. `$execute-plan` defines HOW approved PLANs are orchestrated.

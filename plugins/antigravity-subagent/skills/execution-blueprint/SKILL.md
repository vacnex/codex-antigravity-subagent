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
<one executable shell-safe command when appropriate>
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

`Canonical validation` is executed by MCP, so when it contains a command it must be valid for the checkout's platform shell without relying on interactive shell state.

- Use one complete executable command, not prose mixed with a command.
- Quote every executable or argument path that contains whitespace.
- On Windows, an absolute executable path containing spaces must be double-quoted, for example:

```text
"D:\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe" "PMT.HauGiang.Portal\PMT.HauGiang.Portal.csproj" /t:Build /p:Configuration=Debug /p:VisualStudioVersion=18.0 /m
```

- Do not emit an unquoted form such as `D:\Microsoft Visual Studio\...\MSBuild.exe ...`; MCP rejects obvious unquoted Windows executable paths instead of running a misleading partial command.
- Prefer a command whose exit code reliably expresses validation success/failure. Do not append extra diagnostic commands merely for narrative output.

## 6. Convention capture

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

## 7. Executor authority boundary

A READY blueprint must leave AGY implementation work but not material design authority.

AGY may:

- read the supplied workspace-local target/reference files;
- inspect one direct dependency when necessary to implement an approved symbol;
- make bounded edits inside Write scope;
- run the supplied canonical validation;
- report a missing material decision as BLOCKED.

AGY must not be expected to choose a new architecture, public contract, DTO/schema shape, naming convention, cross-module abstraction, or product behavior. Those belong in the blueprint.

## 8. Final integration verification

When multiple PLANs interact, include the integration behavior/validation in the relevant final PLAN acceptance criteria or describe it immediately after the PLAN list inside the canonical markers. The later execution workflow will also perform a whole-blueprint semantic audit.

## 9. Self-review before output

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
- conventions and public behavior are explicit enough to prevent invention;
- acceptance criteria and validation are concrete;
- every executable canonical validation command is shell-safe for the target platform and quotes paths containing whitespace;
- Stop if catches missing material decisions;
- the blueprint contains no model/provider/effort selection, worker IDs, routing mechanics, worktree/branch policy, or repeated AGY boilerplate;
- the complete canonical blueprint appears only once between the exact v1 markers.

This skill defines WHAT is approved. `$execute-plan` defines HOW approved PLANs are orchestrated.

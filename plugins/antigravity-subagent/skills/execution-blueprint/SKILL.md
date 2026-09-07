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
- user changes or constraints that must be preserved.

Do not delegate this planning pass to Antigravity. AGY is the implementation worker; Codex is the planner and later semantic reviewer.

Remove material choices from the executor, but do not waste output tokens by copying source files into the blueprint. Point to exact files/symbols and state the convention or decision that matters.

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

```markdown
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
<one executable command when appropriate>
```

#### Stop if
<conditions that require supervisor re-planning instead of worker inference>
```

For `Depends on`, use `None` or list PLAN IDs. For optional empty scopes, use exactly `None`.

For file paths, prefer relative paths from the workspace root and wrap each path in backticks. `Write scope` should be narrow and concrete; use a directory only when the approved change genuinely owns that directory. Avoid glob-heavy scopes.

`Required read set` is controlled context, not write permission. Include the target files, direct dependencies, and proven precedent files that AGY needs to implement without rediscovering repository conventions. A worker may inspect a narrowly direct dependency only when implementation requires it, but it must stop rather than perform broad architecture discovery.

## 6. Convention capture

Codex should spend input/reasoning budget where it improves correctness. Read the repository and state concrete conventions such as:

- exact existing method/component naming pattern;
- exact reference implementation to follow;
- existing request/response or DTO contract to preserve;
- established error/loading/null handling pattern;
- project-specific helpers/wrappers that must be reused;
- generated or forbidden artifacts that must not be edited;
- encoding/BOM/line-ending constraints when relevant.

Do not merely say "follow project conventions" when Codex can identify the actual convention and precedent.

## 7. Executor authority boundary

A READY blueprint must leave AGY implementation work but not material design authority.

AGY may:

- read the supplied target/reference files;
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
- Write scope and Forbidden scope do not conflict;
- Required read set gives the worker enough proven context without inviting broad exploration;
- conventions and public behavior are explicit enough to prevent invention;
- acceptance criteria and validation are concrete;
- Stop if catches missing material decisions;
- the blueprint contains no model/provider/effort selection, worker IDs, routing mechanics, worktree/branch policy, or repeated AGY boilerplate;
- the complete canonical blueprint appears only once between the exact v1 markers.

This skill defines WHAT is approved. `$execute-plan` defines HOW approved PLANs are orchestrated.

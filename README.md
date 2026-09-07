# Antigravity Subagent for Codex

[![Release](https://img.shields.io/github/v/release/vacnex/codex-antigravity-subagent)](https://github.com/vacnex/codex-antigravity-subagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use your locally authenticated Google Antigravity CLI (`agy`) as a bounded implementation worker while Codex remains the planner and semantic reviewer.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with or endorsed by Google, Antigravity, or OpenAI. This fork is based on the original project by [IlleJiViN](https://github.com/IlleJiViN/codex-antigravity-subagent).

## v0.5 architecture

v0.5 is designed around a simple split of responsibility:

```text
CODEX
planning + repository understanding + deep review
        │
        │ small control calls
        ▼
MCP
blueprint capture + prompt construction + baselines + scope/validation mechanics
        │
        │ large context
        ▼
AGY
implementation + code output + corrections
```

The goal is **not** to starve Codex of useful repository input or review reasoning. The goal is to stop using expensive Codex output as a transport layer for text that already exists.

Codex may spend substantial input/reasoning budget reading the repository, identifying conventions, making architecture decisions, and reviewing edge cases. The complete blueprint is generated once. MCP then copies/reconstructs repeated PLAN context with ordinary TypeScript and sends the large implementation context to Antigravity.

## Skills

The plugin bundles three related skills:

- `$execution-blueprint` inspects repository instructions/source/precedents and produces a canonical implementation-ready `AGY_BLUEPRINT:v1` directly in Codex chat.
- `$execute-plan` supervises an approved READY blueprint: dependency ordering, one fresh worker per PLAN, Codex semantic review/correction loops, final whole-blueprint audit, and cleanup.
- `$delegate-to-antigravity` manages standalone bounded AGY assignments and the generic worker lifecycle.

### Canonical blueprint

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

The blueprint remains human-readable in chat. It contains bounded write scope, forbidden scope, controlled reference/read context, concrete repository conventions, required behavior, validation, and stop conditions.

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
| `agy_followup` | Continue a worker; PLAN workers can receive structured findings only |
| `agy_wait` | Long passive completion barrier inside MCP |
| `agy_review_plan` | Prepare deterministic PLAN review evidence and validation |
| `agy_status` | Inspect active/recoverable/closed worker state |
| `agy_cancel` | Interrupt an active worker turn |
| `agy_close` | Close a logical worker and retain audit metadata |

The v0.4 `agy_delegate` and `agy_result` surfaces are removed. Standalone bounded work uses `agy_start` + `agy_wait`; lifecycle snapshots use `agy_status`.

## Token-efficient PLAN execution

The first PLAN call is deliberately small:

```text
agy_start_plan({
  planId: "PLAN-01",
  cwd: "D:\\src\\example"
})
```

There is **no `prompt` field** in `agy_start_plan`.

MCP performs the expensive-looking but token-free deterministic work itself:

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

The run pins its workspace, canonical blueprint, Project/model/effort selections, baseline metadata, and worker-to-PLAN mapping.

## Controlled AGY context

Codex remains responsible for understanding the repository during planning. A PLAN should identify the exact target files and proven reference/precedent files AGY needs.

MCP materializes bounded textual content from the PLAN's write targets and required read set into the AGY prompt. Large/binary/unavailable files are passed as exact references rather than blindly copied.

AGY is instructed to:

- implement the approved PLAN, not redesign it;
- modify only the approved write scope;
- never write forbidden scope;
- start from supplied source/reference context;
- avoid repository-wide discovery and parent-drive searches;
- read an additional file only when it is a direct dependency needed for a concrete approved implementation;
- stop as BLOCKED rather than inventing architecture, public contracts, DTO/schema decisions, naming conventions, or cross-module abstractions.

This read policy is a semantic boundary, not a claim that AGY is filesystem-sandboxed to those paths. The write boundary is independently checked after the turn.

## Deterministic review + deep Codex review

After AGY completes a PLAN:

```text
agy_wait(workerId)
        ↓
agy_review_plan({ runId, planId })
        ↓
Codex deep semantic review
```

`agy_review_plan` prepares mechanical evidence from the per-PLAN baseline:

- actual owned-path delta;
- changed files;
- newly modified files outside approved write scope;
- forbidden-scope changes;
- detected modification of pre-existing outside-scope user changes;
- canonical validation result/output when the PLAN declares an executable command;
- bounded relevant diff with explicit truncation/incomplete flags.

MCP does **not** decide semantic correctness. Codex should still inspect the code deeply for naming/style conventions, invented abstractions, edge cases, public contract regressions, error/null/loading behavior, and blueprint compliance. If MCP truncates a diff, Codex should inspect the affected files directly rather than reducing review quality.

## Correction flow

When Codex finds a problem, it sends findings instead of repeating the PLAN:

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

MCP maps the worker back to its run/blueprint/PLAN, reconstructs the original execution contract plus static correction policy, appends Codex's findings, and sends that long correction prompt to the existing Antigravity conversation.

Codex can therefore make review findings as detailed as correctness requires without regenerating the original PLAN boilerplate.

## Worker lifecycle

Persistent AGY workers use `stream-json` when supported. Managed starts/follow-ups return after the stream handshake/turn registration while AGY continues in the background.

`agy_wait` remains the v0.5 completion barrier:

```text
agy_wait(workerId, timeoutSeconds=900)
```

The waiter polls inside the MCP process, not through repeated Codex model turns. Its maximum interval is 1100 seconds, below the bundled MCP `tool_timeout_sec=1200`. If the passive wait expires, the worker continues and can be awaited again.

Native MCP Tasks/subscription notifications are intentionally deferred until Codex host support is verified end-to-end.

Use stable idempotency keys for standalone starts/corrections. PLAN starts derive stable run/PLAN keys automatically.

Passed PLAN workers remain open and idle until the final whole-blueprint audit so an integration finding can be routed back to the original owning conversation. Close all PLAN workers after `BLUEPRINT_PASS`.

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

To distinguish AGY changes from pre-existing user edits, PLAN execution may temporarily snapshot files inside the approved write scope. Snapshots are size-bounded and local. After every worker in the run is closed, MCP removes temporary baseline source snapshots while retaining bounded blueprint/run/worker audit metadata.

The worker ledger still does not store prompts, responses, source code, or AGY tool output.

After MCP/Codex restart, open AGY workers can become recoverable. The persisted Antigravity `conversationId` is reused for corrections, and the run retains its PLAN mapping/baseline metadata when available.

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

## Typical workflow

```text
User: "lên kế hoạch"
        ↓
$execution-blueprint
        ↓
Codex reads repo + conventions
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
AGY implements
        ↓
agy_wait
        ↓
agy_review_plan
        ↓
Codex deep review
   ┌────┴────┐
 PASS       FAIL
  │           │
next PLAN  agy_followup(findings)
               ↓
            review again

all PLANs PASS
        ↓
Codex whole-blueprint audit
        ↓
BLUEPRINT_PASS
        ↓
agy_close all PLAN workers
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

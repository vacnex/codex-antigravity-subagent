# agy-orchestrator — design decisions

Status: draft, decisions agreed on 2026-10-04. Open questions at the bottom.

## Goal

Save Claude quota by delegating implementation to the Antigravity CLI (`agy`), whose
quota is broad. The main cost to avoid is the **rework loop**: agy writes code that runs
but is badly organized, Claude reviews, agy fixes, Claude reviews again.

## Roles

| Role | Who | Notes |
|---|---|---|
| Planner + reviewer | Claude (Claude Code) | Decisions, structure, final judgment |
| Executor | agy | Newest Gemini Flash only, default effort `high`. No review role, no Pro, no Claude models |
| Mechanics | runner script | Everything deterministic: spawn, retry, checks, state |
| Manual testing | the user | Follows the manual test checklist from the blueprint |

## Stack

- Claude Code plugin `agy-orchestrator`, commands `/agy-plan` and `/agy-go`.
- Runner: Node.js + TypeScript, bundled with esbuild into one committed file
  (`dist/agy-run.mjs`), no runtime dependencies. Tests with `node:test` and a fake agy.
- **No MCP.** Claude runs the runner via Bash with `run_in_background`; the harness
  wakes Claude when it exits. No wait/poll loop.

## Controlling agy

- Each agy turn is a new process: `agy --print <prompt> --output-format stream-json
  --mode accept-edits --model <flash> --effort <e> [--conversation <id>]`.
- Conversation context lives on the agy side; `state.json` stores each PLAN's
  `conversation_id`. Follow-ups and recovery reuse it.
- Runner handles provider timeouts / false `SUCCESS` by resuming the same conversation
  (bounded), logic carried over from the Codex version.
- Verified on 2026-10-04 with agy 1.2.16: `--print`, `json`, `stream-json` events
  (`init`, `step_update`, `result`), `--conversation` resume.

## Planning (`/agy-plan`)

See `skills/agy-plan/`. Key points:
- Plan lives in files: `.agy/runs/<run>/blueprint.md` + `PLAN-XX.md`. YAML frontmatter
  is the machine-readable part (`executor`, `depends_on`, `write`, `wiring`, `read_only`).
- No conventions file. Conventions = concrete precedent files near the change, named in
  the plan ("Làm theo mẫu"). Boundary = the working area; other modules are read-only.
- Placement map for every new public symbol; explicit reuse list of existing helpers.
- Public/shared contracts as code blocks with `file=`; the runner writes them to disk
  before agy starts.
- `executor: claude` for tricky core logic where delegating would cost more.
- No new test files. Existing build/test commands as regression checks; manual test
  checklist for the user.

## Task sizing

`/agy-plan` first judges the task size; same mechanism, different plan length:

| Size | Handling |
|---|---|
| Tiny (a few lines, one file) | Claude does it directly; delegating would cost more |
| Medium | Blueprint with a single short PLAN (still precedents + placement map) |
| Large | Blueprint with several PLANs and `depends_on` |

## Workspace mode: in place, with checkpoints

agy works directly in the user's current working tree, on the current branch.

- No stash, no worktree, no questions at start. Uncommitted user changes (WIP) stay in
  place and are visible to agy, exactly as they were to Claude while planning.
- PLANs run **sequentially** in `depends_on` order. No parallel execution in v1.
- Before each PLAN the runner records a **checkpoint**: a commit object built from a
  temporary index (`GIT_INDEX_FILE`), stored under `refs/agy/<run>/<PLAN>`. It never
  touches the user's working tree, index, stash or branch. The checkpoint is used to:
  - compute exactly what agy changed in that PLAN, separate from the user's WIP;
  - check scope (changes outside `write` + `wiring`);
  - roll back that PLAN only (restore the files agy changed), keeping WIP intact.
- Results stay uncommitted in the working tree; the user tests and commits as usual.
- Rule for the user: while agy runs, do not edit files in the running PLAN's `write`
  set. If they do, the runner detects it and reports instead of overwriting.
- Why not worktrees: they break projects that depend on untracked/ignored files (manual
  DLL references, `packages/`, local config), force a full restore/build, and add
  integration/landing steps. Worktrees may come back later as an opt-in for parallel
  PLANs.

## Execution (`/agy-go`) — option C: gate per dependency layer

```text
Layer 1: PLANs with no pending dependencies (run one after another)
   → checkpoint → agy implements (recon report → code → self-check → final report)
   → runner mechanical checks: scope (git diff), new files vs placement map, build
       fail → runner sends findings back to agy once, automatically
   → Claude reviews the whole layer once (summary first, diff only when needed)
       small issues → Claude fixes directly
       large issues → back to agy (max 1–2 rounds)
Layer 2..N: same
End: final review merged into the last layer's review; user tests manually
```

## Environment constraints

- Claude desktop on Windows can be MSIX-packaged: writes to `%LOCALAPPDATA%` from inside
  the app are virtualized. Therefore all orchestrator state lives in the repo under
  `.agy/` (excluded via `.git/info/exclude`), never in AppData.
- `agy-run check` must detect a virtualized agy copy shadowing the real install
  (agy self-updates could recreate one).

## Open questions

- Runner CLI surface and `state.json` shape.
- `/agy-go` skill content and the summary format Claude reads.

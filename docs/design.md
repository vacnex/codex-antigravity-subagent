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

- Each agy turn is a new process: `agy --input-format stream-json --output-format
  stream-json --mode accept-edits --disable-slash-commands --model <flash-slug>
  [--conversation <id>]`; the prompt goes in one NDJSON line on stdin (no command-line
  length limit) and agy exits after the turn.
- agy runs no shell commands: in `accept-edits` they are denied, and agy permissions can
  only be configured globally. The runner runs `validate` itself and feeds errors back.
- Conversation context lives on the agy side; `state.json` stores each PLAN's
  `conversation_id`. Follow-ups and recovery reuse it.
- Runner handles provider timeouts / false `SUCCESS` by resuming the same conversation
  (bounded), logic carried over from the Codex version.
- Verified on 2026-10-04 with agy 1.2.16: `--print`, `json`, `stream-json` events
  (`init`, `step_update`, `result`), `--conversation` resume.

## Entry points: skills and plan mode

- Two model-invoked skills; the user does not need slash commands:
  - `agy-plan` — triggered by "lên kế hoạch…", plan mode, or delegating to agy.
  - `agy-execute` — triggered by approving a blueprint, or asking to continue/fix a run.
- Plan mode integration via hooks (`hooks/hooks.json`):
  - `UserPromptSubmit` with `permission_mode == "plan"` → steer to the blueprint format.
  - `PostToolUse` on `ExitPlanMode` → after approval, tell Claude not to implement and
    to hand the plan file to `agy-run`. Payloads are logged to
    `$CLAUDE_PLUGIN_DATA/hook-payloads.jsonl` for diagnostics.
- Claude's diff pane shows agy's changes (it reads git). Claude's own rewind does not
  cover them; `agy-run undo` does.

## Planning (`agy-plan`)

See `plugins/agy-orchestrator/skills/agy-plan/`. Key points:
- One blueprint file (plan mode allows writing only the plan file). Machine-readable
  parts: one ```` ```yaml agy-blueprint ```` block (`validate`, `effort`) and per
  `## PLAN-XX: title` section a ```` ```yaml agy-plan ```` block (`executor`,
  `depends_on`, `write`, `wiring`, `read_only`). `agy-run import` copies it into
  `.agy/runs/<run>/blueprint.md`.
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
| Small (< ~150 changed lines, or 1–2 files) | Claude does it directly unless the user asks for agy |
| Medium (~150–400 lines) | Blueprint with a single PLAN (still precedents + placement map) |
| Large | Blueprint with several PLANs and `depends_on` |

Measured on 2026-10-04 with a demo todo CLI (Opus 5.5 planning/review, Gemini 3.8 Flash
medium implementing): tasks of +12, +116 and +201 lines cost Claude 13, 15 and 20 API
calls, about 1.5–2x what Claude doing the work itself would have cost. Two causes:
every call re-sends a ~60k+ token context, so the call count dominates; and the
blueprints were a third to three quarters the size of the diff, so little Claude output
was saved. Hence the threshold above, the "blueprint ≤ ~1/3 of the diff" rule in
`agy-plan`, and fewer runner round trips in `agy-execute`.

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

## Runner CLI (`agy-run`)

```text
check | import <file> | next | fix <PLAN> <findings.md> | undo <PLAN> | status | clean
```
- `next` accepts every PLAN in review, then runs all runnable PLANs (deps accepted),
  stopping at the review gate. Claude's loop is just `next` → review → `next`/`fix`/`undo`.
- Output is short plain text (cheaper than JSON for Claude); diffs, logs, agy reports
  and validate output are files in `.agy/runs/<run>/`.
- Exit codes: 0 ready for review / all done, 2 needs attention, 1 error.
- `state.json` is runner-internal: per-PLAN status, conversation id, checkpoint, counts,
  changed files (listed again on `ALL DONE`).
- Handled without Claude: agy ending its turn after the Recon report (one "continue"
  turn in the same conversation; still no report → needs attention), and `agy models`
  hanging (newest Flash cached per effort in `.agy/models.json` for 24 h; a stale cache
  is used when the lookup fails). Contracts are written all-or-nothing.
- Validation runs every command even after one fails, so the single auto-fix round
  gets all lint/typecheck/test errors at once (a TSDC run lost a round to lint-first).

## Execution (`agy-execute`) — option C: gate per dependency layer

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

- Verify the real `ExitPlanMode` hook payload (does it carry the plan file path?).
- Tune review depth vs quota after real runs.

---
name: agy-execute
description: Execute an approved agy blueprint with the agy-run runner and review agy's work layer by layer. Use right after the user approves a blueprint written by $agy-plan ("ok"/"chạy đi"/"thực thi" for a draft in .agy/drafts/), or when the user asks to continue, check, fix or undo an agy run.
---

# agy-execute

agy implements; you supervise and review. Do not implement agy PLANs yourself — that
burns the Codex usage this workflow exists to save. The runner does every mechanical
step.

## The runner command

The runner ships with this plugin. Call it as

```text
node <plugin-root>/dist/agy-run.mjs <command> [args]
```

where `<plugin-root>` is two directories above this SKILL.md (this file is at
`<plugin-root>/skills/agy-execute/SKILL.md`). Use the absolute path, with forward
slashes. Below, `agy-run` means that full command. Run it from the repository root.

**Sandbox:** agy needs the network, its `~/.gemini` state and its login, which Codex's
sandbox blocks. This plugin requires Codex with `sandbox_mode = "danger-full-access"`.
If `agy-run check` reports `agy is sandboxed`, stop and tell the user to switch Codex to
full access (the "Full access" permission mode, or `sandbox_mode = "danger-full-access"` in
`~/.codex/config.toml`), then retry.

**Shell:** on Windows commands run in PowerShell 5.1, which has no `&&`. Run runner
commands as separate calls unless this skill says otherwise.

## Waiting for agy (the expensive part)

Every tool call re-sends the whole context. `next` and `fix` run for minutes to tens of
minutes and print nothing until they finish, so wait with as few calls as possible:

1. Start the command with `exec_command`, `yield_time_ms: 30000`.
2. If it returns a `session_id` (still running), poll only with `write_stdin`,
   `chars: ""`, `yield_time_ms: 300000`. Repeat until the process exits. Each poll
   covers 5 minutes.
3. Do nothing else in between: no other commands, no reading `.agy/` files, no `status`.
   Before the first poll, tell the user in one line that agy is working.

## Start

1. `agy-run check` once per session. Stop and tell the user if agy is missing, not
   logged in, sandboxed, or a shadow copy warning appears.
2. `agy-run import <blueprint file>` — normally `.agy/drafts/<x>.md`. On
   `BLUEPRINT INVALID`, fix the file (it is yours) and import again.
3. `agy-run next`, waiting as above.

## Read the result

`next` / `fix` print a compact report and exit with:
- `0` — `READY FOR REVIEW` (or `ALL DONE`)
- `2` — `NEEDS ATTENTION`: a PLAN is `BLOCKED`, `FAILED`, `NEEDS-CLAUDE` (meaning: you
  implement it), or agy ended without a final report (`agy:UNKNOWN`) even after the
  runner told it to continue
- `1` — runner error (agy crash, login lost, git problem): report it to the user

Per PLAN you get: agy's status, changed files, scope and validate results, auto-fixes
already done, agy's own final report, and the path of the diff file.

## Review a layer (usage-aware)

For each PLAN in `REVIEW`:
1. Read the diff file once (`.agy/runs/<run>/PLAN-XX.diff`). For a very large diff,
   read new files and wiring edits first. Open full source files only when the diff
   lacks context you need.
2. Check against the PLAN, in this order — these are agy's typical failures:
   - placement: every new symbol where the Placement map says; no classes dumped into
     the file that happened to be open; files flagged "new files under a folder scope";
   - reuse: no re-implemented helper that exists (`rg` the name when in doubt); no
     private helper that belongs in a shared place;
   - no god class: logic split as planned, nothing piled into one service/controller;
   - conventions of the named precedents (naming, error handling, return types, DI);
   - gotchas and edge cases listed in the PLAN; wiring done exactly as described;
   - agy's report: "Needed but not created", deviations, notes.
3. Decide:
   - **Good** → nothing to do for this PLAN.
   - **Small issues** (a few lines in total) → fix them yourself with `apply_patch`.
     Cheaper than another agy round plus another review. Never rewrite source files
     with scripts. Afterwards `git diff --stat` must not list a whole file as changed
     (that means its line endings changed; put them back).
   - **Larger issues** → write `.agy/runs/<run>/PLAN-XX.findings.md` as a list of
     `file` / `symbol` / problem / expected, then `agy-run fix PLAN-XX <findings file>`
     (wait as for `next`). At most 2 fix rounds per PLAN; after that fix it yourself or
     ask the user.
   - **Wrong direction** → `agy-run undo PLAN-XX`, improve that PLAN's section in
     `.agy/runs/<run>/blueprint.md`, then `next` reruns it fresh.
4. When every PLAN of the layer is good, run `agy-run next` again. That accepts the
   layer and starts the next one (wait as above). If the report said **last layer**, it
   only accepts and returns at once; then run `agy-run clean`.

The runner already put back each modified file's own BOM and line endings when agy
changed them (`file format restored by runner`); do not re-check encodings by hand.
New files keep agy's format: if the project has a rule (`.editorconfig`, AGENTS.md),
check new files against it.

Scope violations and failed validation were already sent back to agy by the runner
(with the failure lines; a second round when the first one changed the errors). If they
persist, treat them as larger issues. `OUT OF SCOPE (agy or you)` may be the user's own
edits made during the run: ask before reverting files you did not plan.

**Validation still failing and the cause is not obvious from the report:** debugging in
this session is the most expensive thing in the run, because every attempt re-sends a
large context. Keep it bounded:
- Run only the failing command or test file, with output filtered to the failures;
  never insert debug prints into source or test files with scripts.
- After about 5 attempts without a clear cause, stop. If the failure is in a test that
  agy wrote and the feature itself looks right, remove or skip that test (say so) and
  move its scenario into the manual checklist; otherwise send what you learned to agy
  with `fix`, or ask the user.

## Needs attention

- `BLOCKED` — read agy's report. If the plan was missing a decision you can make,
  clarify that PLAN in the run's `blueprint.md`, `undo`, `next`. If the decision is the
  user's, ask them.
- `BLOCKED` with `contract file ... already exists` — the runner wrote nothing and agy
  did not run. Move that contract's signatures into the PLAN text of the run's
  `blueprint.md`, then `agy-run undo PLAN-XX` and `agy-run next`.
- `agy:UNKNOWN` — agy stopped without a report twice. Check the diff: if the work is
  complete, accept with `next`; otherwise send findings with `fix`.
- `FAILED` — agy crashed or timed out; partial changes are listed. Usually `undo` + `next`.
- `NEEDS-CLAUDE` — an `executor: claude` PLAN: implement it yourself from its section,
  then `agy-run next`.

## Finish

On `ALL DONE` (it lists `files changed by agy`):
1. Summarize for the user in a few lines: what each PLAN delivered, with the changed
   source files, anything you fixed yourself, anything left open.
2. Give the `## Checklist test tay` from the blueprint.
3. Remind them the changes are uncommitted in their working tree, for them to test and
   commit (`git diff` shows everything). To roll back a PLAN before `clean`, use
   `agy-run undo PLAN-XX`; after that, git.
4. Each task in a fresh chat costs less (context is re-sent on every call): suggest a
   new chat before the next feature.

## Never

- Never run git commands that change the user's index, stash, branches or commits.
- Never start `next`/`fix` while a previous one is still running.
- Never paste whole diffs or logs into chat; point to the files.

---
name: agy-execute
description: Execute an approved agy blueprint with the agy-run runner and review agy's work layer by layer. Use right after the user approves a blueprint written by agy-plan (plan mode approval, or "ok"/"chạy đi"/"thực thi" for a draft in .agy/drafts/), or when the user asks to continue, check, fix or undo an agy run.
argument-hint: "[blueprint file | run id]"
---

# agy-execute

agy implements; you supervise and review. Do not implement agy PLANs yourself — that
burns the Claude quota this workflow exists to save. The runner `agy-run` (on the Bash
PATH while this plugin is enabled) does every mechanical step.

## Start

1. `agy-run check` once per session if you have not yet. Stop and tell the user if agy is
   missing, not logged in, or a shadow copy warning appears.
2. `agy-run import <blueprint file>` — the plan mode plan file, or `.agy/drafts/<x>.md`.
   On `BLUEPRINT INVALID`, fix the file (it is yours) and import again.
3. Run `agy-run next` with the Bash tool using `run_in_background: true` and
   `timeout: 7200000`. Do not poll, sleep or call `status` while it runs: you are
   notified when it exits. Tell the user in one line that agy is working.

## Read the result

`next` / `fix` print a compact report and exit with:
- `0` — `READY FOR REVIEW` (or `ALL DONE`)
- `2` — `NEEDS ATTENTION`: a PLAN is `BLOCKED`, `FAILED`, or `NEEDS-CLAUDE`
- `1` — runner error (agy crash, login lost, git problem): report it to the user

Per PLAN you get: agy's status, changed files, scope and validate results, auto-fixes
already done, agy's own final report, and the path of the diff file.

## Review a layer (quota-aware)

For each PLAN in `REVIEW`:
1. Read the diff file once (`.agy/runs/<run>/PLAN-XX.diff`). For a very large diff,
   read new files and wiring edits first. Open full source files only when the diff
   lacks context you need.
2. Check against the PLAN, in this order — these are agy's typical failures:
   - placement: every new symbol where the Placement map says; no classes dumped into
     the file that happened to be open; files flagged "new files under a folder scope";
   - reuse: no re-implemented helper that exists (Grep the name when in doubt); no
     private helper that belongs in a shared place;
   - no god class: logic split as planned, nothing piled into one service/controller;
   - conventions of the named precedents (naming, error handling, return types, DI);
   - gotchas and edge cases listed in the PLAN; wiring done exactly as described;
   - agy's report: "Needed but not created", deviations, notes.
3. Decide:
   - **Good** → nothing to do for this PLAN.
   - **Small issues** (a few lines in total) → fix them yourself with Edit. Cheaper than
     another agy round plus another review.
   - **Larger issues** → write `.agy/runs/<run>/PLAN-XX.findings.md` as a list of
     `file` / `symbol` / problem / expected, then `agy-run fix PLAN-XX <findings file>`
     (background, same as `next`). At most 2 fix rounds per PLAN; after that fix it
     yourself or ask the user.
   - **Wrong direction** → `agy-run undo PLAN-XX`, improve that PLAN's section in
     `.agy/runs/<run>/blueprint.md`, then `next` reruns it fresh.
4. If the session can show the user a diff pane, open it on the changed files so the
   user can look along.
5. When every PLAN of the layer is good, run `agy-run next` again (background). That
   accepts the layer and starts the next one.

Scope violations and failed validation were already sent back to agy once by the
runner. If they persist, treat them as larger issues. `OUT OF SCOPE (agy or you)` may be
the user's own edits made during the run: ask before reverting files you did not plan.

## Needs attention

- `BLOCKED` — read agy's report. If the plan was missing a decision you can make,
  clarify that PLAN in the run's `blueprint.md`, `undo`, `next`. If the decision is the
  user's, ask them.
- `FAILED` — agy crashed or timed out; partial changes are listed. Usually `undo` + `next`.
- `NEEDS-CLAUDE` — an `executor: claude` PLAN: implement it yourself from its section,
  then `agy-run next`.

## Finish

On `ALL DONE`:
1. Summarize for the user in a few lines: what each PLAN delivered, anything you fixed
   yourself, anything left open.
2. Give the `## Checklist test tay` from the blueprint.
3. Remind them the changes are uncommitted in their working tree, for them to test and
   commit.
4. Run `agy-run clean` to remove the checkpoint refs.

## Never

- Never run git commands that change the user's index, stash, branches or commits.
- Never re-run `next` while a previous `next`/`fix` is still running.
- Never paste whole diffs or logs into chat; point to the files.

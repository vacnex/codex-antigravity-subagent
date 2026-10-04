---
name: agy-execute
description: Execute an approved agy blueprint with the agy-run runner and review agy's work layer by layer. Use right after the user approves a blueprint written by agy-plan (plan mode approval, or "ok"/"chạy đi"/"thực thi" for a draft in .agy/drafts/), or when the user asks to continue, check, fix or undo an agy run.
argument-hint: "[blueprint file | run id]"
---

# agy-execute

agy implements; you supervise and review. Do not implement agy PLANs yourself — that
burns the Claude quota this workflow exists to save. The runner `agy-run` (on the Bash
PATH while this plugin is enabled) does every mechanical step.

Every tool call re-sends the whole context, so the number of calls is what costs quota.
Chain runner commands in one Bash call where this skill says so, and never read a
background output file before its completion notification arrives.

## Start

1. One Bash call: `agy-run check && agy-run import <blueprint file>` (skip `check` if it
   already passed in this session). The blueprint is the plan mode plan file or
   `.agy/drafts/<x>.md`. Stop and tell the user if agy is missing, not logged in, or a
   shadow copy warning appears. On `BLUEPRINT INVALID`, fix the file (it is yours) and
   import again.
2. Run `agy-run next` with the Bash tool using `run_in_background: true` and
   `timeout: 7200000`. Do not poll, sleep, `cat` its output or call `status` while it
   runs: you are notified when it exits. Tell the user in one line that agy is working.

## Read the result

`next` / `fix` print a compact report and exit with:
- `0` — `READY FOR REVIEW` (or `ALL DONE`)
- `2` — `NEEDS ATTENTION`: a PLAN is `BLOCKED`, `FAILED`, `NEEDS-CLAUDE`, or agy ended
  without a final report (`agy:UNKNOWN`) even after the runner told it to continue
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
   - **Small issues** (a few lines in total) → fix them yourself with the Edit tool.
     Cheaper than another agy round plus another review. Never rewrite source files
     with python/sed/scripts: on Windows a text-mode write turns LF into CRLF and the
     whole file shows up as changed.
   - **Larger issues** → write `.agy/runs/<run>/PLAN-XX.findings.md` as a list of
     `file` / `symbol` / problem / expected, then `agy-run fix PLAN-XX <findings file>`
     (background, same as `next`). At most 2 fix rounds per PLAN; after that fix it
     yourself or ask the user.
   - **Wrong direction** → `agy-run undo PLAN-XX`, improve that PLAN's section in
     `.agy/runs/<run>/blueprint.md`, then `next` reruns it fresh.
   Write findings and run-blueprint edits with a Bash heredoc, not Write/Edit: the app's
   "Edited files" card lists only files Claude edits with those tools, so `.agy/` files
   there crowd out the real changes (which agy made outside Claude's tools).
4. When every PLAN of the layer is good, run `agy-run next` again. That accepts the
   layer and starts the next one (background). If the report said **last layer**, it
   only accepts: run `agy-run next && agy-run clean` in the foreground, in one call.

Scope violations and failed validation were already sent back to agy once by the
runner. If they persist, treat them as larger issues. `OUT OF SCOPE (agy or you)` may be
the user's own edits made during the run: ask before reverting files you did not plan.

## Needs attention

- `BLOCKED` — read agy's report. If the plan was missing a decision you can make,
  clarify that PLAN in the run's `blueprint.md`, `undo`, `next`. If the decision is the
  user's, ask them.
- `BLOCKED` with `contract file ... already exists` — the runner wrote nothing and agy
  did not run. Move that contract's signatures into the PLAN text of the run's
  `blueprint.md`, then `agy-run undo PLAN-XX && agy-run next` in one call (background).
- `agy:UNKNOWN` — agy stopped without a report twice. Check the diff: if the work is
  complete, accept with `next`; otherwise send findings with `fix`.
- `FAILED` — agy crashed or timed out; partial changes are listed. Usually `undo` + `next`.
- `NEEDS-CLAUDE` — an `executor: claude` PLAN: implement it yourself from its section,
  then `agy-run next`.

## Finish

On `ALL DONE` (it lists `files changed by agy`):
1. Show the diff: if `mcp__ccd_view__show_pane` exists (load it with ToolSearch
   `select:mcp__ccd_view__show_pane` when it is deferred), call it with
   `pane: "diff"`, `diff_scope: "uncommitted"` and `path` set to the main changed file.
2. Summarize for the user in a few lines: what each PLAN delivered, with the changed
   source files as links, anything you fixed yourself, anything left open.
3. Give the `## Checklist test tay` from the blueprint.
4. Remind them the changes are uncommitted in their working tree, for them to test and
   commit. Say that the app's "Edited files" card and its Undo cover only Claude's own
   edits, not agy's code: to roll back a PLAN use `agy-run undo PLAN-XX` (before
   `clean`) or git.
5. `agy-run clean` removes the checkpoint refs (already done if you chained it above).
6. Each task in a fresh session costs less (context is re-sent on every call): suggest
   a new session or `/clear` before the next feature.

## Never

- Never run git commands that change the user's index, stash, branches or commits.
- Never re-run `next` while a previous `next`/`fix` is still running.
- Never paste whole diffs or logs into chat; point to the files.

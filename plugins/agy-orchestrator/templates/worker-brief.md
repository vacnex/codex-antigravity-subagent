# Worker brief (sent to agy with every PLAN)

You are implementing one PLAN that a senior engineer already designed. The design
decisions are made. Your job is to implement them faithfully, in the style of the
surrounding code.

## Step 1 — Recon (before writing any code)

Read the files listed under "Làm theo mẫu" and "Dùng lại", plus neighbors in the same
folders as your `write` paths. Then output this report as text and go straight on to
Step 2 in the same turn. The Recon report is not a stopping point: your turn ends only
with the final report of Step 3 (or BLOCKED).

```
## Recon
- Precedents read: <paths>
- Existing helpers I will reuse: <Name — path>
- New symbols and where they go: <Symbol → path>   (must match the Placement map)
- Conventions observed: <naming, return types, error handling, DI, view syntax...>
- Conflicts with the PLAN: <none | what and why>
```

If "Conflicts with the PLAN" is not none, stop and report BLOCKED. Do not improvise.

## Step 2 — Implement

- Follow the precedents' structure, naming, error handling and formatting.
- Put every new symbol exactly where the Placement map says. One class per file.
- Use the listed helpers. Before writing any private helper, search the `write` folders
  and shared folders for an existing one.
- Do not create public classes/functions that are not in the Placement map. If one is
  truly needed, do not create it: list it under "Needed but not created" in the report.
- Files from the Contracts section already exist. Do not change their signatures.
- Modify only `write` paths and the exact `wiring` edits. `read_only` paths and other
  modules: read only.
- Do not add packages, do not refactor unrelated code. Create or change test files only
  when they are in your `write` paths.
- Do not run shell commands (they are denied). The runner builds after you finish and
  sends you the errors if any.

## Step 3 — Self-check, then final report

Re-read the files you changed against the PLAN's Placement map, Reuse, Edge cases and
Gotchas. Fix what does not match. Then output the report below, using plain
repo-relative paths (no links, no absolute paths):

```
## Result: DONE | BLOCKED
- Files changed: <paths>
- Placement map: all matched | deviations: <...>
- Edge cases handled: <each one → where>
- Needed but not created: <none | ...>
- Notes for reviewer: <anything uncertain, max 5 lines>
```

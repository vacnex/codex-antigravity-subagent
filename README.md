# agy orchestrator for Claude Code

Claude plans and reviews; the Antigravity CLI (`agy`, newest Gemini Flash) implements.
The goal is to save Claude quota: Claude spends it on decisions and review, agy on typing
code.

> Status: early (0.1.0). Design and decisions: [docs/design.md](docs/design.md).

## How it works

```text
"lên kế hoạch chức năng A"  (plan mode or not)
  → skill agy-plan: Claude maps the working area, picks precedents, writes one blueprint
  → you review it, approve (plan mode button) or say "ok"
  → skill agy-execute: agy-run import + agy-run next (background)
      per PLAN: checkpoint → agy implements → runner checks scope + build → auto-fix once
  → Claude reviews each dependency layer: accept, fix small things itself, or send findings
  → ALL DONE: changes are uncommitted in your working tree; test with the checklist, commit
```

- agy works **in place** on your current branch and sees your uncommitted changes.
- Before each PLAN the runner records a checkpoint (git objects only; your index, stash
  and branches are untouched), so a PLAN can be rolled back with `agy-run undo`.
- agy never runs shell commands; the runner runs the blueprint's `validate` commands.
- State lives in `.agy/` inside your repo (kept out of git via `.git/info/exclude`).

## Requirements

- Node.js 20+ and git on PATH.
- Antigravity CLI installed and logged in (`agy` once in a terminal).
  On Windows with the MSIX Claude desktop app, install agy from a terminal **outside**
  the app (see [docs/design.md](docs/design.md#environment-constraints)).

## Install (local)

```bash
claude plugin marketplace add <path-or-git-url-of-this-repo>
claude plugin install agy-orchestrator@agy-orchestrator
```

## Runner commands

```text
agy-run check | import <blueprint.md> | next | fix <PLAN> <findings.md> | undo <PLAN> | status | clean
```

## Layout

```text
plugins/agy-orchestrator/   the plugin (skills, hooks, templates, bin, dist/agy-run.mjs)
runner/                     TypeScript source and tests of agy-run (npm test)
docs/design.md              design decisions
```

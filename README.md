# agy orchestrator for Claude Code

Claude plans and reviews; the Antigravity CLI (`agy`, newest Gemini Flash) implements.
The goal is to save Claude quota: Claude spends it on decisions and review, agy on typing
code.

> Status: early (0.1.5). Design, decisions and measurements: [docs/design.md](docs/design.md).

> **This plugin lives on the `claude-code` branch.** The default branch `main` holds a
> different project and has no Claude Code marketplace, so every install command below
> pins `#claude-code` / `"ref": "claude-code"`.

## Install

### 1. Prerequisites

| Need | Check |
|---|---|
| Claude Code (terminal, desktop app or IDE extension) | `claude --version`, or the Code tab of the desktop app |
| Node.js 20+ | `node --version` |
| git | `git --version` |
| Antigravity CLI (`agy`), logged in | `agy --version`, then run `agy` once in a terminal and sign in |

Windows with the Claude desktop app (MSIX package): install and log in to agy from a
terminal **outside** the app. Installs made from inside the app land in a virtualized
AppData that other programs cannot see ([details](docs/design.md#environment-constraints)).

### 2. Add the plugin

Pick one way.

**A. Terminal (Claude Code CLI)**

```bash
claude plugin marketplace add vacnex/codex-antigravity-subagent#claude-code
```

```bash
claude plugin install agy-orchestrator@agy-orchestrator
```

**B. Settings file (works for the desktop app too)**

Merge this into `~/.claude/settings.json` (create the file if it does not exist; keep
any keys already there), then start a new session:

```json
{
  "extraKnownMarketplaces": {
    "agy-orchestrator": {
      "source": { "source": "github", "repo": "vacnex/codex-antigravity-subagent", "ref": "claude-code" }
    }
  },
  "enabledPlugins": {
    "agy-orchestrator@agy-orchestrator": true
  }
}
```

**C. From a local clone (for developing the plugin)**

```bash
git clone -b claude-code https://github.com/vacnex/codex-antigravity-subagent.git
```

```bash
claude plugin marketplace add ./codex-antigravity-subagent
```

```bash
claude plugin install agy-orchestrator@agy-orchestrator
```

A marketplace added from a local directory loads the plugin files in place: edits take
effect in the next session, no version bump needed.

### 3. Verify

In a new session, inside any git repository:

- the skills `agy-orchestrator:agy-plan` and `agy-orchestrator:agy-execute` are listed
  (ask "what skills do you have?", or `claude plugin list` in a terminal);
- `agy-run check` (run through Claude, or in a shell where the plugin's `bin/` is on
  PATH) prints the agy path, version, newest Flash model and the repo root, with no
  warning.

### Update

Installs from GitHub (A and B) use a cached copy. To get a newer version:

```bash
claude plugin marketplace update agy-orchestrator
```

or turn on auto-update for the marketplace under **Marketplaces** in `/plugin`. A new
copy is picked up only when `version` in `plugins/agy-orchestrator/.claude-plugin/plugin.json`
changes, so every release bumps it.

### Uninstall

```bash
claude plugin marketplace remove agy-orchestrator
```

This also uninstalls the plugin. If you used way B, remove the two entries from
`~/.claude/settings.json` as well.

## Codex version (branch `codex-revisited`, experimental)

The same workflow for the Codex CLI / Codex app: plugin `agy-orchestrator-codex`, skills
`$agy-plan` and `$agy-execute`, the same runner. No MCP server. Codex must run with
**full access** (`sandbox_mode = "danger-full-access"`), because agy needs the network,
`~/.gemini` and its login, which Codex's sandbox blocks. Background:
[docs/codex-port.md](docs/codex-port.md).

```bash
codex plugin marketplace add vacnex/codex-antigravity-subagent --ref codex-revisited
```

```bash
codex plugin add agy-orchestrator-codex@agy-orchestrator
```

## For AI agents installing this plugin

If a user asks you to install this plugin from this repository:

1. Check the prerequisites in step 1. If agy is missing or not logged in, ask the user
   to install it and run `agy` once in their own terminal; do not install it from inside
   a sandboxed or MSIX-packaged app.
2. If the `claude` CLI is on PATH, run the two commands of way A. Otherwise apply way B:
   read `~/.claude/settings.json` first and merge the two keys into it without removing
   anything; never overwrite the file.
3. Always pin the branch `claude-code`. Adding the repository without it fails, because
   `main` has no `.claude-plugin/marketplace.json`.
4. Tell the user to start a new session, then verify as in step 3.

## Usage

Ask for a plan in your own words, in plan mode or not, for example
"lên kế hoạch thêm lệnh export CSV cho trang báo cáo". Then:

```text
skill agy-plan     Claude reads the working area, sizes the task:
                   small (< ~150 lines) → Claude just does it, no agy
                   otherwise            → one blueprint file with PLANs (precedents,
                                          placement map, edge cases, manual test checklist)
you                read the blueprint; approve (plan mode button) or say "ok"
skill agy-execute  per PLAN: checkpoint → agy implements and runs the validate commands
                   → runner checks scope, restores file formats, re-runs validate,
                     sends failures back to agy (up to 2 auto-fix rounds)
                   → Claude reviews each dependency layer: accept, fix small things,
                     or send findings to agy
ALL DONE           changes are uncommitted in your working tree; the diff pane opens;
                   test with the checklist, then commit yourself
```

Good to know:

- agy works **in place** on your current branch and sees your uncommitted changes.
  Commit or stash unrelated work first if you want a clean diff.
- Before each PLAN the runner records a checkpoint (git objects only; your index, stash
  and branches are untouched), so a PLAN can be rolled back with `agy-run undo PLAN-XX`.
  The app's "Edited files" card and its Undo cover only Claude's own edits, not agy's.
- agy may run only the blueprint's `validate` commands, exactly as written.
  `agy-run import` adds allow rules for them to `~/.gemini/antigravity-cli/settings.json`
  and keeps them. Every other shell command is denied.
- Automated tests are not written by default; you test with the manual checklist.
  Ask for tests explicitly if you want them (pure logic with an existing example only).
- State lives in `.agy/` inside your repo (kept out of git via `.git/info/exclude`).
- Each feature in a fresh session (or after `/clear`) costs less Claude quota.

When it pays off: measured on a real project, agy saved about 35–40% of Claude quota on
a ~1,700-line full-stack feature, broke even around 450 lines, and cost more below
that. See [Task sizing](docs/design.md#task-sizing).

## Runner commands

Claude runs these for you; they are listed for debugging.

```text
agy-run check                         verify agy, login, newest Flash model, repo
agy-run import <blueprint.md>         create a run from a blueprint file
agy-run next                          accept PLANs under review, run the next runnable PLANs
agy-run fix <PLAN> <findings.md>      send review findings to the PLAN's agy conversation
agy-run undo <PLAN>                   roll back a PLAN's changes to its checkpoint
agy-run status                        show the run
agy-run clean                         delete checkpoint refs of a run
```

Exit codes: `0` ready for review / all done, `2` needs attention, `1` error.

## Layout

```text
.claude-plugin/marketplace.json   the marketplace (one plugin)
plugins/agy-orchestrator/         the plugin: skills, hooks, templates, bin, dist/agy-run.mjs
runner/                           TypeScript source and tests of agy-run
docs/design.md                    design decisions and measurements
```

## Develop

```bash
cd runner && npm install && npm test
```

`npm test` rebuilds `plugins/agy-orchestrator/dist/agy-run.mjs` (commit it; installs use
the built file) and runs the runner tests against a fake agy. Bump `version` in
`plugins/agy-orchestrator/.claude-plugin/plugin.json` for every release.

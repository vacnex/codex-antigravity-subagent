# Porting agy-orchestrator to Codex (branch `codex-revisited`)

Goal: the same design as the Claude Code plugin (skills + the shared `agy-run` runner),
with no MCP server, unlike the v0.5 Codex plugin on `main`.

## Why `main` needed an MCP server and Claude Code does not

1. **Waiting.** Claude Code runs `agy-run next` with `run_in_background` and is woken
   when it exits, at zero model calls while waiting. Codex is not woken when a process
   ends; `main` therefore blocked inside a long MCP tool call (`agy_wait`, 2000 s).
2. **Sandbox.** Codex runs commands in a sandbox by default; agy cannot work there (see
   experiment 2–3). MCP servers run outside the sandbox.

## Experiments (2026-10-04, Codex CLI 0.153.4, Windows, model gpt-5.6-luna low)

| # | Setup | Result |
|---|---|---|
| 1 | `exec_command` (`yield_time_ms` 10000) on a script silent for 200 s, then `write_stdin` empty polls with `yield_time_ms` 300000 | Finished with **1** poll; 3 model calls, ~57k input (41k cached), 408 output |
| 2 | `-s workspace-write`, run `agy models` | Fails: network blocked (`connectex ... forbidden by its access permissions`) |
| 3a | as 2 plus `sandbox_workspace_write.network_access=true` | Still fails: `~/.gemini/...: Access is denied` and `You are not logged into Antigravity` (sandbox cannot read agy's state/credentials) |
| 3b | as 2, `require_escalated` with `approval_policy="on-request"` in `codex exec` | Refused: exec runs with approval policy Never |
| 4 | as 2 plus `~/.codex/rules/x.rules`: `prefix_rule(pattern = ["agy", "models"], decision = "allow")` | **Works**: runs unsandboxed, no approval, even in `codex exec` |
| 5 | rule `prefix_rule(pattern = ["node", "<abs>/dist/agy-run.mjs"], decision = "allow")`, run `node <abs>/dist/agy-run.mjs check` from `D:\repo\TSDC` | **Works**: agy found, newest Flash resolved, repo detected |

Notes:
- Commands run through PowerShell (`powershell.exe -Command '...'`); the rule still
  matches the inner command. The user's PowerShell profile prints a harmless
  `Get-Command claude` error first.
- `write_stdin` empty polls wait 5–300 s; `exec_command` yields after at most 30 s on
  Windows.

## Resulting design

- **Shared core**: `runner/` builds `agy-run.mjs`, used by both plugins.
- **Codex plugin** `plugins/agy-orchestrator-codex/`: `.codex-plugin/plugin.json`,
  skills `agy-plan` / `agy-execute` (+ `agents/openai.yaml`), listed in
  `.agents/plugins/marketplace.json` next to `.claude-plugin/marketplace.json`.
- **Unsandboxed runner**: a one-time setup writes
  `~/.codex/rules/agy-orchestrator.rules` with
  `prefix_rule(pattern = ["node", "<plugin>/dist/agy-run.mjs"], decision = "allow")`.
  agy itself is a child of the runner, so it runs unsandboxed too. Only that exact
  script is allowed.
- **Waiting**: `agy-run next` via `exec_command` (`yield_time_ms` ~30000), then
  `write_stdin` empty polls with `yield_time_ms` 300000. The runner prints nothing until
  it finishes, so each poll lasts the full 5 minutes: about one model call per 5 minutes
  of agy work (Claude Code: zero; `main`: one per ~33 minutes, at the cost of an MCP
  server).
- Claude-only pieces to drop or replace: `ExitPlanMode` hook, diff pane,
  `AskUserQuestion` (→ `request_user_input`), "Edited files" card notes.

## Open

- Codex plan mode output shape (`main` saw a `<proposed_plan>` wrapper).
- Whether a plugin can ship the rules file itself, or setup must write it.
- Whether plugin script directories are put on PATH (otherwise use the absolute
  `node <plugin>/dist/agy-run.mjs` path, which the rule needs anyway).

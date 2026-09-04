# Security policy

## Trust model

This plugin launches the official Google Antigravity CLI as a local child process. It does not proxy requests through a project-owned server. Antigravity receives the delegated prompt and operates under the user's existing Antigravity authentication, settings, permissions, and sandbox.

The `agy_delegate` MCP tool is marked as potentially destructive because `default` and `accept-edits` modes can modify workspace files. Managed workers created by `agy_start` default to `accept-edits` for implementation workflows; callers should use `plan` for read-only work and independently review delegated changes.

The server does not expose arbitrary extra CLI arguments or the `--dangerously-skip-permissions` flag. Managed responses are bounded before returning to Codex, and successful stream progress is summarized instead of copying raw text/tool/subagent payloads into the model context.

## Persistent worker state

Managed worker metadata is stored locally so workers can survive Codex or MCP restarts. The ledger stores identifiers, workspace/configuration metadata, lifecycle/timestamp data, last execution metadata, and bounded token-usage counters. It does not store delegated prompts, Antigravity response text, source code, diffs, or raw tool/subagent payloads.

The default worker-state directory is `$CODEX_HOME/antigravity-subagent/workers` or `~/.codex/antigravity-subagent/workers`, with `AGY_MCP_STATE_DIR` available as an override. Protect this directory according to the sensitivity of workspace paths, conversation IDs, and local project metadata in your environment.

Cross-process worker ownership uses local lease files with an MCP owner identifier, process PID, and expiry. Warm workers refresh their lease periodically. Stale leases are reclaimed using an exclusive reclaim marker so two MCP processes do not intentionally drive the same worker at once. Leases reduce accidental concurrent control but are not a security boundary against another process running with the same OS account and filesystem permissions.

## Process lifecycle and cancellation

When supported by the installed AGY CLI, managed workers keep one `stream-json` child process warm across turns. A restarted MCP process recovers the logical worker from the local ledger and resumes the exact saved Antigravity conversation with a new process.

Cancellation first requests a graceful process interrupt and then uses a platform-specific process-tree termination fallback when necessary. Canceled or timed-out workers remain logically recoverable unless explicitly closed.

## Supported versions

Only the latest release is supported. Reproduce security issues against the newest release before reporting them.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** flow for this repository. Include the affected version, operating system, Node.js version, Antigravity CLI version, reproduction steps, and impact.

Do not include credentials, private prompts, customer data, proprietary source code, conversation contents, or sensitive worker-ledger files in the report.

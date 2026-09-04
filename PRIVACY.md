# Privacy Policy

Last updated: September 4, 2026

Antigravity Subagent is an independent open-source project based on the original project by IlleJiViN and maintained in this fork by vacnex. The project does not operate a hosted service, collect telemetry, create user accounts, or persist delegated prompts, Antigravity responses, source code, or tool output in its own worker ledger.

The plugin runs on the user's machine. When a user delegates a task, the local Google Antigravity CLI may process the prompt, workspace path, and files it is permitted to read. That processing is governed by the user's Antigravity configuration, Google account, permissions, and Google's applicable privacy terms. OpenAI and Codex may process plugin instructions and results under the terms applicable to the user's OpenAI account.

For managed workers, the plugin persists a small local metadata ledger so workers can be inspected and recovered after Codex or MCP restarts. Records may include the worker and Antigravity conversation identifiers, friendly worker name, workspace path, selected model and effort, execution mode, timestamps, lifecycle state, last transport/PID, turn counts, bounded token-usage metadata, timeout/cancellation flags, and lease metadata used for cross-process coordination. The ledger does not store delegated prompt text, Antigravity response text, source code, diffs, or tool/subagent payloads.

By default, worker metadata is stored under `$CODEX_HOME/antigravity-subagent/workers` or `~/.codex/antigravity-subagent/workers`. Users may override this location with `AGY_MCP_STATE_DIR`. Closed worker records are retained locally as an audit index until the user removes them.

The project itself does not receive or retain this local data. Local process output is returned to the active Codex session and is not separately transmitted to the project maintainer.

Users should not delegate passwords, API keys, credentials, regulated data, confidential customer information, or other sensitive material unless they have independently confirmed that their local configuration and provider terms permit it. Workspace paths and model/session metadata may themselves be sensitive in some environments, so users should protect the local worker-state directory accordingly.

Questions or privacy requests may be submitted through the project's public support channel:
https://github.com/vacnex/codex-antigravity-subagent/issues

# Changelog

## Unreleased - 0.4.0

- Add persistent `stream-json` managed workers that reuse one warm AGY process across successful follow-up turns when the installed CLI supports stream input/output.
- Add a persistent per-worker ledger outside the plugin installation directory, storing bounded worker metadata without prompts, responses, source code, or tool output.
- Recover open workers after Codex/MCP restart and resume the exact saved Antigravity `conversation_id` with a new process.
- Add cross-process worker leases with PID/expiry-based stale lease reclamation and heartbeat refresh for warm workers.
- Add friendly worker names to `agy_start` and persist them in the local audit ledger.
- Add `agy_status` for active, recoverable, and closed worker lifecycle inspection.
- Add `agy_cancel` and propagate MCP request cancellation into persistent and one-shot AGY processes while preserving recoverable conversations.
- Add warm-driver idle cleanup so unused AGY processes can be released without closing logical workers.
- Add short-lived executable, capability, and model-catalog caches plus `agy_check(refresh=true)`.
- Add per-turn `turnUsage` deltas while retaining cumulative `sessionUsage` and backward-compatible `usage` metadata.
- Summarize stream progress activity without copying text deltas, tool payloads, or subagent payloads into Codex context.
- Add regression coverage for stream parsing, one-shot cancellation, persistent-driver cancellation, worker ledger/lease semantics, warm PID reuse, and real MCP restart/recovery with the authenticated AGY CLI.

## 0.3.0 - 2026-09-04

- Add resumable managed workers with `agy_start`, `agy_followup`, and `agy_close`.
- Preserve Antigravity `conversation_id` values so delegated sessions remain auditable with `/resume` or `agy --conversation <id>`.
- Add MCP elicitation for Antigravity model and reasoning effort when they are not supplied explicitly.
- Group effort-suffixed Antigravity model variants into base-model choices and resolve the selected effort to the matching CLI slug.
- Add structured Antigravity JSON result parsing with status, duration, turns, and token-usage metadata.
- Limit model responses returned to Codex to 64 KiB, cap stderr diagnostics, and suppress successful stderr output.
- Expand `agy_check` to probe Antigravity CLI version, required headless flags, resumable conversations, and model catalog availability.
- Add compatibility fallbacks for Antigravity model-catalog command variants.
- Keep the fallback runner aligned with managed-worker model, effort, and conversation behavior.
- Add protocol and real-CLI smoke coverage for start, follow-up, close, capability reporting, and model/effort resolution.

## 0.2.0 - 2026-08-01

- Add the `agy_check` and `agy_delegate` stdio MCP tools.
- Add the `$delegate-to-antigravity` Codex skill.
- Default delegation to `plan` mode.
- Add bounded timeouts and output capture.
- Bundle the Node.js runtime artifact for installation without `npm install`.
- Add GitHub marketplace packaging, CI, installation guidance, and security documentation.

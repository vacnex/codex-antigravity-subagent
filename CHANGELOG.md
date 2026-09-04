# Changelog

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

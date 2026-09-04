# Changelog

## 0.4.1 - 2026-09-04

- Change persistent managed `agy_start` to return after the AGY stream init/conversation handshake and durable `state=running` registration, while the long first turn continues in the background.
- Change managed `agy_followup` to launch correction turns in the background as well, avoiding another long blocking MCP call.
- Add read-only `agy_result` for current/final managed-turn state without submitting a new prompt. Final response text stays in MCP memory only; the durable ledger still stores no prompt/response content.
- Add stable `idempotencyKey` support for starts and follow-ups so retrying a lost/uncertain tool response reuses the same logical work instead of spawning duplicate Antigravity conversations.
- Persist the worker/conversation and active-turn metadata before sending a persistent-stream prompt, eliminating the late-registration race that could make `agy_status` temporarily report no worker after a client timeout.
- Recover stale persisted running turns as `INTERRUPTED`/`recoverable` after an MCP restart instead of reporting a ghost running process.
- Extend `agy_status` with active/last turn keys, timeout/cancel/error metadata, compact progress, result availability, and duplicate-worker detection.
- Raise the bundled Codex MCP `tool_timeout_sec` to 1200 seconds as a compatibility hotfix for legacy blocking AGY paths and explicit one-shot delegation.
- Update the delegation skill to use background result/status flow, stable retry keys, explicit cancellation after launch, and to avoid wait loops whose only purpose is keeping a long MCP call alive.
- Expand driver/store/real-MCP smoke coverage for the init handshake, pre-launch running ledger state, start/follow-up deduplication, `agy_result`, restart recovery, and response-not-persisted behavior.

## 0.4.0 - 2026-09-04

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

# Changelog

## 0.5.3 - 2026-09-09

- Treat PLAN-bound Antigravity work as a logical worker across provider response-timeout checkpoints. Retryable `timeout waiting for response` envelopes are handled inside the persistent driver by relaunching the same Antigravity `conversationId` and continuing the approved PLAN instead of routinely waking Codex for `review → resume → wait` orchestration.
- Bound logical PLAN recovery to four automatic conversation resumes, 30 minutes of logical wall time, and a no-progress stall guard. Two consecutive response-timeout turns without stream progress surface `logical_plan_stalled`; exhausted recovery surfaces `logical_plan_recovery_exhausted`. Standalone `agy_start` workers do not receive PLAN-specific automatic resume behavior.
- Harden `$execution-blueprint` with a generic end-to-end runtime/effect-path proof for every non-trivial task, plus conditional integration, database/data, UI/state, async/job/event, and security/trust-boundary checks that apply only when repository evidence makes them relevant.
- Require integration/cross-service planning to resolve the actual configured destination, receiving process/service and route, downstream hops, authentication/token ownership, and a proven sibling flow. A shorter implementation may not silently remove an existing service/proxy/authentication/persistence/trust boundary without authoritative repository evidence.
- Strengthen `$execute-plan` semantic review so an approved blueprint is treated as AGY's implementation contract rather than proof that its architecture was correct. PLAN and final whole-blueprint review now compare implementation both with the blueprint and independently with repository reality/user intent, retracing the actual runtime/effect path before PASS.
- Replace shell-based canonical validation with a direct executable + argv parser and `spawn(..., shell=false)`. Shell composition/operators are rejected, quoted Windows executable paths with spaces are handled directly, successful stdout remains suppressed, and failed validation keeps only a bounded tail.
- Add empty execution-run cleanup for startup/handshake paths that never attach a worker, reducing orphan run/baseline state after failed first starts.
- Add v0.5.3 regression coverage for direct validation parsing, shell-operator rejection, logical PLAN auto-resume across actual process relaunches, stall detection, logical failure classification, empty-run cleanup, conditional planning invariants, and independent architecture review.

## 0.5.2 - 2026-09-08

- Normalize Git dirty paths from repository-root coordinates into execution-workspace coordinates, fixing false `Unauthorized changes` when the approved workspace is nested below the Git root while still detecting new or modified sibling paths outside the workspace.
- Harden canonical validation on Windows: execute through an explicit platform shell, reject obvious unquoted absolute `.exe` paths containing spaces, suppress successful validation stdout, and return only a bounded failure tail when validation fails.
- Make `agy_review_plan` summary-first. The default response no longer repeats the approved PLAN or returns the owned-path diff; `includeDiff=true` requests the bounded diff only when Codex actually needs it.
- Skip canonical validation when a PLAN has no owned-path delta and expose compact structured review metadata such as `hasOwnedDelta`, validation skip reason, diff inclusion/truncation, and worker terminal failure kind/retryability.
- Add explicit `agy_followup({ workerId, resume: true })` recovery for terminal retryable PLAN workers. MCP reconstructs the original approved PLAN and recovery policy server-side and resumes the same Antigravity conversation without requiring Codex to manufacture a timeout finding or repeat PLAN text.
- Make terminal retryable `agy_wait` results recommend `agy_review_plan` and explicitly tell Codex not to wait again once `done=true` / `workerContinues=false`, reducing redundant `wait → status → wait → status` recovery loops.
- Include compact `workerId` and `runId` in PLAN start acknowledgements and consistently direct running workers to `agy_wait`, eliminating the execution-time need to recover `runId` through extra lifecycle calls.
- Tighten `$execution-blueprint` so executable canonical validation commands are shell-safe and paths containing whitespace are quoted, and update `$execute-plan` for compact review and retryable recovery semantics.
- Add v0.5.2 regression coverage for nested Git-root workspaces, sibling dirty preservation, Windows validation quoting, diff-on-demand review, and server-side PLAN resume prompts.

## 0.5.0 - 2026-09-07

- Bundle `$execution-blueprint` into the plugin and define the canonical `AGY_BLUEPRINT:v1` format, including stable PLAN IDs, write/forbidden scopes, controlled read sets, repository conventions, validation, and stop conditions.
- Keep the complete canonical blueprint visible in Codex chat exactly once; later execution captures that already-rendered assistant output from the local Codex rollout using MCP `threadId` metadata instead of making Codex regenerate the blueprint into tool arguments.
- Add persistent blueprint storage under `$CODEX_HOME/antigravity-subagent/blueprints` and execution-run state under `$CODEX_HOME/antigravity-subagent/runs`.
- Add high-level `agy_start_plan`, whose schema intentionally has no `prompt` field. The MCP server extracts the requested PLAN, injects static AGY execution policy, materializes bounded approved source context, and builds the long Antigravity prompt with ordinary TypeScript rather than Codex output tokens.
- Add `agy_review_plan` to prepare deterministic supervisor evidence: per-PLAN baseline deltas, write/forbidden-scope violations, pre-existing outside-scope preservation checks, canonical validation results, and a bounded relevant diff. Codex remains responsible for deep semantic review and PASS/FAIL/BLOCKED judgment.
- Extend `agy_followup` with structured PLAN findings. For PLAN-bound workers the MCP server reconstructs the original PLAN and correction policy server-side so Codex sends only review findings instead of repeating the full execution contract.
- Materialize target/reference files selected by Codex planning into AGY input with per-file and aggregate bounds. AGY is instructed not to perform broad repository discovery or invent material architecture/API/database/naming decisions.
- Add temporary bounded baseline snapshots for approved PLAN write scopes; delete those snapshots after every worker in an execution run is closed while retaining blueprint/run/worker audit metadata.
- Remove `agy_delegate` and `agy_result` from the MCP surface. Standalone bounded work uses `agy_start` + `agy_wait`; lifecycle snapshots use `agy_status`. The v0.5 MCP surface remains nine tools after adding the two PLAN-specific tools.
- Keep `agy_wait` as the long passive completion barrier (`900s` default, `1100s` max) for v0.5; native MCP Tasks/subscriptions are deferred until Codex host support is verified end-to-end.
- Add architecture regression coverage that prevents `agy_start_plan` from regaining a large `prompt` argument and checks the v0.5 skill/tool contract.
- Align plugin/MCP release identity on version `0.5.0` and derive the running MCP server version from package metadata instead of maintaining another hard-coded constant.

## 0.4.2 - 2026-09-04

- Add read-only `agy_wait` as a passive completion barrier that waits inside the MCP server without sending prompts or owning/canceling the worker. A wait timeout/cancel returns control while the AGY worker continues running.
- Make running `agy_result` snapshots explicitly say that the existing worker is still running instead of reusing start-style acknowledgement wording.
- Update the delegation skill with a strict sequential completion contract: a RUNNING worker or passive wait timeout is not a blocker, requested plan steps must finish their wait/review/fix/close loop before Codex returns a final answer, and model-driven sleep/result polling should be replaced by `agy_wait`.
- Expand real-MCP smoke coverage to use `agy_wait` as the completion barrier for managed start/follow-up turns.

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
- Expand protocol and real-CLI smoke coverage for start, follow-up, close, capability reporting, and model/effort resolution.

## 0.2.0 - 2026-08-01

- Add the `agy_check` and `agy_delegate` stdio MCP tools.
- Add `$delegate-to-antigravity` Codex skill.
- Default delegation to `plan` mode.
- Add bounded timeouts and output capture.
- Bundle the Node.js runtime artifact for installation without `npm install`.
- Add GitHub marketplace packaging, CI, installation guidance, and security documentation.

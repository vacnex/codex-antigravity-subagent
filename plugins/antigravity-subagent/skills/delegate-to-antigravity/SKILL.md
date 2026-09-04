---
name: delegate-to-antigravity
description: Delegate a bounded coding, research, review, debugging, or implementation task to the local Google Antigravity CLI (`agy`) and use its response as a second-agent result. Use when the user explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity, or asks Codex to offload an independent task to `agy`.
---

# Delegate to Antigravity

Treat Antigravity as an external delegated worker. It is not a native Codex collaboration agent: collect its output, verify it, and remain responsible for the final answer and workspace changes.

## Managed worker workflow

Prefer managed workers for implementation or any task likely to need review corrections:

1. Establish availability with `agy_check`.
2. Start a new bounded task with `agy_start`.
3. Unless both values were supplied explicitly, let the MCP client ask the user to choose the Antigravity model and reasoning effort. Do not silently invent either choice.
4. Keep the returned `workerId` and `conversationId`. The conversation ID is an Antigravity conversation that remains available for manual inspection and resume.
5. Inspect the workspace diff and run relevant tests independently.
6. If review fails, call `agy_followup` with the same `workerId` and concrete correction instructions. Repeat review and follow-up until the work passes.
7. Call `agy_close` only after the worker passes review. Closing forgets the MCP worker mapping; it does not delete the Antigravity conversation.
8. For a distinct plan step, start a new worker rather than reusing the previous worker's context.

For sequential multi-step plans, use one Antigravity worker per plan step. Finish the review/fix loop for the current step before starting the next one unless the user explicitly requests parallel work.

## One-shot delegation

Use `agy_delegate` for bounded research, second opinions, or work that does not need a follow-up session. It remains a one-shot compatibility tool.

## Model and effort selection

For a new delegation or managed worker, `model` and `effort` are optional MCP arguments. When either is omitted, the MCP server requests the missing values from the user through MCP elicitation. Available models are discovered from the authenticated Antigravity installation with `agy models --output-format json`.

If the MCP client cannot display elicitation, pass both values explicitly. Valid effort values are `low`, `medium`, and `high`.

Do not ask for model or effort again on `agy_followup`; the existing worker keeps its original selection.

## Auditing Antigravity sessions

Managed workers run Antigravity with structured JSON output and retain the returned conversation ID. After delegation, the user can inspect the same Antigravity conversation manually from the workspace with interactive `agy` and `/resume`, or resume a known conversation directly with `agy --conversation <conversation-id>`.

Treat this as an audit trail of the conversation and visible agent/tool activity that Antigravity stores. Do not describe it as access to hidden model chain-of-thought.

## Bundled runner

When MCP tools are unavailable, use the bundled `scripts/agy-delegate.mjs` runner. It requires Node.js 20 or newer and a locally installed, authenticated `agy` CLI.

Write the complete prompt to a temporary UTF-8 file and pass its absolute path to the runner. Do not interpolate an untrusted prompt into shell syntax.

```text
node <skill-dir>/scripts/agy-delegate.mjs --cwd <absolute-workspace> --mode plan --prompt-file <absolute-prompt-file> --model <model> --effort <low|medium|high>
```

To resume a known Antigravity conversation through the fallback runner, add `--conversation <conversation-id>`.

Delete the temporary prompt file after the runner finishes. The runner accepts `--output-format text|json`, `--timeout-seconds 1..1800`, `--agent`, `--model`, `--effort`, and `--conversation`. The runner cannot provide the MCP picker, so select model and effort explicitly when they matter. Do not add or emulate dangerous permission-bypass flags.

If neither the MCP tools nor local process execution is available, explain that this plugin requires a local Codex environment with Node.js and an authenticated `agy` installation.

## Safety

- Never weaken the user's persisted sandbox or permission policy.
- Do not delegate secrets, credentials, private data, destructive operations, releases, deployments, purchases, or external messages without explicit authorization for that scope.
- Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication or interactive approval is required, return control to the user rather than bypassing it.
- Use a finite `timeoutSeconds`; split oversized work into bounded tasks.
- Keep the Antigravity conversation ID available for audit, but do not expose it outside the user's local workflow unless requested.

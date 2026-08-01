---
name: delegate-to-antigravity
description: Delegate a bounded coding, research, review, debugging, or implementation task to the local Google Antigravity CLI (`agy`) through the `agy` MCP tools and use its response as a second-agent result. Use when the user explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity, or asks Codex to offload an independent task to `agy`.
---

# Delegate to Antigravity

Treat Antigravity as an external delegated worker. It is not a native Codex collaboration agent: collect its output, verify it, and remain responsible for the final answer and workspace changes.

## Workflow

1. Call `agy_check` when availability has not been established.
2. Make the task concrete and bounded. Include the goal, constraints, expected output, and relevant absolute paths in `prompt`.
3. Call `agy_delegate` with the target workspace in `cwd`.
4. Default to `mode: plan`. Use `mode: accept-edits` only when the user requested implementation and authorized changes to that workspace.
5. Inspect Antigravity's response and the workspace diff. Run relevant tests independently when it made changes.
6. Report its contribution as delegated analysis, not independently verified fact.

## Safety

- Never weaken the user's persisted sandbox or permission policy.
- Do not delegate secrets, credentials, private data, destructive operations, releases, deployments, purchases, or external messages without explicit authorization for that scope.
- Use one invocation per independent task. Do not create recursive delegation loops or ask Antigravity to invoke Codex.
- If authentication or interactive approval is required, return control to the user rather than bypassing it.
- Use a finite `timeoutSeconds`; split oversized work into bounded tasks.

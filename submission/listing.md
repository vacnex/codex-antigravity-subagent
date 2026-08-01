# Public directory listing

## Identity

- Plugin name: Antigravity Subagent
- Publisher: select the verified individual identity for the Personal organization
- Category: Developer Tools
- Website: https://github.com/IlleJiViN/codex-antigravity-subagent
- Support: https://github.com/IlleJiViN/codex-antigravity-subagent/issues
- Privacy: https://github.com/IlleJiViN/codex-antigravity-subagent/blob/main/PRIVACY.md
- Terms: https://github.com/IlleJiViN/codex-antigravity-subagent/blob/main/TERMS.md

## Short description

Delegate bounded tasks from Codex to your locally installed Antigravity CLI for a second-agent review, research pass, or implementation.

## Long description

Antigravity Subagent helps Codex users delegate a concrete, bounded task to the locally installed Google Antigravity CLI (`agy`). Codex remains the orchestrator: it scopes the request, defaults to plan mode, reviews the returned result, checks workspace changes, and independently validates any implementation.

Use it for code review, debugging hypotheses, research across a defined set of files, implementation planning, or an explicitly authorized edit pass. The plugin includes a guarded local runner with finite timeouts and a 2 MiB output cap. It does not expose dangerous permission-bypass flags, collect telemetry, or operate a hosted service.

Requirements: a local Codex environment, Node.js 20 or newer, and an installed and authenticated Antigravity CLI. This independent community project is not affiliated with Google, Antigravity, or OpenAI.

## Starter prompts

1. Use Antigravity as a subagent to review this implementation for missed edge cases. Keep it in plan mode and do not modify files.
2. Delegate a bounded research pass over these three files to Antigravity and verify its conclusions.
3. Ask Antigravity for a second debugging hypothesis for this failing test.
4. Have Antigravity propose a patch in plan mode, then independently evaluate the proposal.

## Availability

Select regions where Codex and the official Antigravity CLI are both supported and where the publisher is prepared to provide support. Start conservatively rather than selecting unsupported regions.

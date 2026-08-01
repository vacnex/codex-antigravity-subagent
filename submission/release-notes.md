# Initial submission release notes

Initial public submission of Antigravity Subagent as a Skills-only plugin for Codex.

The plugin delegates bounded local tasks to an installed and authenticated Google Antigravity CLI while Codex remains responsible for scoping, verification, and the final response. It defaults to plan mode, requires explicit authorization for edit-capable delegation, uses finite timeouts and a 2 MiB output cap, and does not expose dangerous permission-bypass flags.

No reviewer credentials are required. Review requires a local environment with Node.js 20 or newer and the official `agy` CLI installed and authenticated.

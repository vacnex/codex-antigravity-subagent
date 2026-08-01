# Antigravity Subagent for Codex

A local Codex plugin that delegates bounded tasks to Google Antigravity CLI (`agy`). It provides both a Codex skill and a bundled stdio MCP server.

## MCP tools

- `agy_check`: verify that `agy` is installed and report its path.
- `agy_delegate`: run one bounded prompt in Antigravity headless mode and return its output.

Delegation defaults to `plan` mode. The MCP server never enables Antigravity's dangerous permission-bypass flag.

## Requirements

- Node.js 20 or newer
- [Google Antigravity CLI](https://antigravity.google/docs/cli-getting-started), installed and authenticated

## Install in Codex

Add this repository as a local marketplace, then install `antigravity-subagent` from it. Start a new Codex task after installation so the skill and MCP server are discovered.

## Development

```powershell
cd plugins/antigravity-subagent/mcp
npm install
npm run check
npm run build
npm test
```

The checked-in `dist/server.cjs` is the runtime artifact used by the plugin.

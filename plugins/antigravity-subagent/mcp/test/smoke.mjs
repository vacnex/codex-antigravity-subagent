import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../dist/server.cjs');
const protocolOnly = process.argv.includes('--protocol-only');
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: 'agy-mcp-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['agy_check', 'agy_delegate']);

  if (!protocolOnly) {
    const check = await client.callTool({ name: 'agy_check', arguments: {} });
    assert.notEqual(check.isError, true);
    assert.match(check.content[0].text, /Antigravity CLI is available at:/);

    const delegated = await client.callTool({
      name: 'agy_delegate',
      arguments: {
        prompt: 'Reply with exactly: AGY_MCP_OK. Do not inspect or modify files.',
        cwd: path.resolve(here, '../../../..'),
        mode: 'plan',
        timeoutSeconds: 120,
      },
    });
    assert.notEqual(delegated.isError, true);
    assert.match(delegated.content[0].text, /AGY_MCP_OK/);
  }
  console.error('MCP smoke test passed');
} finally {
  await client.close();
}

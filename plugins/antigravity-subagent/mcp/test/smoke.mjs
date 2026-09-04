import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../dist/server.cjs');
const protocolOnly = process.argv.includes('--protocol-only');
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client(
  { name: 'agy-mcp-smoke-test', version: '1.0.0' },
  { capabilities: { elicitation: { form: {} } } },
);

function assertToolSucceeded(name, result) {
  assert.notEqual(
    result.isError,
    true,
    `${name} failed:\n${JSON.stringify(result, null, 2)}`,
  );
}

client.setRequestHandler('elicitation/create', async (request) => {
  if (request.params.mode !== 'form') return { action: 'decline' };
  const schema = request.params.requestedSchema;
  const models = schema.properties?.model?.enum ?? [];
  const model = models[0];
  let effort = 'medium';

  if (typeof model === 'string') {
    const pinned = model.match(/-(low|medium|high)$/i)?.[1]?.toLowerCase();
    if (pinned && pinned !== effort) {
      const family = model.slice(0, -(pinned.length + 1));
      const sibling = models.find((candidate) => candidate.toLowerCase() === `${family}-${effort}`.toLowerCase());
      if (!sibling) effort = pinned;
    }
  }

  return {
    action: 'accept',
    content: {
      ...(typeof model === 'string' ? { model } : {}),
      effort,
    },
  };
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['agy_check', 'agy_close', 'agy_delegate', 'agy_followup', 'agy_start'],
  );

  const delegateTool = tools.tools.find((tool) => tool.name === 'agy_delegate');
  const startTool = tools.tools.find((tool) => tool.name === 'agy_start');
  assert.ok(delegateTool);
  assert.ok(startTool);
  assert.deepEqual(delegateTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);
  assert.deepEqual(startTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);

  if (!protocolOnly) {
    const check = await client.callTool({ name: 'agy_check', arguments: {} });
    assertToolSucceeded('agy_check', check);
    assert.match(check.content[0].text, /Antigravity CLI is available at:/);
    assert.equal(check.structuredContent?.compatible, true);
    assert.equal(typeof check.structuredContent?.version, 'string');
    assert.ok(check.structuredContent?.modelCount > 0);
    assert.ok(check.structuredContent?.baseModelCount > 0);

    const started = await client.callTool({
      name: 'agy_start',
      arguments: {
        prompt: 'Reply with exactly: AGY_WORKER_STARTED. Do not inspect or modify files.',
        cwd: path.resolve(here, '../../../..'),
        mode: 'plan',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_start', started);
    assert.match(started.content[0].text, /AGY_WORKER_STARTED/);
    assert.equal(typeof started.structuredContent?.workerId, 'string');
    assert.equal(typeof started.structuredContent?.conversationId, 'string');
    assert.ok(['low', 'medium', 'high'].includes(started.structuredContent?.effort));
    assert.equal(typeof started.structuredContent?.model, 'string');

    const pinnedEffort = started.structuredContent.model.match(/-(low|medium|high)$/i)?.[1]?.toLowerCase();
    if (pinnedEffort) assert.equal(pinnedEffort, started.structuredContent.effort);

    const workerId = started.structuredContent.workerId;
    const conversationId = started.structuredContent.conversationId;
    const followedUp = await client.callTool({
      name: 'agy_followup',
      arguments: {
        workerId,
        prompt: 'Reply with exactly: AGY_WORKER_RESUMED. Do not inspect or modify files.',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_followup', followedUp);
    assert.match(followedUp.content[0].text, /AGY_WORKER_RESUMED/);
    assert.equal(followedUp.structuredContent?.workerId, workerId);
    assert.equal(followedUp.structuredContent?.conversationId, conversationId);

    const closed = await client.callTool({ name: 'agy_close', arguments: { workerId } });
    assertToolSucceeded('agy_close', closed);
    assert.equal(closed.structuredContent?.closed, true);
    assert.equal(closed.structuredContent?.conversationId, conversationId);
  }
  console.error('MCP smoke test passed');
} finally {
  await client.close();
}

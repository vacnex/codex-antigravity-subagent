import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../dist/server.cjs');
const protocolOnly = process.argv.includes('--protocol-only');
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-smoke-state-'));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
childEnv.AGY_MCP_STATE_DIR = stateDir;
childEnv.AGY_MCP_IDLE_DRIVER_MS = '600000';

function assertToolSucceeded(name, result) {
  assert.notEqual(result.isError, true, `${name} failed:\n${JSON.stringify(result, null, 2)}`);
}

async function readLedger(workerId) {
  return JSON.parse(await readFile(path.join(stateDir, `${workerId}.json`), 'utf8'));
}

function configureElicitation(client) {
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
    return { action: 'accept', content: { ...(typeof model === 'string' ? { model } : {}), effort } };
  });
}

async function openClient(label) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: childEnv });
  const client = new Client({ name: `agy-mcp-smoke-${label}`, version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  configureElicitation(client);
  await client.connect(transport);
  return { client, transport };
}

async function assertProtocolSurface(client) {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['agy_cancel', 'agy_check', 'agy_close', 'agy_delegate', 'agy_followup', 'agy_start', 'agy_status'],
  );
  const startTool = tools.tools.find((tool) => tool.name === 'agy_start');
  const delegateTool = tools.tools.find((tool) => tool.name === 'agy_delegate');
  const statusTool = tools.tools.find((tool) => tool.name === 'agy_status');
  assert.ok(startTool && delegateTool && statusTool);
  assert.deepEqual(startTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);
  assert.equal(startTool.inputSchema.properties?.name?.maxLength, 120);
  assert.deepEqual(delegateTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);
}

let first;
let second;
try {
  first = await openClient('first');
  await assertProtocolSurface(first.client);

  if (protocolOnly) {
    console.error('MCP smoke test passed');
  } else {
    const check = await first.client.callTool({ name: 'agy_check', arguments: { refresh: true } });
    assertToolSucceeded('agy_check', check);
    assert.match(check.content[0].text, /Antigravity CLI is available at:/);
    assert.equal(check.structuredContent?.compatible, true);
    assert.equal(typeof check.structuredContent?.version, 'string');
    assert.ok(check.structuredContent?.modelCount > 0);
    const streamingExpected = check.structuredContent?.streaming?.persistentDriver === true;

    const started = await first.client.callTool({
      name: 'agy_start',
      arguments: {
        name: 'Smoke Plan - Restart Recovery',
        prompt: 'Reply with exactly: AGY_WORKER_STARTED. Do not inspect or modify files.',
        cwd: path.resolve(here, '../../../..'),
        mode: 'plan',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_start', started);
    assert.match(started.content[0].text, /AGY_WORKER_STARTED/);
    assert.equal(started.structuredContent?.name, 'Smoke Plan - Restart Recovery');
    assert.equal(started.structuredContent?.transport, streamingExpected ? 'stream' : 'oneshot');
    assert.equal(started.structuredContent?.ledgerPersisted, true);
    const workerId = started.structuredContent.workerId;
    const conversationId = started.structuredContent.conversationId;
    const firstPid = started.structuredContent.driverPid;
    assert.equal(typeof workerId, 'string');
    assert.equal(typeof conversationId, 'string');
    if (streamingExpected) assert.equal(typeof firstPid, 'number');

    const statusWarm = await first.client.callTool({ name: 'agy_status', arguments: { workerId } });
    assertToolSucceeded('agy_status warm', statusWarm);
    assert.equal(statusWarm.structuredContent?.workerId, workerId);
    assert.equal(statusWarm.structuredContent?.state, 'ready');
    assert.equal(statusWarm.structuredContent?.warm, streamingExpected);

    const followed = await first.client.callTool({
      name: 'agy_followup',
      arguments: {
        workerId,
        prompt: 'Reply with exactly: AGY_WORKER_RESUMED. Do not inspect or modify files.',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_followup warm', followed);
    assert.match(followed.content[0].text, /AGY_WORKER_RESUMED/);
    assert.equal(followed.structuredContent?.conversationId, conversationId);
    assert.equal(followed.structuredContent?.ledgerPersisted, true);
    if (streamingExpected) assert.equal(followed.structuredContent?.driverPid, firstPid);
    if (typeof followed.structuredContent?.sessionUsage?.total_tokens === 'number') {
      assert.equal(typeof followed.structuredContent?.turnUsage?.total_tokens, 'number');
      assert.ok(followed.structuredContent.turnUsage.total_tokens <= followed.structuredContent.sessionUsage.total_tokens);
    }

    const beforeRestart = await readLedger(workerId);
    assert.equal(beforeRestart.name, 'Smoke Plan - Restart Recovery');
    assert.equal(beforeRestart.conversationId, conversationId);
    assert.equal(beforeRestart.closedAt, undefined);
    assert.equal('prompt' in beforeRestart, false);
    assert.equal('response' in beforeRestart, false);

    // Simulate Codex/MCP restart without closing the logical worker.
    await first.client.close();
    first = undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));

    second = await openClient('second');
    await assertProtocolSurface(second.client);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const recoveredStatus = await second.client.callTool({ name: 'agy_status', arguments: { workerId } });
    assertToolSucceeded('agy_status recovered', recoveredStatus);
    assert.equal(recoveredStatus.structuredContent?.conversationId, conversationId);
    assert.equal(recoveredStatus.structuredContent?.state, 'recoverable');
    assert.equal(recoveredStatus.structuredContent?.warm, false);

    const recovered = await second.client.callTool({
      name: 'agy_followup',
      arguments: {
        workerId,
        prompt: 'Reply with exactly: AGY_WORKER_RECOVERED. Do not inspect or modify files.',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_followup recovered', recovered);
    assert.match(recovered.content[0].text, /AGY_WORKER_RECOVERED/);
    assert.equal(recovered.structuredContent?.workerId, workerId);
    assert.equal(recovered.structuredContent?.conversationId, conversationId);
    assert.equal(recovered.structuredContent?.ledgerPersisted, true);
    if (streamingExpected) {
      assert.equal(recovered.structuredContent?.transport, 'stream');
      assert.equal(typeof recovered.structuredContent?.driverPid, 'number');
      assert.notEqual(recovered.structuredContent.driverPid, firstPid);
    }

    const noTurnCancel = await second.client.callTool({ name: 'agy_cancel', arguments: { workerId } });
    assertToolSucceeded('agy_cancel idle', noTurnCancel);
    assert.equal(noTurnCancel.structuredContent?.canceled, false);

    const closed = await second.client.callTool({ name: 'agy_close', arguments: { workerId } });
    assertToolSucceeded('agy_close', closed);
    assert.equal(closed.structuredContent?.closed, true);
    assert.equal(closed.structuredContent?.conversationId, conversationId);

    const closedLedger = await readLedger(workerId);
    assert.equal(closedLedger.state, 'closed');
    assert.equal(typeof closedLedger.closedAt, 'string');
    assert.equal(closedLedger.conversationId, conversationId);

    const closedStatus = await second.client.callTool({ name: 'agy_status', arguments: { workerId, includeClosed: true } });
    assertToolSucceeded('agy_status closed', closedStatus);
    assert.equal(closedStatus.structuredContent?.state, 'closed');

    console.error('MCP smoke test passed');
  }
} finally {
  if (first) await first.client.close().catch(() => undefined);
  if (second) await second.client.close().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}

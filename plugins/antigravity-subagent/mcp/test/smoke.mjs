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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const projects = schema.properties?.projectId?.enum ?? [];
    const models = schema.properties?.model?.enum ?? [];
    const projectId = projects[0];
    const model = models[0];
    let effort = schema.properties?.effort ? 'medium' : undefined;
    if (typeof model === 'string' && effort) {
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
        ...(typeof projectId === 'string' ? { projectId } : {}),
        ...(typeof model === 'string' ? { model } : {}),
        ...(effort ? { effort } : {}),
      },
    };
  });
}

async function openClient(label) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: childEnv });
  const client = new Client(
    { name: `agy-mcp-smoke-${label}`, version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } }, inputRequired: { autoFulfill: true, maxRounds: 4 } },
  );
  configureElicitation(client);
  await client.connect(transport);
  return { client, transport };
}

async function assertProtocolSurface(client) {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['agy_cancel', 'agy_check', 'agy_close', 'agy_delegate', 'agy_followup', 'agy_result', 'agy_start', 'agy_status', 'agy_wait'],
  );
  const startTool = tools.tools.find((tool) => tool.name === 'agy_start');
  const followupTool = tools.tools.find((tool) => tool.name === 'agy_followup');
  const resultTool = tools.tools.find((tool) => tool.name === 'agy_result');
  const waitTool = tools.tools.find((tool) => tool.name === 'agy_wait');
  const delegateTool = tools.tools.find((tool) => tool.name === 'agy_delegate');
  const statusTool = tools.tools.find((tool) => tool.name === 'agy_status');
  assert.ok(startTool && followupTool && resultTool && waitTool && delegateTool && statusTool);
  assert.deepEqual(startTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);
  assert.equal(startTool.inputSchema.properties?.name?.maxLength, 120);
  assert.equal(startTool.inputSchema.properties?.idempotencyKey?.maxLength, 200);
  assert.equal(startTool.inputSchema.properties?.projectId?.maxLength, 200);
  assert.equal(delegateTool.inputSchema.properties?.projectId?.maxLength, 200);
  assert.equal(followupTool.inputSchema.properties?.projectId, undefined, 'followup must inherit the conversation project rather than re-selecting one');
  assert.equal(followupTool.inputSchema.properties?.idempotencyKey?.maxLength, 200);
  assert.ok(resultTool.inputSchema.properties?.workerId);
  assert.ok(waitTool.inputSchema.properties?.workerId);
  assert.equal(waitTool.inputSchema.properties?.timeoutSeconds?.maximum, 1100);
  assert.deepEqual(delegateTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);
}

async function waitForResult(client, workerId, expectedText, timeoutMs = 180_000) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await client.callTool({ name: 'agy_wait', arguments: { workerId, timeoutSeconds } });
  assertToolSucceeded(`agy_wait ${workerId}`, result);
  assert.equal(result.structuredContent?.done, true);
  assert.equal(result.structuredContent?.waitTimedOut, false);
  assert.equal(result.structuredContent?.waitCanceled, false);
  assert.equal(result.structuredContent?.workerContinues, false);
  assert.notEqual(result.structuredContent?.transportStatus, 'running');
  if (expectedText) assert.match(result.content[0].text, expectedText);
  return result;
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
    assert.equal(typeof check.structuredContent?.projectCount, 'number');
    const streamingExpected = check.structuredContent?.streaming?.persistentDriver === true;

    const startArgs = {
      name: 'Smoke Plan - Restart Recovery',
      idempotencyKey: 'smoke-plan-restart-recovery-v043',
      prompt: 'Reply with exactly: AGY_WORKER_STARTED. Do not inspect or modify files.',
      cwd: path.resolve(here, '../../../..'),
      mode: 'plan',
      timeoutSeconds: 120,
    };
    const startAt = Date.now();
    const started = await first.client.callTool({ name: 'agy_start', arguments: startArgs });
    assertToolSucceeded('agy_start', started);
    assert.equal(started.structuredContent?.name, 'Smoke Plan - Restart Recovery');
    assert.equal(started.structuredContent?.idempotencyKey, 'smoke-plan-restart-recovery-v043');
    assert.equal(started.structuredContent?.ledgerPersisted, true);
    const workerId = started.structuredContent.workerId;
    const conversationId = started.structuredContent.conversationId;
    const firstPid = started.structuredContent.driverPid;
    const projectId = started.structuredContent.agyProjectId;
    assert.equal(typeof workerId, 'string');
    assert.equal(typeof conversationId, 'string');
    assert.ok(['explicit', 'auto', 'selected', 'created'].includes(started.structuredContent?.agyProjectResolution));

    if (streamingExpected) {
      assert.equal(started.structuredContent?.transport, 'stream');
      assert.equal(started.structuredContent?.state, 'running');
      assert.equal(started.structuredContent?.done, false);
      assert.equal(started.structuredContent?.background, true);
      assert.equal(started.structuredContent?.agyWorkspaceAttested, true);
      assert.equal(started.structuredContent?.transportStatus, 'running');
      assert.equal(typeof firstPid, 'number');
      assert.ok(Date.now() - startAt < 30_000, 'persistent agy_start should return after the init handshake, not after the full turn');

      const runningLedger = await readLedger(workerId);
      assert.equal(runningLedger.state, 'running');
      assert.equal(runningLedger.conversationId, conversationId);
      assert.equal(runningLedger.idempotencyKey, 'smoke-plan-restart-recovery-v043');
      assert.equal(runningLedger.activeTurnKind, 'start');
      assert.equal(runningLedger.lastResultStatus, 'RUNNING');
      assert.equal(runningLedger.agyWorkspaceAttested, true);
      assert.equal(runningLedger.agyProjectResolution, started.structuredContent?.agyProjectResolution);
      if (typeof projectId === 'string') assert.equal(runningLedger.agyProjectId, projectId);

      const retriedStart = await first.client.callTool({ name: 'agy_start', arguments: startArgs });
      assertToolSucceeded('agy_start retry', retriedStart);
      assert.equal(retriedStart.structuredContent?.workerId, workerId);
      assert.equal(retriedStart.structuredContent?.conversationId, conversationId);
      assert.equal(retriedStart.structuredContent?.reused, true);
      assert.equal(retriedStart.structuredContent?.agyProjectId, projectId);
    }

    const startedFinal = streamingExpected
      ? await waitForResult(first.client, workerId, /AGY_WORKER_STARTED/)
      : started;
    assert.match(startedFinal.content[0].text, /AGY_WORKER_STARTED/);
    assert.equal(startedFinal.structuredContent?.conversationId, conversationId);
    if (streamingExpected) {
      assert.equal(startedFinal.structuredContent?.transportStatus, 'ok');
      assert.equal(startedFinal.structuredContent?.agyStatus, 'SUCCESS');
      assert.equal(startedFinal.structuredContent?.failureKind, 'none');
    }

    const statusWarm = await first.client.callTool({ name: 'agy_status', arguments: { workerId } });
    assertToolSucceeded('agy_status warm', statusWarm);
    assert.equal(statusWarm.structuredContent?.workerId, workerId);
    assert.equal(statusWarm.structuredContent?.state, 'ready');
    assert.equal(statusWarm.structuredContent?.warm, streamingExpected);
    assert.equal(statusWarm.structuredContent?.lastTimedOut, false);
    assert.equal(statusWarm.structuredContent?.lastCanceled, false);
    assert.equal(statusWarm.structuredContent?.agyProjectId, projectId);

    const followupArgs = {
      workerId,
      idempotencyKey: 'smoke-plan-restart-recovery-v043-followup-1',
      prompt: 'Reply with exactly: AGY_WORKER_RESUMED. Do not inspect or modify files.',
      timeoutSeconds: 120,
    };
    const followed = await first.client.callTool({ name: 'agy_followup', arguments: followupArgs });
    assertToolSucceeded('agy_followup warm', followed);
    assert.equal(followed.structuredContent?.agyProjectId, projectId);
    if (streamingExpected) {
      assert.equal(followed.structuredContent?.state, 'running');
      assert.equal(followed.structuredContent?.done, false);
      assert.equal(followed.structuredContent?.driverPid, firstPid);

      const retriedFollowup = await first.client.callTool({ name: 'agy_followup', arguments: followupArgs });
      assertToolSucceeded('agy_followup retry', retriedFollowup);
      assert.equal(retriedFollowup.structuredContent?.workerId, workerId);
      assert.equal(retriedFollowup.structuredContent?.reused, true);
    }
    const followedFinal = streamingExpected
      ? await waitForResult(first.client, workerId, /AGY_WORKER_RESUMED/)
      : followed;
    assert.equal(followedFinal.structuredContent?.conversationId, conversationId);
    assert.equal(followedFinal.structuredContent?.ledgerPersisted, true);
    assert.equal(followedFinal.structuredContent?.agyProjectId, projectId);
    if (typeof followedFinal.structuredContent?.sessionUsage?.total_tokens === 'number') {
      assert.equal(typeof followedFinal.structuredContent?.turnUsage?.total_tokens, 'number');
      assert.ok(followedFinal.structuredContent.turnUsage.total_tokens <= followedFinal.structuredContent.sessionUsage.total_tokens);
    }

    const beforeRestart = await readLedger(workerId);
    assert.equal(beforeRestart.name, 'Smoke Plan - Restart Recovery');
    assert.equal(beforeRestart.idempotencyKey, 'smoke-plan-restart-recovery-v043');
    assert.equal(beforeRestart.conversationId, conversationId);
    assert.equal(beforeRestart.agyProjectId, projectId);
    assert.equal(beforeRestart.closedAt, undefined);
    assert.equal(beforeRestart.activeTurnKind, undefined);
    assert.equal(beforeRestart.lastTurnKind, 'followup');
    assert.equal(beforeRestart.lastTurnKey, 'smoke-plan-restart-recovery-v043-followup-1');
    assert.equal('prompt' in beforeRestart, false);
    assert.equal('response' in beforeRestart, false);

    // Simulate Codex/MCP restart without closing the logical worker.
    await first.client.close();
    first = undefined;
    await sleep(500);

    second = await openClient('second');
    await assertProtocolSurface(second.client);
    await sleep(100);

    const recoveredStatus = await second.client.callTool({ name: 'agy_status', arguments: { workerId } });
    assertToolSucceeded('agy_status recovered', recoveredStatus);
    assert.equal(recoveredStatus.structuredContent?.conversationId, conversationId);
    assert.equal(recoveredStatus.structuredContent?.state, 'recoverable');
    assert.equal(recoveredStatus.structuredContent?.warm, false);
    assert.equal(recoveredStatus.structuredContent?.agyProjectId, projectId);

    const recoveredOldResult = await second.client.callTool({ name: 'agy_result', arguments: { workerId } });
    assertToolSucceeded('agy_result after restart', recoveredOldResult);
    assert.equal(recoveredOldResult.structuredContent?.done, true);
    assert.equal(recoveredOldResult.structuredContent?.resultAvailable, false);
    assert.equal(recoveredOldResult.structuredContent?.status, 'SUCCESS');
    assert.equal(recoveredOldResult.structuredContent?.agyProjectId, projectId);

    const recovered = await second.client.callTool({
      name: 'agy_followup',
      arguments: {
        workerId,
        idempotencyKey: 'smoke-plan-restart-recovery-v043-followup-2',
        prompt: 'Reply with exactly: AGY_WORKER_RECOVERED. Do not inspect or modify files.',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_followup recovered', recovered);
    assert.equal(recovered.structuredContent?.agyProjectId, projectId);
    if (streamingExpected) {
      assert.equal(recovered.structuredContent?.transport, 'stream');
      assert.equal(recovered.structuredContent?.state, 'running');
      assert.equal(typeof recovered.structuredContent?.driverPid, 'number');
      assert.notEqual(recovered.structuredContent.driverPid, firstPid);
    }
    const recoveredFinal = streamingExpected
      ? await waitForResult(second.client, workerId, /AGY_WORKER_RECOVERED/)
      : recovered;
    assert.equal(recoveredFinal.structuredContent?.workerId, workerId);
    assert.equal(recoveredFinal.structuredContent?.conversationId, conversationId);
    assert.equal(recoveredFinal.structuredContent?.ledgerPersisted, true);
    assert.equal(recoveredFinal.structuredContent?.agyProjectId, projectId);

    const noTurnCancel = await second.client.callTool({ name: 'agy_cancel', arguments: { workerId } });
    assertToolSucceeded('agy_cancel idle', noTurnCancel);
    assert.equal(noTurnCancel.structuredContent?.canceled, false);

    const closed = await second.client.callTool({ name: 'agy_close', arguments: { workerId } });
    assertToolSucceeded('agy_close', closed);
    assert.equal(closed.structuredContent?.closed, true);
    assert.equal(closed.structuredContent?.conversationId, conversationId);
    assert.equal(closed.structuredContent?.agyProjectId, projectId);

    const closedLedger = await readLedger(workerId);
    assert.equal(closedLedger.state, 'closed');
    assert.equal(typeof closedLedger.closedAt, 'string');
    assert.equal(closedLedger.conversationId, conversationId);
    assert.equal(closedLedger.agyProjectId, projectId);

    const closedStatus = await second.client.callTool({ name: 'agy_status', arguments: { workerId, includeClosed: true } });
    assertToolSucceeded('agy_status closed', closedStatus);
    assert.equal(closedStatus.structuredContent?.state, 'closed');
    assert.equal(closedStatus.structuredContent?.agyProjectId, projectId);

    console.error('MCP smoke test passed');
  }
} finally {
  if (first) await first.client.close().catch(() => undefined);
  if (second) await second.client.close().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}

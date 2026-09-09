import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const protocolOnly = process.argv.includes('--protocol-only');
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-smoke-state-'));
const serverPath = protocolOnly
  ? path.join(stateDir, 'mcp', 'dist', 'server.cjs')
  : path.resolve(here, '../dist/server.cjs');
if (protocolOnly) {
  await mkdir(path.dirname(serverPath), { recursive: true });
  await copyFile(path.resolve(here, '../package.json'), path.resolve(path.dirname(serverPath), '../package.json'));
  await build({
    entryPoints: [path.resolve(here, '../src/index.ts')],
    outfile: serverPath,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
}
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
childEnv.AGY_MCP_STATE_DIR = stateDir;
childEnv.AGY_MCP_STATE_ROOT = stateDir;
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
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: true, maxRounds: 4 },
    },
  );
  configureElicitation(client);
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), 'modern');
  return { client, transport };
}

async function assertProtocolSurface(client) {
  const sourceIndex = await readFile(path.resolve(here, '../src/index.ts'), 'utf8');
  const mcpConfig = await readFile(path.resolve(here, '../../.mcp.json'), 'utf8');
  assert.match(sourceIndex, /const WAIT_MAX_SECONDS = 2_000;/);
  assert.match(sourceIndex, /const WAIT_HEARTBEAT_MS = 30_000;/);
  assert.match(sourceIndex, /Last progress:/);
  assert.match(sourceIndex, /boundedTerminalDiagnostic/);
  assert.match(sourceIndex, /const firstSnapshot = state\.lastSignature === undefined;/);
  assert.match(sourceIndex, /const changed = firstSnapshot/);
  assert.match(mcpConfig, /"tool_timeout_sec"\s*:\s*2100/);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      'agy_cancel',
      'agy_check',
      'agy_close',
      'agy_followup',
      'agy_review_plan',
      'agy_start',
      'agy_start_plan',
      'agy_status',
      'agy_wait',
    ],
  );

  const startTool = tools.tools.find((tool) => tool.name === 'agy_start');
  const planTool = tools.tools.find((tool) => tool.name === 'agy_start_plan');
  const followupTool = tools.tools.find((tool) => tool.name === 'agy_followup');
  const reviewTool = tools.tools.find((tool) => tool.name === 'agy_review_plan');
  const waitTool = tools.tools.find((tool) => tool.name === 'agy_wait');
  assert.ok(startTool && planTool && followupTool && reviewTool && waitTool);

  assert.ok(startTool.inputSchema.properties?.prompt);
  assert.equal(startTool.inputSchema.properties?.idempotencyKey?.maxLength, 200);
  assert.deepEqual(startTool.inputSchema.properties?.effort?.enum, ['low', 'medium', 'high']);

  assert.equal(planTool.inputSchema.properties?.prompt, undefined, 'agy_start_plan must never ask Codex to regenerate PLAN text');
  assert.ok(planTool.inputSchema.properties?.planId);
  assert.ok(planTool.inputSchema.properties?.runId);
  assert.ok(planTool.inputSchema.properties?.cwd);

  assert.ok(followupTool.inputSchema.properties?.prompt, 'standalone follow-up remains supported');
  assert.ok(followupTool.inputSchema.properties?.findings, 'PLAN-bound follow-up must accept structured findings');
  assert.equal(followupTool.inputSchema.properties?.projectId, undefined);

  assert.ok(reviewTool.inputSchema.properties?.runId);
  assert.ok(reviewTool.inputSchema.properties?.planId);
  assert.equal(waitTool.inputSchema.properties?.timeoutSeconds?.maximum, 2000);
  assert.equal(waitTool.inputSchema.properties?.timeoutSeconds?.default, 2000);
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
    assert.equal(check.structuredContent?.serverVersion, '0.5.0');
    const streamingExpected = check.structuredContent?.streaming?.persistentDriver === true;

    const startArgs = {
      name: 'Smoke Worker - Restart Recovery',
      idempotencyKey: 'smoke-worker-restart-recovery-v050',
      prompt: 'Reply with exactly: AGY_WORKER_STARTED. Do not inspect or modify files.',
      cwd: path.resolve(here, '../../../..'),
      mode: 'plan',
      timeoutSeconds: 120,
    };
    const started = await first.client.callTool({ name: 'agy_start', arguments: startArgs });
    assertToolSucceeded('agy_start', started);
    const workerId = started.structuredContent?.workerId;
    const conversationId = started.structuredContent?.conversationId;
    const firstPid = started.structuredContent?.driverPid;
    const projectId = started.structuredContent?.agyProjectId;
    assert.equal(typeof workerId, 'string');
    assert.equal(typeof conversationId, 'string');

    if (streamingExpected) {
      assert.equal(started.structuredContent?.state, 'running');
      assert.equal(started.structuredContent?.done, false);
      const ledger = await readLedger(workerId);
      assert.equal(ledger.state, 'running');
      assert.equal(ledger.conversationId, conversationId);
      assert.equal('prompt' in ledger, false);
      assert.equal('response' in ledger, false);

      const retriedStart = await first.client.callTool({ name: 'agy_start', arguments: startArgs });
      assertToolSucceeded('agy_start retry', retriedStart);
      assert.equal(retriedStart.structuredContent?.workerId, workerId);
      assert.equal(retriedStart.structuredContent?.reused, true);
    }

    const startedFinal = streamingExpected
      ? await waitForResult(first.client, workerId, /AGY_WORKER_STARTED/)
      : started;
    assert.equal(startedFinal.structuredContent?.conversationId, conversationId);

    const followupArgs = {
      workerId,
      idempotencyKey: 'smoke-worker-restart-recovery-v050-followup-1',
      prompt: 'Reply with exactly: AGY_WORKER_RESUMED. Do not inspect or modify files.',
      timeoutSeconds: 120,
    };
    const followed = await first.client.callTool({ name: 'agy_followup', arguments: followupArgs });
    assertToolSucceeded('agy_followup warm', followed);
    if (streamingExpected) {
      assert.equal(followed.structuredContent?.state, 'running');
      assert.equal(followed.structuredContent?.driverPid, firstPid);
    }
    const followedFinal = streamingExpected
      ? await waitForResult(first.client, workerId, /AGY_WORKER_RESUMED/)
      : followed;
    assert.equal(followedFinal.structuredContent?.conversationId, conversationId);

    await first.client.close();
    first = undefined;
    await sleep(500);

    second = await openClient('second');
    await assertProtocolSurface(second.client);
    const recoveredStatus = await second.client.callTool({ name: 'agy_status', arguments: { workerId } });
    assertToolSucceeded('agy_status recovered', recoveredStatus);
    assert.equal(recoveredStatus.structuredContent?.conversationId, conversationId);
    assert.equal(recoveredStatus.structuredContent?.state, 'recoverable');
    assert.equal(recoveredStatus.structuredContent?.agyProjectId, projectId);

    const recovered = await second.client.callTool({
      name: 'agy_followup',
      arguments: {
        workerId,
        idempotencyKey: 'smoke-worker-restart-recovery-v050-followup-2',
        prompt: 'Reply with exactly: AGY_WORKER_RECOVERED. Do not inspect or modify files.',
        timeoutSeconds: 120,
      },
    });
    assertToolSucceeded('agy_followup recovered', recovered);
    if (streamingExpected) {
      assert.equal(recovered.structuredContent?.state, 'running');
      assert.equal(typeof recovered.structuredContent?.driverPid, 'number');
      assert.notEqual(recovered.structuredContent.driverPid, firstPid);
    }
    const recoveredFinal = streamingExpected
      ? await waitForResult(second.client, workerId, /AGY_WORKER_RECOVERED/)
      : recovered;
    assert.equal(recoveredFinal.structuredContent?.conversationId, conversationId);

    const noTurnCancel = await second.client.callTool({ name: 'agy_cancel', arguments: { workerId } });
    assertToolSucceeded('agy_cancel idle', noTurnCancel);
    assert.equal(noTurnCancel.structuredContent?.canceled, false);

    const closed = await second.client.callTool({ name: 'agy_close', arguments: { workerId } });
    assertToolSucceeded('agy_close', closed);
    assert.equal(closed.structuredContent?.closed, true);
    assert.equal(closed.structuredContent?.conversationId, conversationId);

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

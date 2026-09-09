import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-driver-test-'));
const driverOut = path.join(tempDir, 'driver.mjs');
const fakeAgy = path.join(tempDir, 'fake-agy.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await build({
    entryPoints: [path.resolve('src/driver.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: driverOut,
    logLevel: 'silent',
  });

  await writeFile(fakeAgy, `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const conversationId = 'driver-conversation-1';
const planCounterPath = join(process.cwd(), 'plan-counter.txt');
let turns = 0;
let input = 0;
let output = 0;
console.log(JSON.stringify({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), tools: ['fake_tool'], permission_mode: 'request-review' } }));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.event !== 'user') return;
  const content = message.message?.content ?? '';
  turns += 1;
  input += 10;
  output += 2;
  if (content === 'slow') await new Promise((resolve) => setTimeout(resolve, 100));
  if (content === 'cancel-me') await new Promise((resolve) => setTimeout(resolve, 10_000));

  const isLogicalPlan = content.startsWith('AGY EXECUTION POLICY') || content.startsWith('AGY INTERNAL PLAN CONTINUATION');
  if (isLogicalPlan) {
    let planTimeouts = 0;
    try { planTimeouts = Number(readFileSync(planCounterPath, 'utf8')) || 0; } catch {}
    if (planTimeouts < 2) {
      writeFileSync(planCounterPath, String(planTimeouts + 1), 'utf8');
      console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: turns, state: 'WORKING', step_type: 'tool', tool_name: 'fake_edit', text_delta: 'progress' } }));
      console.log(JSON.stringify({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', response: 'timeout waiting for response', error: 'timeout waiting for response', duration_seconds: turns, num_turns: turns, usage: { input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: input + output } } }));
      return;
    }
  }

  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: turns, state: 'DONE', step_type: 'agent_response', text_delta: String(content) } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response: String(content), duration_seconds: turns, num_turns: turns, usage: { input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: input + output } } }));
});
`, 'utf8');

  const { AgyPersistentDriver, buildAgyStreamUserMessage } = await import(pathToFileURL(driverOut).href);
  assert.equal(buildAgyStreamUserMessage('hello'), JSON.stringify({ event: 'user', message: { content: 'hello' } }));

  const events = [];
  const driver = new AgyPersistentDriver({ command: process.execPath, args: [fakeAgy], cwd: tempDir, onEvent: (event) => events.push(event) });
  const pid = driver.pid;
  assert.equal(typeof pid, 'number');

  const init = await driver.waitForInit(1_000);
  assert.equal(init?.conversationId, 'driver-conversation-1');
  assert.equal(init?.cwd, tempDir);
  assert.equal(driver.currentConversationId, 'driver-conversation-1');
  assert.equal(driver.isBusy, false);

  const firstPromise = driver.send('first', 2_000);
  assert.equal(driver.isBusy, true);
  const first = await firstPromise;
  assert.equal(first.timedOut, false);
  assert.equal(first.canceled, false);
  assert.equal(first.result?.conversationId, 'driver-conversation-1');
  assert.equal(first.result?.response, 'first');
  assert.equal(first.result?.numTurns, 1);
  assert.equal(first.result?.usage?.total_tokens, 12);
  assert.equal(driver.currentConversationId, 'driver-conversation-1');
  assert.equal(driver.pid, pid);
  assert.equal(driver.isAlive, true);

  const second = await driver.send('second', 2_000);
  assert.equal(second.result?.numTurns, 2);
  assert.equal(second.result?.usage?.total_tokens, 24);
  assert.equal(driver.pid, pid);
  assert.equal(events.filter((event) => event.event === 'init').length, 1);
  assert.equal(events.filter((event) => event.event === 'result').length, 2);
  assert.equal((await driver.waitForInit(1))?.conversationId, 'driver-conversation-1');

  const logical = await driver.send('AGY EXECUTION POLICY\nImplement PLAN-01.', 2_000);
  assert.equal(logical.result?.status, 'SUCCESS');
  assert.equal(logical.autoResumeCount, 2);
  assert.equal(logical.logicalTurnCount, 3);
  assert.equal(logical.logicalFailureKind, undefined);
  assert.equal(driver.currentConversationId, 'driver-conversation-1');
  assert.notEqual(driver.pid, pid, 'logical PLAN response-timeout recovery should relaunch the process');
  assert.equal(events.filter((event) => event.event === 'init').length, 3, 'initial process plus two conversation resumes should each initialize');

  const slow = driver.send('slow', 2_000);
  assert.equal(driver.isBusy, true);
  await assert.rejects(() => driver.send('overlap', 2_000), /already has a turn in progress/);
  await slow;
  assert.equal(driver.isBusy, false);
  await driver.close();
  assert.equal(driver.isAlive, false);
  assert.equal((await driver.waitForInit(1))?.conversationId, 'driver-conversation-1');

  const cancelDriver = new AgyPersistentDriver({ command: process.execPath, args: [fakeAgy], cwd: tempDir });
  assert.equal((await cancelDriver.waitForInit(1_000))?.conversationId, 'driver-conversation-1');
  const canceledTurn = cancelDriver.send('cancel-me', 15_000);
  await sleep(100);
  assert.equal(cancelDriver.isBusy, true);
  assert.equal(await cancelDriver.cancelCurrentTurn(), true);
  const canceled = await canceledTurn;
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.timedOut, false);
  await sleep(100);
  assert.equal(cancelDriver.isAlive, false);

  const signalDriver = new AgyPersistentDriver({ command: process.execPath, args: [fakeAgy], cwd: tempDir });
  assert.equal((await signalDriver.waitForInit(1_000))?.conversationId, 'driver-conversation-1');
  const controller = new AbortController();
  const signaledTurn = signalDriver.send('cancel-me', 15_000, controller.signal);
  await sleep(100);
  controller.abort();
  const signaled = await signaledTurn;
  assert.equal(signaled.canceled, true);
  await sleep(100);
  assert.equal(signalDriver.isAlive, false);

  const stalledAgy = path.join(tempDir, 'stalled-agy.mjs');
  await writeFile(stalledAgy, `
import { createInterface } from 'node:readline';
const conversationId = 'stalled-conversation';
console.log(JSON.stringify({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd() } }));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', () => {
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', response: 'timeout waiting for response', error: 'timeout waiting for response' } }));
});
`, 'utf8');
  const stalledDriver = new AgyPersistentDriver({ command: process.execPath, args: [stalledAgy], cwd: tempDir });
  assert.equal((await stalledDriver.waitForInit(1_000))?.conversationId, 'stalled-conversation');
  const stalled = await stalledDriver.send('AGY EXECUTION POLICY\nImplement PLAN-01.', 2_000);
  assert.equal(stalled.logicalFailureKind, 'logical_plan_stalled');
  assert.equal(stalled.autoResumeCount, 1);
  assert.equal(stalled.logicalTurnCount, 2);
  assert.match(stalled.result?.error ?? '', /LOGICAL_PLAN_STALLED/);
  await stalledDriver.close();

  const neverInit = path.join(tempDir, 'never-init.mjs');
  await writeFile(neverInit, `setTimeout(() => {}, 10_000);`, 'utf8');
  const noInitDriver = new AgyPersistentDriver({ command: process.execPath, args: [neverInit], cwd: tempDir });
  assert.equal(await noInitDriver.waitForInit(20), undefined);
  await noInitDriver.close(10);

  const missingCwdAgy = path.join(tempDir, 'missing-cwd.mjs');
  await writeFile(missingCwdAgy, `console.log(JSON.stringify({ event: 'init', conversation_id: 'missing-cwd', init: {} })); setTimeout(() => {}, 10000);`, 'utf8');
  const missingCwdDriver = new AgyPersistentDriver({ command: process.execPath, args: [missingCwdAgy], cwd: tempDir });
  await assert.rejects(() => missingCwdDriver.waitForInit(1_000), /did not report cwd/);
  await sleep(100);
  assert.equal(missingCwdDriver.isAlive, false);

  const wrongCwdAgy = path.join(tempDir, 'wrong-cwd.mjs');
  await writeFile(wrongCwdAgy, `
console.log(JSON.stringify({ event: 'init', conversation_id: 'wrong-cwd', init: { cwd: ${JSON.stringify(path.join(tempDir, 'somewhere-else'))} } }));
process.stdin.on('data', () => { console.error('PROMPT_SHOULD_NOT_BE_SENT'); process.exitCode = 17; });
setTimeout(() => {}, 10000);
`, 'utf8');
  const mismatchEvents = [];
  const mismatchDriver = new AgyPersistentDriver({ command: process.execPath, args: [wrongCwdAgy], cwd: tempDir, onEvent: (event) => mismatchEvents.push(event) });
  await assert.rejects(() => mismatchDriver.waitForInit(1_000), /workspace mismatch/);
  assert.equal(mismatchEvents.length, 0, 'invalid init must not be surfaced as an accepted AGY event');
  await sleep(100);
  assert.equal(mismatchDriver.isAlive, false);

  console.error('AGY persistent driver test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

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
const conversationId = 'driver-conversation-1';
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

  const first = await driver.send('first', 2_000);
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

  const slow = driver.send('slow', 2_000);
  assert.equal(driver.isBusy, true);
  await assert.rejects(() => driver.send('overlap', 2_000), /already has a turn in progress/);
  await slow;
  assert.equal(driver.isBusy, false);
  await driver.close();
  assert.equal(driver.isAlive, false);

  const cancelDriver = new AgyPersistentDriver({ command: process.execPath, args: [fakeAgy], cwd: tempDir });
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
  const controller = new AbortController();
  const signaledTurn = signalDriver.send('cancel-me', 15_000, controller.signal);
  await sleep(100);
  controller.abort();
  const signaled = await signaledTurn;
  assert.equal(signaled.canceled, true);
  await sleep(100);
  assert.equal(signalDriver.isAlive, false);

  console.error('AGY persistent driver test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

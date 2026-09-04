import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-stream-test-'));
const outfile = path.join(tempDir, 'streaming.mjs');

try {
  await build({
    entryPoints: [path.resolve('src/streaming.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });

  const { detectAgyStreamingCapabilities, parseAgyStreamLine } = await import(pathToFileURL(outfile).href);

  const init = parseAgyStreamLine(JSON.stringify({
    event: 'init',
    conversation_id: 'conversation-1',
    init: {
      cwd: 'D:/repo',
      tools: ['run_command', 'write_to_file'],
      permission_mode: 'request-review',
      model: 'gemini-example-high',
    },
  }));
  assert.deepEqual(init, {
    event: 'init',
    conversationId: 'conversation-1',
    cwd: 'D:/repo',
    tools: ['run_command', 'write_to_file'],
    permissionMode: 'request-review',
    model: 'gemini-example-high',
    agent: undefined,
  });

  const update = parseAgyStreamLine(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conversation-1',
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      duration_seconds: 0.2,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      tool_info: { name: 'run_command', output: 'ok' },
    },
  }));
  assert.equal(update?.event, 'step_update');
  assert.equal(update?.conversationId, 'conversation-1');
  assert.equal(update?.stepType, 'tool');
  assert.equal(update?.toolName, 'run_command');
  assert.equal(update?.usage?.total_tokens, 12);

  const result = parseAgyStreamLine(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'conversation-1',
      status: 'SUCCESS',
      response: 'done',
      duration_seconds: 2.5,
      num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  }));
  assert.equal(result?.event, 'result');
  assert.equal(result?.conversationId, 'conversation-1');
  assert.equal(result?.status, 'SUCCESS');
  assert.equal(result?.numTurns, 2);

  assert.equal(parseAgyStreamLine('not-json'), undefined);
  assert.equal(parseAgyStreamLine('{"event":"future_event","payload":{}}'), undefined);
  assert.equal(parseAgyStreamLine('{"event":"result","result":{"status":"SUCCESS","response":"missing id"}}'), undefined);

  assert.deepEqual(
    detectAgyStreamingCapabilities('Options: --input-format <format> --output-format <text|json|stream-json>'),
    { streamOutput: true, streamInput: true, persistentDriver: true },
  );
  assert.deepEqual(
    detectAgyStreamingCapabilities('Options: --output-format <text|json>'),
    { streamOutput: false, streamInput: false, persistentDriver: false },
  );

  console.error('AGY streaming protocol test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

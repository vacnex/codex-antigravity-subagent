import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-store-test-'));
const outfile = path.join(tempDir, 'store.mjs');
const stateDir = path.join(tempDir, 'state');

try {
  await build({
    entryPoints: [path.resolve('src/store.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });

  const {
    WorkerStore,
    isWorkerLedgerRecord,
    resolveWorkerStateDir,
  } = await import(pathToFileURL(outfile).href);

  assert.equal(
    resolveWorkerStateDir({ CODEX_HOME: 'D:/codex-home' }, 'D:/home'),
    path.resolve('D:/codex-home', 'antigravity-subagent', 'workers'),
  );
  assert.equal(
    resolveWorkerStateDir({ AGY_MCP_STATE_DIR: 'D:/custom-state', CODEX_HOME: 'D:/codex-home' }, 'D:/home'),
    path.resolve('D:/custom-state'),
  );

  const store = new WorkerStore(stateDir);
  assert.deepEqual(await store.list(), []);

  const createdAt = '2026-09-04T08:00:00.000Z';
  const initial = {
    schemaVersion: 1,
    workerId: 'agy_123e4567-e89b-12d3-a456-426614174000',
    conversationId: 'conversation-1',
    cwd: 'D:/repo',
    mode: 'accept-edits',
    model: 'gemini-example-high',
    effort: 'high',
    createdAt,
    updatedAt: createdAt,
    lastTransport: 'stream',
    lastDriverPid: 1234,
    lastResultStatus: 'SUCCESS',
    lastDurationSeconds: 1.25,
    lastNumTurns: 1,
    lastUsage: {
      input_tokens: 100,
      output_tokens: 20,
      thinking_tokens: 10,
      cache_read_tokens: 5,
      total_tokens: 135,
    },
    lastTimedOut: false,
  };

  assert.equal(isWorkerLedgerRecord(initial), true);
  await store.write(initial);
  assert.deepEqual(await store.read(initial.workerId), initial);
  assert.deepEqual(await store.list(), [initial]);

  // Writing the same worker again exercises replace-existing rename semantics,
  // including the Windows path used by the release gate.
  const updated = {
    ...initial,
    conversationId: 'conversation-1',
    updatedAt: '2026-09-04T08:05:00.000Z',
    lastNumTurns: 2,
    lastUsage: {
      input_tokens: 180,
      output_tokens: 35,
      thinking_tokens: 15,
      cache_read_tokens: 10,
      total_tokens: 240,
    },
  };
  await store.write(updated);
  assert.deepEqual(await store.read(initial.workerId), updated);

  const closed = {
    ...updated,
    updatedAt: '2026-09-04T08:10:00.000Z',
    closedAt: '2026-09-04T08:10:00.000Z',
  };
  await store.write(closed);
  assert.deepEqual(await store.read(initial.workerId), closed);

  const files = await readdir(stateDir);
  assert.deepEqual(files.filter((entry) => entry.endsWith('.tmp')), []);
  assert.deepEqual(files.filter((entry) => entry.endsWith('.json')), [`${initial.workerId}.json`]);

  await writeFile(path.join(stateDir, 'agy_corrupt.json'), '{not-json', 'utf8');
  assert.deepEqual(await store.list(), [closed]);
  await assert.rejects(() => store.read('agy_corrupt'), /Invalid JSON/);
  await assert.rejects(
    () => store.read('../escape'),
    /Invalid Antigravity worker ID/,
  );

  console.error('AGY worker ledger store test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

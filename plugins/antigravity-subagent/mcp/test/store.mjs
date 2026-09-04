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
  await build({ entryPoints: [path.resolve('src/store.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const { WorkerStore, isWorkerLedgerRecord, resolveWorkerStateDir } = await import(pathToFileURL(outfile).href);

  assert.equal(resolveWorkerStateDir({ CODEX_HOME: 'D:/codex-home' }, 'D:/home'), path.resolve('D:/codex-home', 'antigravity-subagent', 'workers'));
  assert.equal(resolveWorkerStateDir({ AGY_MCP_STATE_DIR: 'D:/custom-state', CODEX_HOME: 'D:/codex-home' }, 'D:/home'), path.resolve('D:/custom-state'));

  const store = new WorkerStore(stateDir);
  assert.deepEqual(await store.list(), []);

  const createdAt = '2026-09-04T08:00:00.000Z';
  const initial = {
    schemaVersion: 1,
    workerId: 'agy_123e4567-e89b-12d3-a456-426614174000',
    conversationId: 'conversation-1',
    name: 'Plan 1 - recovery',
    cwd: 'D:/repo',
    mode: 'accept-edits',
    model: 'gemini-example-high',
    effort: 'high',
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
    state: 'ready',
    lastTransport: 'stream',
    lastDriverPid: 1234,
    lastResultStatus: 'SUCCESS',
    lastDurationSeconds: 1.25,
    lastNumTurns: 1,
    lastUsage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 5, total_tokens: 135 },
    lastTurnUsage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 5, total_tokens: 135 },
    lastTimedOut: false,
    lastCanceled: false,
  };

  assert.equal(isWorkerLedgerRecord(initial), true);
  await store.write(initial);
  assert.deepEqual(await store.read(initial.workerId), initial);

  const updated = {
    ...initial,
    updatedAt: '2026-09-04T08:05:00.000Z',
    lastActivityAt: '2026-09-04T08:05:00.000Z',
    state: 'recoverable',
    lastNumTurns: 2,
    lastUsage: { input_tokens: 180, output_tokens: 35, thinking_tokens: 15, cache_read_tokens: 10, total_tokens: 240 },
    lastTurnUsage: { input_tokens: 80, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 5, total_tokens: 105 },
  };
  await store.write(updated);
  assert.deepEqual(await store.read(initial.workerId), updated);

  const owner1 = 'mcp_owner_1';
  const owner2 = 'mcp_owner_2';
  const owner3 = 'mcp_owner_3';
  const firstLease = await store.acquireLease(initial.workerId, owner1, 60_000);
  assert.equal(firstLease.acquired, true);
  assert.equal(firstLease.lease?.ownerId, owner1);
  const blocked = await store.acquireLease(initial.workerId, owner2, 60_000);
  assert.equal(blocked.acquired, false);
  assert.match(blocked.reason ?? '', /leased by MCP process/);
  assert.equal(await store.refreshLease(initial.workerId, owner1, 60_000), true);
  assert.equal(await store.releaseLease(initial.workerId, owner2), false);
  assert.equal(await store.releaseLease(initial.workerId, owner1), true);
  assert.equal(await store.readLease(initial.workerId), undefined);

  await writeFile(store.leasePath(initial.workerId), JSON.stringify({
    schemaVersion: 1,
    workerId: initial.workerId,
    ownerId: 'dead-owner',
    processPid: 2147483000,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), 'utf8');
  const contenders = await Promise.all([
    store.acquireLease(initial.workerId, owner2, 60_000),
    store.acquireLease(initial.workerId, owner3, 60_000),
  ]);
  assert.equal(contenders.filter((entry) => entry.acquired).length, 1);
  const winner = contenders.find((entry) => entry.acquired)?.lease?.ownerId;
  assert.ok(winner === owner2 || winner === owner3);
  const liveLease = await store.readLease(initial.workerId);
  assert.equal(liveLease?.ownerId, winner);
  await store.releaseLease(initial.workerId, winner);

  const closed = { ...updated, state: 'closed', updatedAt: '2026-09-04T08:10:00.000Z', closedAt: '2026-09-04T08:10:00.000Z' };
  await store.write(closed);
  assert.deepEqual(await store.read(initial.workerId), closed);

  const files = await readdir(stateDir);
  assert.deepEqual(files.filter((entry) => entry.endsWith('.tmp')), []);
  assert.deepEqual(files.filter((entry) => entry.endsWith('.lease.json')), []);
  assert.deepEqual(files.filter((entry) => entry.endsWith('.lease.reclaim')), []);

  await writeFile(path.join(stateDir, 'agy_corrupt.json'), '{not-json', 'utf8');
  const listed = await store.listWithWarnings();
  assert.deepEqual(listed.records, [closed]);
  assert.equal(listed.warnings.length, 1);
  await assert.rejects(() => store.read('agy_corrupt'));
  await assert.rejects(() => store.read('../escape'), /Invalid Antigravity worker ID/);

  console.error('AGY worker ledger store test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-result-semantics-test-'));
const outfile = path.join(tempDir, 'result-semantics.mjs');

try {
  await build({ entryPoints: [path.resolve('src/result-semantics.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const { normalizeManagedResult } = await import(pathToFileURL(outfile).href);

  const responseTimeout = normalizeManagedResult({
    content: [{ type: 'text', text: 'timeout waiting for response' }],
    structuredContent: {
      done: true,
      transport: 'stream',
      status: 'ERROR',
      timedOut: false,
      canceled: false,
    },
    isError: true,
  });
  assert.equal(responseTimeout.isError, false);
  assert.equal(responseTimeout.structuredContent.transportStatus, 'ok');
  assert.equal(responseTimeout.structuredContent.agyStatus, 'ERROR');
  assert.equal(responseTimeout.structuredContent.failureKind, 'agy_response_timeout');
  assert.equal(responseTimeout.structuredContent.reportAvailable, false);
  assert.equal(responseTimeout.structuredContent.retryable, true);

  const success = normalizeManagedResult({
    content: [{ type: 'text', text: 'FINAL_STATUS: PASS' }],
    structuredContent: { done: true, transport: 'stream', status: 'SUCCESS', timedOut: false, canceled: false },
    isError: false,
  });
  assert.equal(success.structuredContent.transportStatus, 'ok');
  assert.equal(success.structuredContent.failureKind, 'none');
  assert.equal(success.structuredContent.reportAvailable, true);

  const transportTimeout = normalizeManagedResult({
    content: [{ type: 'text', text: 'Antigravity timed out after 900 seconds.' }],
    structuredContent: { done: true, transport: 'stream', status: 'ERROR', timedOut: true, canceled: false },
    isError: true,
  });
  assert.equal(transportTimeout.isError, true);
  assert.equal(transportTimeout.structuredContent.transportStatus, 'timeout');
  assert.equal(transportTimeout.structuredContent.failureKind, 'transport_timeout');

  const oneShotCrash = normalizeManagedResult({
    content: [{ type: 'text', text: 'process failed' }],
    structuredContent: { done: true, transport: 'oneshot', status: 'ERROR', exitCode: 1, timedOut: false, canceled: false },
    isError: true,
  });
  assert.equal(oneShotCrash.isError, true);
  assert.equal(oneShotCrash.structuredContent.transportStatus, 'crashed');
  assert.equal(oneShotCrash.structuredContent.failureKind, 'process_exit');

  const running = normalizeManagedResult({
    content: [{ type: 'text', text: 'still running' }],
    structuredContent: { done: false, state: 'running', status: 'RUNNING' },
  });
  assert.equal(running.structuredContent.transportStatus, 'running');
  assert.equal(running.structuredContent.failureKind, 'none');

  const persistedError = normalizeManagedResult({
    content: [{ type: 'text', text: 'last turn failed' }],
    structuredContent: { done: true, status: 'ERROR', lastError: 'timeout waiting for response' },
    isError: true,
  });
  assert.equal(persistedError.isError, true);
  assert.equal(persistedError.structuredContent.transportStatus, 'unknown');
  assert.equal(persistedError.structuredContent.failureKind, 'agy_response_timeout');

  console.error('AGY managed result semantics test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

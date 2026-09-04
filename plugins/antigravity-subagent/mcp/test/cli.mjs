import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-cli-test-'));
const outfile = path.join(tempDir, 'cli.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await build({ entryPoints: [path.resolve('src/cli.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const { buildOneShotArgs, runAgy } = await import(pathToFileURL(outfile).href);

  const pinned = buildOneShotArgs('hello', {
    cwd: tempDir,
    mode: 'plan',
    model: 'gemini-example-high',
    effort: 'high',
  });
  assert.deepEqual(pinned.filter((value) => value === '--effort'), []);

  const unpinned = buildOneShotArgs('hello', {
    cwd: tempDir,
    mode: 'plan',
    model: 'claude-example',
    effort: 'medium',
  });
  assert.equal(unpinned.includes('--effort'), true);
  assert.equal(unpinned[unpinned.indexOf('--effort') + 1], 'medium');

  const controller = new AbortController();
  const canceledPromise = runAgy(
    process.execPath,
    ['-e', 'setTimeout(() => console.log("late"), 10000)'],
    tempDir,
    15_000,
    { signal: controller.signal },
  );
  await sleep(100);
  controller.abort();
  const canceled = await canceledPromise;
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.timedOut, false);

  const timedOut = await runAgy(
    process.execPath,
    ['-e', 'setTimeout(() => console.log("late"), 10000)'],
    tempDir,
    100,
  );
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.canceled, false);

  console.error('AGY CLI runner test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

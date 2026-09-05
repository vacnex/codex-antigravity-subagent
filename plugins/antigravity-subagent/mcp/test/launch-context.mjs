import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-launch-context-test-'));
const outfile = path.join(tempDir, 'launch-context.mjs');

try {
  await build({ entryPoints: [path.resolve('src/launch-context.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const { appendAgyProjectArgs, withAgyProjectLaunch } = await import(pathToFileURL(outfile).href);

  const noContext = [];
  appendAgyProjectArgs(noContext);
  assert.deepEqual(noContext, []);

  const existing = await withAgyProjectLaunch({ kind: 'existing', projectId: 'project-a' }, async () => {
    const args = [];
    appendAgyProjectArgs(args);
    return args;
  });
  assert.deepEqual(existing, ['--project', 'project-a']);

  const created = await withAgyProjectLaunch({ kind: 'new' }, async () => {
    const args = [];
    appendAgyProjectArgs(args);
    return args;
  });
  assert.deepEqual(created, ['--new-project']);

  const resumed = await withAgyProjectLaunch({ kind: 'existing', projectId: 'project-a' }, async () => {
    const args = [];
    appendAgyProjectArgs(args, 'conversation-1');
    return args;
  });
  assert.deepEqual(resumed, [], 'conversation resume must inherit its existing AGY Project');

  const [first, second] = await Promise.all([
    withAgyProjectLaunch({ kind: 'existing', projectId: 'project-a' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const args = [];
      appendAgyProjectArgs(args);
      return args;
    }),
    withAgyProjectLaunch({ kind: 'existing', projectId: 'project-b' }, async () => {
      const args = [];
      appendAgyProjectArgs(args);
      return args;
    }),
  ]);
  assert.deepEqual(first, ['--project', 'project-a']);
  assert.deepEqual(second, ['--project', 'project-b']);

  console.error('AGY launch context test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

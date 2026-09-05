import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-launch-selection-test-'));
const outfile = path.join(tempDir, 'launch-selection.mjs');

const projectA = { id: 'project-a', name: 'Project A', roots: ['D:\\path1', 'D:\\path2'], sourceFile: 'a.json' };
const projectB = { id: 'project-b', name: 'Project B', roots: ['D:\\path2', 'D:\\path4'], sourceFile: 'b.json' };

function ctx(inputResponses) {
  return { mcpReq: { inputResponses } };
}

try {
  await build({ entryPoints: [path.resolve('src/launch-selection.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const { resolveLaunchSelection } = await import(pathToFileURL(outfile).href);

  const ambiguous = { kind: 'ambiguous', candidates: [projectA, projectB] };
  const pending = await resolveLaunchSelection(ctx(undefined), {
    executable: 'unused-because-model-is-explicit',
    cwd: 'D:\\path2',
    requestedModel: 'gemini-example-high',
    requestedEffort: 'high',
    projectResolution: ambiguous,
  });
  assert.equal(pending.resultType, 'input_required');
  assert.ok(pending.inputRequests?.launch);
  assert.equal(pending.inputRequests.launch.method, 'elicitation/create');
  const schema = pending.inputRequests.launch.params.requestedSchema;
  assert.deepEqual(schema.properties.projectId.enum, ['project-a', 'project-b']);
  assert.equal(schema.properties.model, undefined, 'explicit model must not be requested again');
  assert.equal(schema.properties.effort, undefined, 'explicit effort must not be requested again');

  const selected = await resolveLaunchSelection(ctx({
    launch: { action: 'accept', content: { projectId: 'project-b' } },
  }), {
    executable: 'unused',
    cwd: 'D:\\path2',
    requestedModel: 'gemini-example-high',
    requestedEffort: 'high',
    projectResolution: ambiguous,
  });
  assert.equal(selected.kind, 'ready');
  assert.equal(selected.project?.id, 'project-b');
  assert.deepEqual(selected.projectLaunch, { kind: 'existing', projectId: 'project-b' });
  assert.equal(selected.projectResolution, 'selected');
  assert.equal(selected.model, 'gemini-example-high');
  assert.equal(selected.effort, 'high');

  const declined = await resolveLaunchSelection(ctx({ launch: { action: 'decline' } }), {
    executable: 'unused',
    cwd: 'D:\\path2',
    requestedModel: 'gemini-example-high',
    requestedEffort: 'high',
    projectResolution: ambiguous,
  });
  assert.equal(declined.kind, 'error');
  assert.equal(declined.code, 'user_declined');

  const auto = await resolveLaunchSelection(ctx(undefined), {
    executable: 'unused',
    cwd: 'D:\\path2',
    requestedModel: 'gemini-example-high',
    requestedEffort: 'high',
    projectResolution: { kind: 'auto', project: projectA },
  });
  assert.equal(auto.kind, 'ready');
  assert.equal(auto.projectResolution, 'auto');
  assert.deepEqual(auto.projectLaunch, { kind: 'existing', projectId: 'project-a' });

  const create = await resolveLaunchSelection(ctx(undefined), {
    executable: 'unused',
    cwd: 'D:\\new',
    requestedModel: 'gemini-example-high',
    requestedEffort: 'high',
    projectResolution: { kind: 'create' },
  });
  assert.equal(create.kind, 'ready');
  assert.equal(create.projectResolution, 'created');
  assert.deepEqual(create.projectLaunch, { kind: 'new' });

  const pinnedMismatch = await resolveLaunchSelection(ctx(undefined), {
    executable: 'unused',
    cwd: 'D:\\path2',
    requestedModel: 'gemini-example-high',
    requestedEffort: 'medium',
    projectResolution: { kind: 'auto', project: projectA },
  });
  assert.equal(pinnedMismatch.kind, 'error');
  assert.equal(pinnedMismatch.code, 'invalid_effort_selection');

  console.error('AGY launch selection test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

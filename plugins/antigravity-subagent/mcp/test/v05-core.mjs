import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-v05-core-'));
const bundledRoot = path.join(tempRoot, 'bundles');
await mkdir(bundledRoot, { recursive: true });

async function loadSourceModule(name) {
  const outfile = path.join(bundledRoot, `${name}.mjs`);
  await build({
    entryPoints: [path.join(mcpRoot, 'src', `${name}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}-${Math.random()}`);
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

try {
  const blueprintModule = await loadSourceModule('blueprint');
  const transcriptModule = await loadSourceModule('codex-transcript');
  const storeModule = await loadSourceModule('blueprint-store');
  const runStoreModule = await loadSourceModule('run-store');
  const promptModule = await loadSourceModule('plan-prompt');
  const baselineModule = await loadSourceModule('git-baseline');

  const workspace = path.join(tempRoot, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'target.txt'), 'before\n', 'utf8');
  await writeFile(path.join(workspace, 'src', 'reference.txt'), 'REFERENCE_PATTERN\n', 'utf8');
  await writeFile(path.join(workspace, 'user.txt'), 'committed user state\n', 'utf8');

  git(workspace, 'init');
  git(workspace, 'config', 'user.email', 'agy-test@example.invalid');
  git(workspace, 'config', 'user.name', 'AGY MCP Test');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'baseline');
  const head = git(workspace, 'rev-parse', 'HEAD').trim();

  const canonical = `<!-- AGY_BLUEPRINT:v1:START -->\nBlueprint status: READY\nBlueprint depth: Standard Blueprint\n\nBlueprint basis:\n- Workspace: ${workspace}\n- Git HEAD: ${head}\n\n## Implementation Tasks\n\n### PLAN-01: Update target safely\n\n#### Depends on\nNone\n\n#### Goal\nUpdate the approved target while preserving unrelated user work.\n\n#### Write scope\n- \`src/target.txt\`\n\n#### Forbidden scope\n- \`forbidden.txt\`\n\n#### Required read set\n- \`src/reference.txt\` — authoritative naming/content precedent\n\n#### Required conventions\nFollow REFERENCE_PATTERN and do not invent another convention.\n\n#### Required changes\nChange only the approved target content.\n\n#### Implementation logic\nUse the supplied reference and keep the edit bounded.\n\n#### Failure and boundary behavior\nStop if another write target is required.\n\n#### Acceptance criteria\nThe target is updated and unrelated user changes remain intact.\n\n#### Canonical validation\n\`\`\`text\ngit status --short\n\`\`\`\n\n#### Stop if\nA material decision or out-of-scope write is required.\n\n<!-- AGY_BLUEPRINT:v1:END -->`;

  const parsed = blueprintModule.parseBlueprint(canonical);
  assert.equal(parsed.status, 'READY');
  assert.equal(parsed.workspace, path.resolve(workspace));
  assert.equal(parsed.plans.length, 1);
  assert.deepEqual(parsed.plans[0].writeScope, ['src/target.txt']);
  assert.deepEqual(parsed.plans[0].forbiddenScope, ['forbidden.txt']);
  assert.equal(parsed.plans[0].requiredReadSet[0].path, 'src/reference.txt');
  assert.equal(blueprintModule.extractValidationCommand(parsed.plans[0].canonicalValidation), 'git status --short');

  const threadId = '11111111-2222-4333-8444-555555555555';
  const codexHome = path.join(tempRoot, 'codex-home');
  const rolloutDir = path.join(codexHome, 'sessions', '2026', '09', '07');
  await mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(rolloutDir, `rollout-2026-09-07T12-00-00-${threadId}.jsonl`);
  const rolloutLine = {
    timestamp: '2026-09-07T12:00:00Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: `Planning complete.\n\n${canonical}\n` }],
    },
  };
  await writeFile(rolloutPath, `${JSON.stringify(rolloutLine)}\n`, 'utf8');

  const captured = await transcriptModule.captureLatestBlueprintFromThread(threadId, codexHome);
  assert.equal(captured.threadId, threadId);
  assert.equal(captured.rolloutPath, rolloutPath);
  assert.equal(captured.canonicalText, canonical);

  const blueprintStore = new storeModule.BlueprintStore(path.join(tempRoot, 'blueprints'));
  const stored = await blueprintStore.save(captured.canonicalText, threadId);
  const reread = await blueprintStore.read(stored.blueprintId);
  assert.equal(reread.blueprintId, stored.blueprintId);
  assert.equal(reread.blueprint.canonicalText, canonical);
  assert.equal(storeModule.blueprintIdFor(reread.blueprint), stored.blueprintId);
  assert.equal('prompt' in reread.metadata, false);

  const runStore = new runStoreModule.RunStore(path.join(tempRoot, 'runs'));
  let run = await runStore.create({ blueprintId: stored.blueprintId, threadId, cwd: workspace });
  assert.equal(run.blueprintId, stored.blueprintId);
  assert.equal(run.cwd, path.resolve(workspace));
  assert.deepEqual(run.plans, {});

  const prompt = await promptModule.buildInitialPlanPrompt(workspace, reread.blueprint, reread.blueprint.plans[0]);
  assert.match(prompt, /AGY EXECUTION POLICY/);
  assert.match(prompt, /REFERENCE_PATTERN/);
  assert.match(prompt, /APPROVED PLAN/);
  assert.match(prompt, /Do not perform repository-wide discovery/);

  // Simulate a user edit that already existed before the AGY worker began.
  await writeFile(path.join(workspace, 'user.txt'), 'pre-existing user edit\n', 'utf8');

  const baselineDir = runStore.baselineDir(run.runId, 'PLAN-01');
  const baseline = await baselineModule.capturePlanBaseline(workspace, reread.blueprint.plans[0], baselineDir);
  run = await runStore.attachPlanWorker({
    runId: run.runId,
    planId: 'PLAN-01',
    workerId: 'worker-v05-core',
    conversationId: 'conversation-v05-core',
    idempotencyKey: `${run.runId}:PLAN-01`,
    baselineId: baseline.baselineId,
    agyProjectId: 'project-v05-core',
    model: 'test-model',
    effort: 'medium',
  });
  assert.equal(run.plans['PLAN-01'].workerId, 'worker-v05-core');
  const binding = await runStore.findByWorkerId('worker-v05-core');
  assert.equal(binding?.planId, 'PLAN-01');
  assert.equal(binding?.run.runId, run.runId);

  // Simulate worker changes: one approved, one forbidden, and one mutation of the user's pre-existing edit.
  await writeFile(path.join(workspace, 'src', 'target.txt'), 'after\n', 'utf8');
  await writeFile(path.join(workspace, 'forbidden.txt'), 'must not be written\n', 'utf8');
  await writeFile(path.join(workspace, 'user.txt'), 'worker overwrote user edit\n', 'utf8');

  const review = await baselineModule.reviewPlanBaseline(
    workspace,
    reread.blueprint.plans[0],
    baselineDir,
    baseline.baselineId,
  );
  assert.deepEqual(review.changedFiles, ['src/target.txt']);
  assert.ok(review.unauthorizedChanges.includes('forbidden.txt'));
  assert.ok(review.unauthorizedChanges.includes('user.txt'));
  assert.ok(review.forbiddenChanges.includes('forbidden.txt'));
  assert.ok(review.preExistingOutsideScopeModified.includes('user.txt'));
  assert.match(review.diff, /src\/target\.txt/);
  assert.match(review.diff, /after/);

  const persistedRunText = await readFile(runStore.filePath(run.runId), 'utf8');
  assert.doesNotMatch(persistedRunText, /REFERENCE_PATTERN/);
  assert.doesNotMatch(persistedRunText, /AGY EXECUTION POLICY/);
  assert.doesNotMatch(persistedRunText, /worker overwrote user edit/);

  console.error('v0.5 core functional regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

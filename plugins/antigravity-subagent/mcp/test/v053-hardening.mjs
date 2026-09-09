import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const pluginRoot = path.resolve(mcpRoot, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-v053-hardening-'));
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

try {
  const reviewModule = await loadSourceModule('plan-review');
  const resultModule = await loadSourceModule('result-semantics');
  const runStoreModule = await loadSourceModule('run-store');

  const msbuild = '"D:\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe" "PMT.HauGiang.Portal\\PMT.HauGiang.Portal.csproj" /t:Build /p:Configuration=Debug';
  assert.deepEqual(reviewModule.parseDirectCommand(msbuild), {
    executable: 'D:\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
    args: [
      'PMT.HauGiang.Portal\\PMT.HauGiang.Portal.csproj',
      '/t:Build',
      '/p:Configuration=Debug',
    ],
  });
  assert.equal(reviewModule.validationCommandIssue(msbuild, 'win32'), undefined);
  assert.match(
    reviewModule.validationCommandIssue('D:\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe project.csproj /t:Build', 'win32') ?? '',
    /VALIDATION_COMMAND_INVALID/,
  );
  assert.match(reviewModule.validationCommandIssue('node test.mjs && echo nope') ?? '', /shell operator/);
  assert.match(reviewModule.validationCommandIssue('node test.mjs | more') ?? '', /shell operator/);

  const stalled = resultModule.normalizeManagedResult({
    content: [{ type: 'text', text: 'LOGICAL_PLAN_STALLED: no progress' }],
    structuredContent: { done: true, transport: 'stream', status: 'ERROR' },
    isError: true,
  });
  assert.equal(stalled.structuredContent.failureKind, 'logical_plan_stalled');
  assert.equal(stalled.structuredContent.retryable, true);
  assert.equal(stalled.isError, false, 'terminal AGY envelope remains a successful MCP transport result');

  const exhausted = resultModule.normalizeManagedResult({
    content: [{ type: 'text', text: 'LOGICAL_PLAN_RECOVERY_EXHAUSTED: recovery budget reached' }],
    structuredContent: { done: true, transport: 'stream', status: 'ERROR' },
  });
  assert.equal(exhausted.structuredContent.failureKind, 'logical_plan_recovery_exhausted');

  const runRoot = path.join(tempRoot, 'runs');
  const runStore = new runStoreModule.RunStore(runRoot);
  const emptyRun = await runStore.create({ blueprintId: 'bp_test', threadId: 'thread-test', cwd: tempRoot });
  await runStore.updatePlanState(emptyRun.runId, 'PLAN-01', { baselineId: 'baseline-test' });
  assert.equal(await runStore.deleteRunIfEmpty(emptyRun.runId), true, 'unattached execution run should be removable transactionally');
  await assert.rejects(() => runStore.read(emptyRun.runId));

  const attachedRun = await runStore.create({ blueprintId: 'bp_test', threadId: 'thread-test', cwd: tempRoot });
  await runStore.attachPlanWorker({
    runId: attachedRun.runId,
    planId: 'PLAN-01',
    workerId: 'agy_worker-test',
    conversationId: 'conversation-test',
    idempotencyKey: `${attachedRun.runId}:PLAN-01`,
    baselineId: 'baseline-test',
  });
  assert.equal(await runStore.deleteRunIfEmpty(attachedRun.runId), false, 'attached PLAN worker must preserve its run');
  const attachedState = (await runStore.read(attachedRun.runId)).plans['PLAN-01'];
  assert.equal(attachedState.autoResumeCount, 0);
  assert.ok(attachedState.logicalStartedAt);

  const blueprintSkill = await readFile(path.join(pluginRoot, 'skills', 'execution-blueprint', 'SKILL.md'), 'utf8');
  const executeSkill = await readFile(path.join(pluginRoot, 'skills', 'execute-plan', 'SKILL.md'), 'utf8');

  assert.match(blueprintSkill, /trace the affected runtime\/effect path/i);
  assert.match(blueprintSkill, /Conditional planning checks/);
  assert.match(blueprintSkill, /Integration \/ cross-service/);
  assert.match(blueprintSkill, /Apply these checks only when repository evidence shows they are relevant/i);
  assert.match(blueprintSkill, /must not remove or bypass an existing service, proxy, authentication, persistence, or trust boundary/i);
  assert.match(blueprintSkill, /shell=false/);
  assert.match(blueprintSkill, /Shell composition\/operators are not allowed/);

  assert.match(executeSkill, /logical worker/i);
  assert.match(executeSkill, /normal Codex orchestration should not see or manually service/i);
  assert.match(executeSkill, /implementation contract for AGY; it is \*\*not proof/i);
  assert.match(executeSkill, /Implementation ↔ repository reality\/user intent/i);
  assert.match(executeSkill, /Retrace the \*\*actual implemented runtime\/effect path\*\*/i);

  console.error('v0.5.3 hardening regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

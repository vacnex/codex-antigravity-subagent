import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-v052-hardening-'));
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
  const baselineModule = await loadSourceModule('git-baseline');
  const reviewModule = await loadSourceModule('plan-review');
  const promptModule = await loadSourceModule('plan-prompt');

  const repo = path.join(tempRoot, 'repo');
  const workspace = path.join(repo, 'Hau.Giang.Portal');
  const sibling = path.join(repo, 'Sibling.Project');
  await mkdir(workspace, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(workspace, 'allowed.txt'), 'before\n', 'utf8');
  await writeFile(path.join(sibling, 'outside.txt'), 'outside-before\n', 'utf8');

  git(repo, 'init');
  git(repo, 'config', 'user.email', 'agy-test@example.invalid');
  git(repo, 'config', 'user.name', 'AGY MCP Test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'baseline');

  const plan = {
    id: 'PLAN-01',
    title: 'Nested workspace review',
    dependsOn: [],
    goal: 'test',
    writeScope: ['allowed.txt'],
    forbiddenScope: [],
    requiredReadSet: [],
    requiredConventions: 'test',
    requiredChanges: 'test',
    implementationLogic: 'test',
    failureAndBoundaryBehavior: 'test',
    acceptanceCriteria: 'test',
    canonicalValidation: '```text\nnode -e "process.exit(0)"\n```',
    stopIf: 'test',
    rawMarkdown: '### PLAN-01: Nested workspace review',
  };

  const baselineDir = path.join(tempRoot, 'baseline-a');
  const baseline = await baselineModule.capturePlanBaseline(workspace, plan, baselineDir);
  assert.deepEqual(baseline.dirtyPaths, {});

  await writeFile(path.join(workspace, 'allowed.txt'), 'after\n', 'utf8');
  const compact = await baselineModule.reviewPlanBaseline(workspace, plan, baselineDir, baseline.baselineId, false);
  assert.deepEqual(compact.changedFiles, ['allowed.txt']);
  assert.deepEqual(compact.unauthorizedChanges, []);
  assert.equal(compact.diffIncluded, false);
  assert.equal(compact.diff, '');

  const review = await reviewModule.buildPlanReviewBundle({
    cwd: workspace,
    plan,
    baselineDir,
    baselineId: baseline.baselineId,
    validationTimeoutSeconds: 30,
    includeDiff: false,
  });
  assert.equal(review.mechanicalStatus, 'pass');
  assert.equal(review.validation.skipped, false);
  assert.equal(review.validation.exitCode, 0);
  assert.equal(review.validation.output, '', 'successful validation stdout must not enter Codex review context');
  assert.equal(review.diffIncluded, false);

  const untrackedPath = path.join(workspace, 'new-untracked.txt');
  await writeFile(untrackedPath, 'untracked in workspace\n', 'utf8');
  const untrackedReview = await baselineModule.reviewPlanBaseline(workspace, plan, baselineDir, baseline.baselineId, false);
  assert.ok(untrackedReview.unauthorizedChanges.includes('new-untracked.txt'));
  assert.ok(!untrackedReview.unauthorizedChanges.includes('../new-untracked.txt'));
  await rm(untrackedPath, { force: true });

  await writeFile(path.join(sibling, 'outside.txt'), 'new unauthorized sibling edit\n', 'utf8');
  const outsideReview = await baselineModule.reviewPlanBaseline(workspace, plan, baselineDir, baseline.baselineId, false);
  assert.ok(outsideReview.unauthorizedChanges.some((entry) => entry.endsWith('Sibling.Project/outside.txt')));

  git(repo, 'reset', '--hard', 'HEAD');
  await writeFile(path.join(sibling, 'outside.txt'), 'pre-existing sibling edit\n', 'utf8');
  const baselineDirB = path.join(tempRoot, 'baseline-b');
  const baselineB = await baselineModule.capturePlanBaseline(workspace, plan, baselineDirB);
  const siblingKey = Object.keys(baselineB.dirtyPaths).find((entry) => entry.endsWith('Sibling.Project/outside.txt'));
  assert.ok(siblingKey, 'pre-existing sibling dirty path must be captured in workspace-relative coordinates');

  await writeFile(path.join(sibling, 'outside.txt'), 'worker changed sibling edit\n', 'utf8');
  const preserved = await baselineModule.reviewPlanBaseline(workspace, plan, baselineDirB, baselineB.baselineId, false);
  assert.ok(preserved.preExistingOutsideScopeModified.includes(siblingKey));
  assert.ok(preserved.unauthorizedChanges.includes(siblingKey));

  const unquoted = 'D:\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe project.csproj /t:Build';
  assert.match(reviewModule.validationCommandIssue(unquoted, 'win32') ?? '', /VALIDATION_COMMAND_INVALID/);
  const quoted = '"D:\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe" "project.csproj" /t:Build';
  assert.equal(reviewModule.validationCommandIssue(quoted, 'win32'), undefined);

  const resumePrompt = promptModule.buildResumePrompt(plan);
  assert.match(resumePrompt, /AGY PLAN RECOVERY POLICY/);
  assert.match(resumePrompt, /ORIGINAL APPROVED PLAN/);
  assert.match(resumePrompt, /Nested workspace review/);
  assert.match(resumePrompt, /do not restart completed work/i);

  console.error('v0.5.2 hardening regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const pluginRoot = path.resolve(mcpRoot, '..');

const packageJson = JSON.parse(await readFile(path.join(mcpRoot, 'package.json'), 'utf8'));
const lockJson = JSON.parse(await readFile(path.join(mcpRoot, 'package-lock.json'), 'utf8'));
const pluginJson = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const indexSource = await readFile(path.join(mcpRoot, 'src', 'index.ts'), 'utf8');
const driverSource = await readFile(path.join(mcpRoot, 'src', 'driver.ts'), 'utf8');
const blueprintSource = await readFile(path.join(mcpRoot, 'src', 'blueprint.ts'), 'utf8');
const baselineSource = await readFile(path.join(mcpRoot, 'src', 'git-baseline.ts'), 'utf8');
const planReviewSource = await readFile(path.join(mcpRoot, 'src', 'plan-review.ts'), 'utf8');
const planPromptSource = await readFile(path.join(mcpRoot, 'src', 'plan-prompt.ts'), 'utf8');
const resultSemanticsSource = await readFile(path.join(mcpRoot, 'src', 'result-semantics.ts'), 'utf8');
const blueprintSkill = await readFile(path.join(pluginRoot, 'skills', 'execution-blueprint', 'SKILL.md'), 'utf8');
const executeSkill = await readFile(path.join(pluginRoot, 'skills', 'execute-plan', 'SKILL.md'), 'utf8');

assert.equal(packageJson.version, '0.5.3');
assert.equal(pluginJson.version, packageJson.version, 'plugin and MCP package versions must stay in sync');
assert.equal(lockJson.version, packageJson.version, 'package-lock root version must stay in sync');
assert.equal(lockJson.packages?.['']?.version, packageJson.version, 'package-lock root package version must stay in sync');

assert.match(indexSource, /registerTool\(\s*'agy_start_plan'/);
assert.match(indexSource, /registerTool\(\s*'agy_review_plan'/);
assert.doesNotMatch(indexSource, /registerTool\(\s*'agy_delegate'/, 'v0.5 removes the one-shot agy_delegate schema');
assert.doesNotMatch(indexSource, /registerTool\(\s*'agy_result'/, 'v0.5 removes the redundant agy_result schema');
assert.doesNotMatch(indexSource, /Use agy_result/, 'PLAN orchestration must not emit stale agy_result guidance');

const startPlanBlock = indexSource.match(/registerTool\(\s*'agy_start_plan',[\s\S]*?registerTool\(\s*'agy_followup'/)?.[0];
assert.ok(startPlanBlock, 'agy_start_plan registration block must be discoverable');
const startPlanSchema = startPlanBlock.match(/inputSchema:\s*z\.object\(\{([\s\S]*?)\}\),\s*annotations/)?.[1];
assert.ok(startPlanSchema, 'agy_start_plan input schema must be discoverable');
assert.doesNotMatch(startPlanSchema, /\bprompt\s*:/, 'agy_start_plan must never accept repeated PLAN prompt text');
assert.match(startPlanSchema, /planId\s*:/);
assert.match(startPlanSchema, /runId\s*:/);
assert.match(indexSource, /worker=\$\{workerId\}, run=\$\{run\.runId\}/, 'PLAN start text must preserve compact worker/run ids');

const followupBlock = indexSource.match(/registerTool\(\s*'agy_followup',[\s\S]*?registerTool\(\s*'agy_wait'/)?.[0];
assert.ok(followupBlock, 'agy_followup registration block must be discoverable');
assert.match(followupBlock, /resume:\s*z\.boolean\(\)\.optional\(\)/);
assert.match(followupBlock, /buildResumePrompt\(plan\)/);
assert.match(followupBlock, /PLAN_RESUME_NOT_RETRYABLE/);

const reviewBlock = indexSource.match(/registerTool\(\s*'agy_review_plan',[\s\S]*?registerTool\(\s*'agy_status'/)?.[0];
assert.ok(reviewBlock, 'agy_review_plan registration block must be discoverable');
assert.match(reviewBlock, /includeDiff:\s*z\.boolean\(\)\.default\(false\)/);
assert.match(reviewBlock, /hasOwnedDelta/);
assert.doesNotMatch(reviewBlock, /plan\.rawMarkdown/, 'review output must not repeat the approved PLAN');

assert.match(driverSource, /MAX_PLAN_AUTO_RESUMES\s*=\s*4/);
assert.match(driverSource, /MAX_LOGICAL_PLAN_WALL_MS/);
assert.match(driverSource, /MAX_STAGNANT_RESPONSE_TIMEOUTS/);
assert.match(driverSource, /AGY INTERNAL PLAN CONTINUATION/);
assert.match(driverSource, /isAgyResponseTimeout/);
assert.match(driverSource, /logical_plan_stalled/);
assert.match(driverSource, /logical_plan_recovery_exhausted/);
assert.match(resultSemanticsSource, /logical_plan_stalled/);
assert.match(resultSemanticsSource, /logical_plan_recovery_exhausted/);

assert.match(baselineSource, /git rev-parse|rev-parse/);
assert.match(baselineSource, /path\.relative\(resolvedCwd, path\.resolve\(root/);
assert.match(baselineSource, /includeDiff = true/);
assert.match(planReviewSource, /parseDirectCommand/);
assert.match(planReviewSource, /shell:\s*false/);
assert.doesNotMatch(planReviewSource, /cmd\.exe|ComSpec|\/bin\/sh/, 'canonical validation must not route through a shell');
assert.match(planReviewSource, /VALIDATION_COMMAND_INVALID/);
assert.match(planReviewSource, /VALIDATION_FAILURE_OUTPUT_LIMIT/);
assert.match(planReviewSource, /skippedReason: 'no_owned_delta'/);
assert.match(planPromptSource, /AGY PLAN RECOVERY POLICY/);
assert.match(planPromptSource, /export function buildResumePrompt/);

assert.match(blueprintSource, /function\s+gitHeadsMatch\(/);
assert.match(blueprintSource, /export function assertBlueprintFresh\(/);
assert.match(blueprintSource, /BLUEPRINT_STALE/);
assert.match(blueprintSource, /BLUEPRINT_FRESHNESS_UNAVAILABLE/);
assert.match(blueprintSource, /BLUEPRINT_INVALID/);
assert.match(blueprintSource, /assertExecutionPath\(plan\.id, 'Required read set'/);
assert.match(blueprintSource, /assertBlueprintFresh\(blueprint\);/);

assert.match(blueprintSkill, /<!-- AGY_BLUEPRINT:v1:START -->/);
assert.match(blueprintSkill, /<!-- AGY_BLUEPRINT:v1:END -->/);
assert.match(blueprintSkill, /#### Required read set/);
assert.match(blueprintSkill, /External files outside the workspace are \*\*planning evidence only\*\*/);
assert.match(blueprintSkill, /`Forbidden scope` contains only concrete files\/directories/);
assert.match(blueprintSkill, /Canonical validation command contract/);
assert.match(blueprintSkill, /shell=false/);
assert.match(blueprintSkill, /End-to-end effect-path proof/);
assert.match(blueprintSkill, /Conditional planning checks/);
assert.match(blueprintSkill, /Apply these checks only when repository evidence shows they are relevant/);
assert.match(blueprintSkill, /must not remove or bypass an existing service, proxy, authentication, persistence, or trust boundary/);

assert.match(executeSkill, /agy_start_plan/);
assert.match(executeSkill, /agy_review_plan/);
assert.match(executeSkill, /findings only/i);
assert.match(executeSkill, /resume: true/);
assert.match(executeSkill, /logical worker/i);
assert.match(executeSkill, /normal Codex orchestration should not see or manually service/i);
assert.match(executeSkill, /not proof that the blueprint's architecture or assumptions were correct/i);
assert.match(executeSkill, /Retrace the \*\*actual implemented runtime\/effect path\*\*/i);
assert.doesNotMatch(executeSkill, /agy_start\(\{[\s\S]{0,500}PLAN text/i, 'execute-plan must not instruct Codex to rebuild a PLAN prompt');

console.error('Architecture regression test passed');

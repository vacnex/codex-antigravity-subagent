import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const pluginRoot = path.resolve(mcpRoot, '..');
const repoRoot = path.resolve(pluginRoot, '../..');

const packageJson = JSON.parse(await readFile(path.join(mcpRoot, 'package.json'), 'utf8'));
const lockJson = JSON.parse(await readFile(path.join(mcpRoot, 'package-lock.json'), 'utf8'));
const pluginJson = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const indexSource = await readFile(path.join(mcpRoot, 'src', 'index.ts'), 'utf8');
const blueprintSource = await readFile(path.join(mcpRoot, 'src', 'blueprint.ts'), 'utf8');
const blueprintSkill = await readFile(path.join(pluginRoot, 'skills', 'execution-blueprint', 'SKILL.md'), 'utf8');
const executeSkill = await readFile(path.join(pluginRoot, 'skills', 'execute-plan', 'SKILL.md'), 'utf8');

assert.equal(packageJson.version, '0.5.1');
assert.equal(pluginJson.version, packageJson.version, 'plugin and MCP package versions must stay in sync');
assert.equal(lockJson.version, packageJson.version, 'package-lock root version must stay in sync');
assert.equal(lockJson.packages?.['']?.version, packageJson.version, 'package-lock root package version must stay in sync');

assert.match(indexSource, /registerTool\(\s*'agy_start_plan'/);
assert.match(indexSource, /registerTool\(\s*'agy_review_plan'/);
assert.doesNotMatch(indexSource, /registerTool\(\s*'agy_delegate'/, 'v0.5 removes the one-shot agy_delegate schema');
assert.doesNotMatch(indexSource, /registerTool\(\s*'agy_result'/, 'v0.5 removes the redundant agy_result schema');

const startPlanBlock = indexSource.match(/registerTool\(\s*'agy_start_plan',[\s\S]*?registerTool\(\s*'agy_followup'/)?.[0];
assert.ok(startPlanBlock, 'agy_start_plan registration block must be discoverable');
const startPlanSchema = startPlanBlock.match(/inputSchema:\s*z\.object\(\{([\s\S]*?)\}\),\s*annotations/)?.[1];
assert.ok(startPlanSchema, 'agy_start_plan input schema must be discoverable');
assert.doesNotMatch(startPlanSchema, /\bprompt\s*:/, 'agy_start_plan must never accept repeated PLAN prompt text');
assert.match(startPlanSchema, /planId\s*:/);
assert.match(startPlanSchema, /runId\s*:/);

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
assert.match(executeSkill, /agy_start_plan/);
assert.match(executeSkill, /agy_review_plan/);
assert.match(executeSkill, /findings only/i);
assert.doesNotMatch(executeSkill, /agy_start\(\{[\s\S]{0,500}PLAN text/i, 'execute-plan must not instruct Codex to rebuild a PLAN prompt');

console.error('Architecture regression test passed');

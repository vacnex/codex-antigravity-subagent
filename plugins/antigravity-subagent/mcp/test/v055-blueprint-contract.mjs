import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-v055-blueprint-'));

async function loadSourceModule(name) {
  const outfile = path.join(tempRoot, `${name}.mjs`);
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
  const blueprint = await loadSourceModule('blueprint');
  const store = await loadSourceModule('blueprint-store');
  const workspace = path.join(tempRoot, 'workspace');
  await mkdir(workspace, { recursive: true });

  const canonical = `<!-- AGY_BLUEPRINT:v1:START -->
Blueprint status: READY
Blueprint depth: Standard Blueprint

Blueprint basis:
- Workspace: ${workspace}
- Git HEAD: unavailable

## Implementation Tasks

### PLAN-01: Fix blueprint contract

#### Depends on
None

#### Goal
Reject malformed executable plans before worker launch.

#### Write scope
- \`src/target.ts\`

#### Forbidden scope
None

#### Required read set
- \`src/reference.ts\` — precedent

#### Required conventions
Use the canonical schema.

#### Required changes
Apply the bounded fix.

#### Implementation logic
Keep parsing deterministic.

#### Failure and boundary behavior
Return a specific validation error.

#### Acceptance criteria
Malformed plans fail before launch.

#### Canonical validation
Command: npm test

#### Stop if
The schema needs to change.

<!-- AGY_BLUEPRINT:v1:END -->`;

  assert.equal(blueprint.parseBlueprint(canonical).plans.length, 1);

  const emDashHeading = canonical.replace('### PLAN-01: Fix blueprint contract', '### PLAN-01 — Fix blueprint contract');
  assert.throws(
    () => blueprint.parseBlueprint(emDashHeading),
    /BLUEPRINT_INVALID: Non-canonical PLAN heading.*colon is required/,
  );

  const plainLabels = canonical
    .replace('#### Depends on', 'Depends on:')
    .replace('#### Goal', 'Goal:');
  assert.throws(
    () => blueprint.parseBlueprint(plainLabels),
    /BLUEPRINT_INVALID: PLAN-01 is missing canonical field heading\(s\): #### Depends on, #### Goal\. Plain "Label:" lines are not accepted/,
  );

  const inlineValidation = canonical.replace('Command: npm test', '\`npm test\`');
  assert.throws(
    () => blueprint.parseBlueprint(inlineValidation),
    /BLUEPRINT_INVALID: PLAN-01 Canonical validation must contain a fenced command, one "Command:" line, or exactly "None"/,
  );

  const missingImplementationTasks = canonical.replace('## Implementation Tasks', '## Tasks');
  const blueprintStore = new store.BlueprintStore(path.join(tempRoot, 'blueprints'));
  await assert.rejects(
    () => blueprintStore.save(missingImplementationTasks, 'session-v055'),
    (error) => blueprint.blueprintErrorCode(error) === 'BLUEPRINT_INVALID',
  );
  assert.equal(blueprint.blueprintErrorCode(new Error('BLUEPRINT_STALE: changed')), 'BLUEPRINT_STALE');
  assert.equal(blueprint.blueprintErrorCode(new Error('rollout missing')), undefined);

  console.error('v0.5.5 blueprint contract regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

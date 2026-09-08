import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-blueprint-paths-'));

try {
  const outfile = path.join(tempRoot, 'blueprint.mjs');
  await build({
    entryPoints: [path.join(mcpRoot, 'src', 'blueprint.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  const blueprint = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const workspace = path.join(tempRoot, 'workspace');
  await mkdir(workspace, { recursive: true });

  const canonical = (writePath = 'src/target.txt', readPath = 'src/reference.txt', forbiddenPath = 'forbidden.txt') => `<!-- AGY_BLUEPRINT:v1:START -->\nBlueprint status: READY\nBlueprint depth: Standard Blueprint\n\nBlueprint basis:\n- Workspace: ${workspace}\n- Git HEAD: unavailable\n\n## Implementation Tasks\n\n### PLAN-01: Path contract\n\n#### Depends on\nNone\n\n#### Goal\nVerify execution paths.\n\n#### Write scope\n- \`${writePath}\`\n\n#### Forbidden scope\n- \`${forbiddenPath}\`\n\n#### Required read set\n- \`${readPath}\` — reference\n\n#### Required conventions\nUse the approved contract.\n\n#### Required changes\nMake the bounded change.\n\n#### Implementation logic\nUse supplied context only.\n\n#### Failure and boundary behavior\nStop on missing contract.\n\n#### Acceptance criteria\nPath contract is respected.\n\n#### Canonical validation\nCommand: git status --short\n\n#### Stop if\nScope must expand.\n\n<!-- AGY_BLUEPRINT:v1:END -->`;

  assert.equal(blueprint.parseBlueprint(canonical()).plans[0].requiredReadSet[0].path, 'src/reference.txt');

  assert.throws(
    () => blueprint.parseBlueprint(canonical('C:\\outside\\target.txt')),
    /BLUEPRINT_INVALID: PLAN-01 Write scope must contain workspace-relative paths only/,
  );
  assert.throws(
    () => blueprint.parseBlueprint(canonical('src/target.txt', 'C:\\Users\\example\\Downloads\\contract.docx')),
    /BLUEPRINT_INVALID: PLAN-01 Required read set must contain workspace-relative paths only/,
  );
  assert.throws(
    () => blueprint.parseBlueprint(canonical('src/target.txt', '../contract.txt')),
    /BLUEPRINT_INVALID: PLAN-01 Required read set path escapes the workspace/,
  );
  assert.throws(
    () => blueprint.parseBlueprint(canonical('src/target.txt', 'src/reference.txt', '/outside/forbidden.txt')),
    /BLUEPRINT_INVALID: PLAN-01 Forbidden scope must contain workspace-relative paths only/,
  );

  const proseForbidden = canonical().replace('- `forbidden.txt`', '- Generated EDMX, entity and database model');
  assert.throws(
    () => blueprint.parseBlueprint(proseForbidden),
    /BLUEPRINT_INVALID: Forbidden scope entries must be backtick-wrapped workspace paths, not prose/,
  );

  console.error('Blueprint execution-path regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

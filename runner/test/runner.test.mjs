import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(here, '../../plugins/agy-orchestrator/dist/agy-run.mjs');
const FAKE_AGY = path.join(here, 'fake-agy.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-run-test-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'app.js'), 'export const app = 1;\n');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function scenario(dir, turns) {
  const file = path.join(dir, '..', `${path.basename(dir)}.scenario.json`);
  writeFileSync(file, JSON.stringify({ turns }));
  return file;
}

function run(dir, scenarioFile, ...args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, AGY_PATH: FAKE_AGY, FAKE_AGY_SCENARIO: scenarioFile },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function prompts(scenarioFile) {
  const f = `${scenarioFile}.prompts.jsonl`;
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

const BLUEPRINT = (validate = 'node --version') => `# Demo feature

\`\`\`yaml agy-blueprint
validate:
  - ${validate}
\`\`\`

## Tóm tắt
Demo.

## PLAN-01: Add greeter

\`\`\`yaml agy-plan
executor: agy
write:
  - src/greeter.js
  - src/contracts/greeter.d.ts
wiring:
  - src/app.js
\`\`\`

### Contracts
\`\`\`ts file=src/contracts/greeter.d.ts
export declare function greet(name: string): string;
\`\`\`

## PLAN-02: Use greeter

\`\`\`yaml agy-plan
depends_on: [PLAN-01]
write: [src/use.js]
\`\`\`

## Checklist test tay
1. Run it.
`;

const DONE = '## Result: DONE\n- Files changed: src/greeter.js\n- Notes for reviewer: none';

function importBlueprint(dir, scen, text = BLUEPRINT()) {
  const bpFile = path.join(dir, '..', `${path.basename(dir)}.blueprint.md`);
  writeFileSync(bpFile, text);
  const r = run(dir, scen, 'import', bpFile);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /model: gemini-3\.8-flash-high/);
  return r.out.match(/^RUN (\S+)/m)[1];
}

test('happy path: import, next, review, next, done', () => {
  const dir = makeRepo();
  const scen = scenario(dir, [
    { write: { 'src/greeter.js': 'export const greet = (n) => `hi ${n}`;\n', 'src/app.js': 'export const app = 2;\n' }, response: `Working...\n\n${DONE}` },
    { write: { 'src/use.js': 'import "./greeter.js";\n' }, response: DONE },
  ]);
  importBlueprint(dir, scen);
  assert.match(readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.agy\/$/m);

  let r = run(dir, scen, 'next');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /READY FOR REVIEW/);
  assert.match(r.out, /PLAN-01 REVIEW\s+agy:DONE\s+3 files \(A2 M1 D0\)\s+scope:OK\s+validate:PASS/);
  assert.doesNotMatch(r.out, /PLAN-02/);
  // contract written verbatim before agy ran, and reported as part of the plan's change
  assert.equal(readFileSync(path.join(dir, 'src/contracts/greeter.d.ts'), 'utf8'), 'export declare function greet(name: string): string;\n');
  const p = prompts(scen);
  assert.equal(p.length, 1);
  assert.match(p[0].prompt, /## PLAN-01: Add greeter/);
  assert.match(p[0].prompt, /You cannot run shell commands/);
  assert.ok(p[0].args.includes('accept-edits'));

  r = run(dir, scen, 'next');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PLAN-02 REVIEW/);

  r = run(dir, scen, 'next');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ALL DONE/);

  r = run(dir, scen, 'clean');
  assert.match(r.out, /removed 2 checkpoint refs/);
  assert.equal(git(dir, 'for-each-ref', 'refs/agy/'), '');
});

test('scope violation triggers one automatic fix in the same conversation', () => {
  const dir = makeRepo();
  const scen = scenario(dir, [
    { write: { 'src/greeter.js': 'x\n', 'README.md': '# hacked\n' }, response: DONE },
    { write: { 'README.md': '# demo\n' }, response: DONE },
  ]);
  importBlueprint(dir, scen);
  const r = run(dir, scen, 'next');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /scope:OK/);
  assert.match(r.out, /autofix:1/);
  const p = prompts(scen);
  assert.equal(p.length, 2);
  assert.match(p[1].prompt, /outside the allowed scope[\s\S]*README\.md/);
  assert.deepEqual(p[1].args.slice(p[1].args.indexOf('--conversation'), p[1].args.indexOf('--conversation') + 2), ['--conversation', 'conv-0']);
});

test('validation failure is sent back once, then left for review', () => {
  const dir = makeRepo();
  const scen = scenario(dir, [
    { write: { 'src/greeter.js': 'x\n' }, response: DONE },
    { write: { 'src/greeter.js': 'y\n' }, response: DONE },
  ]);
  importBlueprint(dir, scen, BLUEPRINT('node -e "process.exit(3)"'));
  const r = run(dir, scen, 'next');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /validate:FAIL/);
  assert.match(r.out, /autofix:1/);
  assert.match(r.out, /mechanical checks still failing after auto-fix/);
  assert.equal(prompts(scen).length, 2);
});

test('blocked report stops the layer with exit code 2', () => {
  const dir = makeRepo();
  const scen = scenario(dir, [{ response: '## Recon\n...\n## Result: BLOCKED\n- Conflicts with the PLAN: no Result type exists' }]);
  importBlueprint(dir, scen);
  const r = run(dir, scen, 'next');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /NEEDS ATTENTION/);
  assert.match(r.out, /PLAN-01 BLOCKED/);
  assert.match(r.out, /no Result type exists/);
});

test('fix continues the conversation; undo restores plan files and keeps user WIP and index', () => {
  const dir = makeRepo();
  // user WIP: unstaged edit + staged new file, both outside the plan
  writeFileSync(path.join(dir, 'README.md'), '# demo\nwip line\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'staged\n');
  git(dir, 'add', 'notes.txt');
  const indexBefore = git(dir, 'diff', '--cached', '--name-status');

  const scen = scenario(dir, [
    { write: { 'src/greeter.js': 'v1\n', 'src/app.js': 'export const app = 9;\n' }, response: DONE },
    { write: { 'src/greeter.js': 'v2\n' }, response: DONE },
  ]);
  importBlueprint(dir, scen);
  let r = run(dir, scen, 'next');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 files \(A2 M1 D0\)/); // greeter + contract added, app modified
  const findings = path.join(dir, '..', `${path.basename(dir)}.findings.md`);
  writeFileSync(findings, '- src/greeter.js: use v2\n');
  r = run(dir, scen, 'fix', 'PLAN-01', findings);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FIX PLAN-01 \(round 1\)/);
  assert.equal(readFileSync(path.join(dir, 'src/greeter.js'), 'utf8'), 'v2\n');
  assert.match(prompts(scen)[1].prompt, /reviewer found problems[\s\S]*use v2/);

  r = run(dir, scen, 'undo', 'PLAN-01');
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(path.join(dir, 'src/greeter.js')));
  assert.ok(!existsSync(path.join(dir, 'src/contracts/greeter.d.ts')));
  assert.equal(readFileSync(path.join(dir, 'src/app.js'), 'utf8'), 'export const app = 1;\n');
  assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), '# demo\nwip line\n');
  assert.equal(git(dir, 'diff', '--cached', '--name-status'), indexBefore);
  assert.match(run(dir, scen, 'status').out, /PLAN-01 pending/);
});

test('invalid blueprint is rejected with a clear message', () => {
  const dir = makeRepo();
  const scen = scenario(dir, []);
  const bpFile = path.join(dir, '..', `${path.basename(dir)}.bad.md`);
  writeFileSync(bpFile, '# x\n\n```yaml agy-blueprint\nvalidate: []\n```\n\n## PLAN-01 — Dash title\n\n```yaml agy-plan\ndepends_on: [PLAN-09]\nwrite: [a.js]\n```\n');
  const r = run(dir, scen, 'import', bpFile);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /BLUEPRINT INVALID: PLAN-01: depends_on PLAN-09 does not exist/);
});

test('the example in blueprint-template.md is a valid blueprint', () => {
  const template = readFileSync(path.resolve(here, '../../plugins/agy-orchestrator/skills/agy-plan/blueprint-template.md'), 'utf8');
  const example = template.match(/`````markdown\n([\s\S]*?)\n`````/)[1];
  const dir = makeRepo();
  const scen = scenario(dir, []);
  const bpFile = path.join(dir, '..', `${path.basename(dir)}.example.md`);
  writeFileSync(bpFile, example);
  const r = run(dir, scen, 'import', bpFile);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /layer 1: PLAN-01\n  layer 2: PLAN-02/);
});

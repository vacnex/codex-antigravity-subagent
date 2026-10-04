import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { agyVersion, allowValidateCommands, findAgy, msixShadowCopies, newestFlash, runTurn, type TurnResult } from './agy.js';
import { BlueprintError, inScope, layers, parseBlueprint, type Blueprint, type Plan } from './blueprint.js';
import { restoreFileFormats } from './encoding.js';
import { changes, deleteRefs, diffText, ensureExcluded, repoRoot, restoreFiles, setRef, snapshot, type Change } from './git.js';
import { failureExcerpt, runCommand, tail } from './proc.js';
import { continuePrompt, fixPrompt, parseReport, planPrompt } from './prompt.js';
import { acquireLock, AGY_DIR, latestRun, loadState, newRunId, runDir, saveState, setPlan, type RunState } from './state.js';

const VALIDATE_TIMEOUT_MS = 20 * 60_000;
const MAX_AUTO_FIXES = 2;

class UsageError extends Error {}

/** Exit codes: 0 = done or waiting for review, 2 = needs attention, 1 = error. */
type Outcome = { code: 0 | 1 | 2; text: string };

// ---------------------------------------------------------------- helpers

function refFor(run: string, plan: string): string {
  return `refs/agy/${run}/${plan}`;
}

function loadRun(cwd: string, runArg?: string): { root: string; state: RunState; bp: Blueprint; dir: string } {
  const root = repoRoot(cwd);
  const run = runArg ?? latestRun(root);
  if (!run) throw new UsageError('no run found; create one with `agy-run import <blueprint.md>`');
  const state = loadState(root, run);
  const dir = runDir(root, run);
  const bp = parseBlueprint(readFileSync(path.join(dir, 'blueprint.md'), 'utf8'));
  return { root, state, bp, dir };
}

function planById(bp: Blueprint, id: string): Plan {
  const plan = bp.plans.find((p) => p.id === id.toUpperCase());
  if (!plan) throw new UsageError(`unknown plan ${id}; plans: ${bp.plans.map((p) => p.id).join(', ')}`);
  return plan;
}

type Check = {
  post: string;
  changed: Change[];
  outOfScope: Change[];
  dirScopedNew: string[];
  formatsRestored: string[];
  // Every validate command runs even after one fails, so one auto-fix round sees all errors.
  validate: { ok: boolean; skipped: boolean; failures: { command: string; output: string }[] };
  diffFile: string;
  diffLines: number;
};

async function checkPlan(root: string, dir: string, run: string, plan: Plan, checkpoint: string, bp: Blueprint): Promise<Check> {
  const allowed = [...plan.write, ...plan.wiring];
  let post = snapshot(root, dir, `agy-run ${run} ${plan.id} after`);
  let changed = changes(root, checkpoint, post);
  // agy's file tools drop BOMs and rewrite line endings; put each file's own format back
  // (only in-scope files: out-of-scope changes may be the user's).
  const formatsRestored = restoreFileFormats(root, checkpoint, post, changed.filter((c) => inScope(c.file, allowed)));
  if (formatsRestored.length) {
    post = snapshot(root, dir, `agy-run ${run} ${plan.id} after (formats restored)`);
    changed = changes(root, checkpoint, post);
  }
  const outOfScope = changed.filter((c) => !inScope(c.file, allowed));
  const exact = new Set(plan.write.filter((w) => !w.endsWith('/')));
  const dirScopedNew = changed.filter((c) => c.status === 'A' && inScope(c.file, plan.write) && !exact.has(c.file)).map((c) => c.file);
  const diff = diffText(root, checkpoint, post);
  const diffFile = path.join(dir, `${plan.id}.diff`);
  writeFileSync(diffFile, diff);

  let validate: Check['validate'] = { ok: true, skipped: true, failures: [] };
  if (changed.length > 0 && bp.validate.length > 0) {
    const failures: Check['validate']['failures'] = [];
    const log: string[] = [];
    for (const command of bp.validate) {
      const r = await runCommand(command, root, VALIDATE_TIMEOUT_MS);
      log.push(`$ ${command}\n${r.stdout}${r.stderr}`);
      if (r.code !== 0 || r.timedOut) failures.push({ command, output: failureExcerpt(`${r.stdout}\n${r.stderr}`) +(r.timedOut ? '\n(timed out)' : '') });
    }
    validate = { ok: failures.length === 0, skipped: false, failures };
    writeFileSync(path.join(dir, `${plan.id}.validate.txt`), log.join('\n'));
  }
  return { post, changed, outOfScope, dirScopedNew, formatsRestored, validate, diffFile, diffLines: diff ? diff.split('\n').length : 0 };
}

function runnerFindings(check: Check): string | undefined {
  const parts: string[] = [];
  if (check.outOfScope.length) {
    parts.push(`Files changed outside the allowed scope (revert these changes):\n${check.outOfScope.map((c) => `- ${c.file}`).join('\n')}`);
  }
  for (const f of check.validate.failures) {
    parts.push(`Validation failed: \`${f.command}\`\nLast output lines:\n\`\`\`\n${f.output}\n\`\`\``);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/** All-or-nothing: checks every contract file before writing any of them. */
function writeContracts(root: string, plan: Plan): string | undefined {
  const pending = [];
  for (const c of plan.contracts) {
    const abs = path.join(root, c.file);
    if (existsSync(abs)) {
      const current = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
      if (current === c.content) continue;
      return `contract file ${c.file} already exists with different content; contracts are only for new files; nothing was written — move its signatures into the PLAN text, then \`agy-run undo ${plan.id}\` and \`agy-run next\``;
    }
    pending.push({ abs, content: c.content });
  }
  for (const { abs, content } of pending) {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return undefined;
}

const MODEL_CACHE_MS = 24 * 60 * 60_000;

/** `agy models` can hang for a minute; cache the newest Flash per effort in .agy/models.json. */
function resolveModel(root: string, agy: string, effort: string): string {
  const file = path.join(root, AGY_DIR, 'models.json');
  let cache: Record<string, { model: string; at: number }> = {};
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // no cache yet
  }
  const hit = cache[effort];
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.model;
  let flash = newestFlash(agy, effort);
  if (!flash.model) flash = newestFlash(agy, effort);
  if (!flash.model) {
    if (hit) return hit.model;
    throw new Error(flash.error);
  }
  cache[effort] = { model: flash.model, at: Date.now() };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
  return flash.model;
}

type PlanRun = { plan: Plan; turn?: TurnResult; check?: Check; reportText?: string; agyResult?: string; note?: string };

function tokens(turn?: TurnResult): string {
  const u = turn?.usage;
  if (!u) return '';
  const k = (n?: number) => (n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `  tokens in ${k(u.input_tokens)} / out ${k(u.output_tokens)}`;
}

function formatPlan(state: RunState, r: PlanRun): string {
  const ps = state.plans[r.plan.id];
  const lines: string[] = [];
  const c = r.check;
  const counts = c ? `${c.changed.length} files (${['A', 'M', 'D'].map((s) => `${s}${c.changed.filter((x) => x.status === s).length}`).join(' ')})` : '';
  const scope = c ? (c.outOfScope.length ? `scope:VIOLATION(${c.outOfScope.length})` : 'scope:OK') : '';
  const val = c ? (c.validate.skipped ? 'validate:SKIP' : c.validate.ok ? 'validate:PASS' : 'validate:FAIL') : '';
  lines.push(
    [`${r.plan.id} ${ps.status.toUpperCase()}`, r.agyResult ? `agy:${r.agyResult}` : '', counts, scope, val, `autofix:${ps.autoFixes}`, r.turn ? `resumes:${r.turn.autoResumes}` : '', r.turn ? `${r.turn.durationSeconds}s` : '']
      .filter(Boolean)
      .join('  ') + tokens(r.turn),
  );
  if (r.note) lines.push(`  note: ${r.note}`);
  if (c?.changed.length) lines.push(`  changed: ${c.changed.map((x) => `${x.status} ${x.file}`).join(', ')}`);
  if (c?.outOfScope.length) lines.push(`  OUT OF SCOPE (agy or you): ${c.outOfScope.map((x) => x.file).join(', ')}`);
  if (c?.formatsRestored.length) lines.push(`  file format restored by runner: ${c.formatsRestored.join(', ')}`);
  if (c?.dirScopedNew.length) lines.push(`  new files under a folder scope (check placement): ${c.dirScopedNew.join(', ')}`);
  for (const f of c?.validate.failures ?? []) lines.push(`  validate failed: ${f.command}\n${indent(tail(f.output, 15), 4)}`);
  if (r.turn?.deniedActions.length) lines.push(`  agy denied actions: ${r.turn.deniedActions.join(', ')}`);
  if (r.reportText) lines.push(`  agy report:\n${indent(tail(r.reportText, 30), 4)}`);
  if (c) lines.push(`  diff: ${rel(state.root, c.diffFile)} (${c.diffLines} lines)`);
  return lines.join('\n');
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text.split('\n').map((l) => pad + l).join('\n');
}

function rel(root: string, p: string): string {
  return path.relative(root, p).replace(/\\/g, '/');
}

// ---------------------------------------------------------------- one agy plan

async function executeAgyPlan(root: string, dir: string, state: RunState, bp: Blueprint, plan: Plan): Promise<PlanRun> {
  const run = state.run;
  const checkpoint = snapshot(root, dir, `agy-run ${run} ${plan.id} checkpoint`);
  setRef(root, refFor(run, plan.id), checkpoint);
  setPlan(state, plan.id, { checkpoint, conversationId: undefined, autoFixes: 0, fixes: 0, turns: 0, note: undefined });

  const conflict = writeContracts(root, plan);
  if (conflict) {
    setPlan(state, plan.id, { status: 'blocked', note: conflict });
    return { plan, note: conflict };
  }

  const logFile = path.join(dir, `${plan.id}.log`);
  let turn = await runTurn({ agy: findAgyOrThrow(), cwd: root, prompt: planPrompt(bp, plan), model: state.model, logFile });
  setPlan(state, plan.id, { conversationId: turn.conversationId, turns: 1 });
  return finishTurn(root, dir, state, bp, plan, turn, checkpoint, true);
}

async function finishTurn(
  root: string,
  dir: string,
  state: RunState,
  bp: Blueprint,
  plan: Plan,
  firstTurn: TurnResult,
  checkpoint: string,
  allowAutoFix: boolean,
): Promise<PlanRun> {
  let turn = firstTurn;
  let continued = false;
  let lastFindings: string | undefined;
  const logFile = path.join(dir, `${plan.id}.log`);
  const resume = (prompt: string) => {
    setPlan(state, plan.id, { turns: state.plans[plan.id].turns + 1 });
    return runTurn({ agy: findAgyOrThrow(), cwd: root, prompt, model: state.model, conversationId: turn.conversationId, logFile });
  };
  for (;;) {
    if (turn.status !== 'SUCCESS') {
      const note = `agy turn ended with ${turn.status}${turn.error ? `: ${turn.error}` : ''}${turn.stderrTail ? ` | stderr: ${tail(turn.stderrTail, 3)}` : ''}`;
      const check = await checkPlan(root, dir, state.run, plan, checkpoint, { ...bp, validate: [] });
      setPlan(state, plan.id, { status: 'failed', note, files: check.changed.map((c) => c.file) });
      return { plan, turn, check, note };
    }
    const report = parseReport(turn.response);
    writeFileSync(path.join(dir, `${plan.id}.report.md`), report.text);
    // agy sometimes ends its turn right after the Recon report; push it on once, no Claude needed.
    if (report.result === 'UNKNOWN' && !continued && turn.conversationId) {
      continued = true;
      turn = await resume(continuePrompt(plan));
      continue;
    }
    if (report.result === 'BLOCKED') {
      const check = await checkPlan(root, dir, state.run, plan, checkpoint, { ...bp, validate: [] });
      setPlan(state, plan.id, { status: 'blocked', note: 'agy reported BLOCKED', files: check.changed.map((c) => c.file) });
      return { plan, turn, check, reportText: report.text, agyResult: report.result };
    }
    const check = await checkPlan(root, dir, state.run, plan, checkpoint, bp);
    const findings = runnerFindings(check);
    const ps = state.plans[plan.id];
    // A second round only when the first one changed the errors; the same errors twice means agy is stuck.
    const progressing = ps.autoFixes === 0 || findings !== lastFindings;
    if (findings && allowAutoFix && ps.autoFixes < MAX_AUTO_FIXES && progressing && turn.conversationId) {
      lastFindings = findings;
      setPlan(state, plan.id, { autoFixes: ps.autoFixes + 1 });
      turn = await resume(fixPrompt(plan, findings, 'runner'));
      continue;
    }
    const note = findings
      ? 'mechanical checks still failing after auto-fix'
      : report.result === 'UNKNOWN'
        ? 'agy ended without a final report even after being told to continue; the work may be incomplete'
        : undefined;
    setPlan(state, plan.id, { status: 'review', note, files: check.changed.map((c) => c.file) });
    return { plan, turn, check, reportText: report.text, agyResult: report.result, note };
  }
}

function findAgyOrThrow(): string {
  const agy = findAgy();
  if (!agy) throw new Error('agy not found (set AGY_PATH or install the Antigravity CLI)');
  return agy;
}

// ---------------------------------------------------------------- commands

function cmdCheck(cwd: string): Outcome {
  const lines: string[] = [];
  let code: 0 | 1 = 0;
  const agy = findAgy();
  lines.push(`agy: ${agy ?? 'NOT FOUND'}`);
  if (agy) {
    lines.push(`version: ${agyVersion(agy) ?? 'unknown'}`);
    const flash = newestFlash(agy, 'high');
    lines.push(flash.model ? `newest flash: ${flash.model}` : `models: ${flash.error} (not logged in? run \`agy\` once in a terminal)`);
    if (!flash.model) code = 1;
  } else code = 1;
  for (const shadow of msixShadowCopies()) {
    lines.push(`WARNING: virtualized agy copy inside the Claude app package shadows the real install: ${shadow}`);
    lines.push('  Delete it from a terminal outside the Claude app.');
  }
  try {
    lines.push(`repo: ${repoRoot(cwd)}`);
  } catch {
    lines.push('repo: not inside a git repository');
    code = 1;
  }
  return { code, text: lines.join('\n') };
}

function cmdImport(cwd: string, file: string): Outcome {
  const root = repoRoot(cwd);
  const source = path.resolve(cwd, file);
  const bp = parseBlueprint(readFileSync(source, 'utf8'));
  const agy = findAgyOrThrow();
  ensureExcluded(root);
  const model = resolveModel(root, agy, bp.effort ?? 'high');
  const allowed = allowValidateCommands(bp.validate);
  const run = newRunId(bp.title);
  const dir = runDir(root, run);
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, path.join(dir, 'blueprint.md'));
  const state: RunState = {
    version: 1,
    run,
    root,
    model,
    createdAt: new Date().toISOString(),
    plans: Object.fromEntries(bp.plans.map((p) => [p.id, { status: 'pending', autoFixes: 0, fixes: 0, turns: 0 }])),
  };
  saveState(state);
  const lay = layers(bp.plans)
    .map((ids, i) => `  layer ${i + 1}: ${ids.map((id) => `${id}${planById(bp, id).executor === 'claude' ? '(claude)' : ''}`).join(', ')}`)
    .join('\n');
  return {
    code: 0,
    text: [
      `RUN ${run}`,
      `title: ${bp.title}`,
      `model: ${model}`,
      `validate: ${bp.validate.join(' ; ') || '(none)'}`,
      allowed.length ? `agy allowed to run (added to agy settings): ${allowed.join(', ')}` : '',
      lay,
      `NEXT: agy-run next   (latest run; or --run ${run})`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function cmdNext(cwd: string, runArg?: string): Promise<Outcome> {
  const { root, state, bp, dir } = loadRun(cwd, runArg);
  const release = acquireLock(root, state.run);
  try {
    for (const p of bp.plans) {
      const s = state.plans[p.id].status;
      if (s === 'review' || s === 'needs-claude') setPlan(state, p.id, { status: 'accepted', note: undefined });
    }
    const accepted = (id: string) => state.plans[id].status === 'accepted';
    const runnable = bp.plans.filter((p) => state.plans[p.id].status === 'pending' && p.dependsOn.every(accepted));
    if (runnable.length === 0) return summarize(state, bp);

    const results: PlanRun[] = [];
    const ordered = [...runnable.filter((p) => p.executor === 'agy'), ...runnable.filter((p) => p.executor === 'claude')];
    for (const plan of ordered) {
      if (plan.executor === 'claude') {
        setPlan(state, plan.id, { status: 'needs-claude' });
        results.push({ plan, note: 'executor: claude — implement this PLAN yourself, then run `agy-run next`' });
        continue;
      }
      const r = await executeAgyPlan(root, dir, state, bp, plan);
      results.push(r);
      if (state.plans[plan.id].status === 'blocked' || state.plans[plan.id].status === 'failed') break;
    }
    const attention = results.some((r) => ['blocked', 'failed', 'needs-claude'].includes(state.plans[r.plan.id].status) || r.agyResult === 'UNKNOWN');
    const header = attention ? 'NEEDS ATTENTION' : 'READY FOR REVIEW';
    const lastLayer = bp.plans.every((p) => state.plans[p.id].status !== 'pending');
    return {
      code: attention ? 2 : 0,
      text: [
        `${header}  run ${state.run}  model ${state.model}`,
        ...results.map((r) => formatPlan(state, r)),
        lastLayer
          ? 'NEXT: review → last layer: `agy-run next` only accepts (returns at once; run it in the foreground, then `agy-run clean`) | `agy-run fix <PLAN> <findings.md>` | `agy-run undo <PLAN>`'
          : 'NEXT: review → `agy-run next` (accept + start the next layer) | `agy-run fix <PLAN> <findings.md>` | `agy-run undo <PLAN>`',
      ].join('\n'),
    };
  } finally {
    release();
  }
}

function summarize(state: RunState, bp: Blueprint): Outcome {
  const all = bp.plans.map((p) => `${p.id} ${state.plans[p.id].status}${state.plans[p.id].note ? ` (${state.plans[p.id].note})` : ''}`);
  if (bp.plans.every((p) => state.plans[p.id].status === 'accepted')) {
    const files = [...new Set(bp.plans.flatMap((p) => state.plans[p.id].files ?? []))].sort();
    return {
      code: 0,
      text: [
        `ALL DONE  run ${state.run}`,
        ...all,
        files.length ? `files changed by agy (uncommitted): ${files.join(', ')}` : '',
        'NEXT: show the uncommitted diff, give the user the manual test checklist; then `agy-run clean`',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  return { code: 2, text: `NOTHING RUNNABLE  run ${state.run}\n${all.join('\n')}\nResolve blocked/failed PLANs with \`fix\` or \`undo\`.` };
}

async function cmdFix(cwd: string, planId: string, findingsFile: string, runArg?: string): Promise<Outcome> {
  const { root, state, bp, dir } = loadRun(cwd, runArg);
  const plan = planById(bp, planId);
  const ps = state.plans[plan.id];
  if (!ps.conversationId || !ps.checkpoint) throw new UsageError(`${plan.id} has no agy conversation to continue (status ${ps.status})`);
  if (!['review', 'blocked', 'failed'].includes(ps.status)) throw new UsageError(`${plan.id} is ${ps.status}; fix applies to review/blocked/failed plans`);
  const findings = readFileSync(path.resolve(cwd, findingsFile), 'utf8');
  const release = acquireLock(root, state.run);
  try {
    setPlan(state, plan.id, { fixes: ps.fixes + 1, turns: ps.turns + 1 });
    const turn = await runTurn({
      agy: findAgyOrThrow(),
      cwd: root,
      prompt: fixPrompt(plan, findings, 'reviewer'),
      model: state.model,
      conversationId: ps.conversationId,
      logFile: path.join(dir, `${plan.id}.log`),
    });
    const r = await finishTurn(root, dir, state, bp, plan, turn, ps.checkpoint, false);
    const st = state.plans[plan.id].status;
    return { code: st === 'review' && r.agyResult !== 'UNKNOWN' ? 0 : 2, text: `FIX ${plan.id} (round ${state.plans[plan.id].fixes})\n${formatPlan(state, r)}` };
  } finally {
    release();
  }
}

function cmdUndo(cwd: string, planId: string, runArg?: string): Outcome {
  const { root, state, bp, dir } = loadRun(cwd, runArg);
  const plan = planById(bp, planId);
  const ps = state.plans[plan.id];
  if (!ps.checkpoint) throw new UsageError(`${plan.id} has no checkpoint (status ${ps.status})`);
  const dependents = bp.plans.filter((p) => p.dependsOn.includes(plan.id) && state.plans[p.id].status !== 'pending');
  if (dependents.length) throw new UsageError(`undo ${dependents.map((p) => p.id).join(', ')} first; they build on ${plan.id}`);
  const post = snapshot(root, dir, `agy-run ${state.run} ${plan.id} before-undo`);
  const changed = changes(root, ps.checkpoint, post);
  const allowed = [...plan.write, ...plan.wiring];
  const restore = changed.filter((c) => inScope(c.file, allowed));
  const untouched = changed.filter((c) => !inScope(c.file, allowed));
  restoreFiles(root, ps.checkpoint, restore);
  deleteRefs(root, refFor(state.run, plan.id));
  setPlan(state, plan.id, { status: 'pending', checkpoint: undefined, conversationId: undefined, note: 'rolled back' });
  return {
    code: 0,
    text: [
      `UNDO ${plan.id}: restored ${restore.length} files to the checkpoint`,
      restore.length ? `  ${restore.map((c) => `${c.status} ${c.file}`).join(', ')}` : '',
      untouched.length ? `  left as is (outside scope, may be the user's): ${untouched.map((c) => c.file).join(', ')}` : '',
      `${plan.id} is pending again; \`agy-run next\` will rerun it with a fresh agy conversation.`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function cmdStatus(cwd: string, runArg?: string): Outcome {
  const { state, bp } = loadRun(cwd, runArg);
  const lay = layers(bp.plans);
  const rows = lay.flatMap((ids, i) =>
    ids.map((id) => {
      const ps = state.plans[id];
      return `  L${i + 1} ${id} ${ps.status}  turns:${ps.turns} autofix:${ps.autoFixes} fixes:${ps.fixes}${ps.note ? `  (${ps.note})` : ''}`;
    }),
  );
  return { code: 0, text: `RUN ${state.run}  model ${state.model}\n${rows.join('\n')}` };
}

function cmdClean(cwd: string, runArg?: string): Outcome {
  const { root, state } = loadRun(cwd, runArg);
  const n = deleteRefs(root, `refs/agy/${state.run}/`);
  return { code: 0, text: `CLEAN ${state.run}: removed ${n} checkpoint refs (run folder kept for the record)` };
}

const HELP = `agy-run — runner for the agy-orchestrator plugin

  agy-run check                         verify agy, login, newest flash model, repo
  agy-run import <blueprint.md>         create a run from a blueprint file
  agy-run next [--run R]                accept PLANs under review, run the next runnable PLANs
  agy-run fix <PLAN> <findings.md> [--run R]   send review findings to the PLAN's agy conversation
  agy-run undo <PLAN> [--run R]         roll back a PLAN's changes to its checkpoint
  agy-run status [--run R]              show the run
  agy-run clean [--run R]               delete checkpoint refs of a run

Exit codes: 0 done/ready for review, 2 needs attention, 1 error.`;

async function main(argv: string[]): Promise<Outcome> {
  const args = [...argv];
  let runArg: string | undefined;
  const ri = args.indexOf('--run');
  if (ri >= 0) {
    runArg = args[ri + 1];
    args.splice(ri, 2);
  }
  const [cmd, ...rest] = args;
  const cwd = process.cwd();
  switch (cmd) {
    case 'check':
      return cmdCheck(cwd);
    case 'import':
      if (!rest[0]) throw new UsageError('usage: agy-run import <blueprint.md>');
      return cmdImport(cwd, rest[0]);
    case 'next':
      return cmdNext(cwd, runArg);
    case 'fix':
      if (!rest[0] || !rest[1]) throw new UsageError('usage: agy-run fix <PLAN> <findings.md>');
      return cmdFix(cwd, rest[0], rest[1], runArg);
    case 'undo':
      if (!rest[0]) throw new UsageError('usage: agy-run undo <PLAN>');
      return cmdUndo(cwd, rest[0], runArg);
    case 'status':
      return cmdStatus(cwd, runArg);
    case 'clean':
      return cmdClean(cwd, runArg);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { code: 0, text: HELP };
    default:
      throw new UsageError(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (o) => {
    process.stdout.write(`${o.text}\n`);
    process.exitCode = o.code;
  },
  (err) => {
    const prefix = err instanceof BlueprintError ? 'BLUEPRINT INVALID: ' : err instanceof UsageError ? '' : 'ERROR: ';
    process.stdout.write(`${prefix}${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof BlueprintError || err instanceof UsageError ? 2 : 1;
  },
);

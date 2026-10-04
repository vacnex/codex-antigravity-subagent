import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type PlanStatus =
  | 'pending' // not started (or rolled back)
  | 'review' // agy finished, waiting for Claude's review
  | 'accepted' // reviewed and accepted
  | 'blocked' // agy reported BLOCKED or the runner could not proceed
  | 'failed' // agy crashed / timed out beyond recovery
  | 'needs-claude'; // executor: claude — Claude implements it

export type PlanState = {
  status: PlanStatus;
  conversationId?: string;
  checkpoint?: string;
  autoFixes: number;
  fixes: number;
  turns: number;
  note?: string;
  files?: string[]; // files changed since the checkpoint, as of the last check
  updatedAt?: string;
};

export type RunState = {
  version: 1;
  run: string;
  root: string;
  model: string;
  createdAt: string;
  plans: Record<string, PlanState>;
};

export const AGY_DIR = '.agy';

export function runsDir(root: string): string {
  return path.join(root, AGY_DIR, 'runs');
}

export function runDir(root: string, run: string): string {
  return path.join(runsDir(root), run);
}

export function latestRun(root: string): string | undefined {
  const dir = runsDir(root);
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'state.json')))
    .map((d) => d.name)
    .sort()
    .pop();
}

export function loadState(root: string, run: string): RunState {
  const file = path.join(runDir(root, run), 'state.json');
  if (!existsSync(file)) throw new Error(`run not found: ${run}`);
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

export function saveState(state: RunState): void {
  const dir = runDir(state.root, state.run);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, 'state.json.tmp');
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path.join(dir, 'state.json'));
}

export function setPlan(state: RunState, id: string, patch: Partial<PlanState>): void {
  state.plans[id] = { ...state.plans[id], ...patch, updatedAt: new Date().toISOString() };
  saveState(state);
}

/** Single-runner lock per run; stale locks (dead pid) are taken over. */
export function acquireLock(root: string, run: string): () => void {
  const file = path.join(runDir(root, run), 'lock');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && pid !== process.pid) throw new Error(`run ${run} is already being processed by pid ${pid}`);
  }
  writeFileSync(file, String(process.pid));
  return () => rmSync(file, { force: true });
}

export function slugify(text: string): string {
  const ascii = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd');
  return ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
}

export function newRunId(title: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${slugify(title)}`;
}

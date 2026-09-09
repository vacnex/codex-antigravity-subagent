import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveRunStateDir } from './state-paths.js';

const EMPTY_RUN_CLEANUP_MS = 5 * 60_000;

export type PlanRunState = {
  workerId?: string;
  conversationId?: string;
  idempotencyKey?: string;
  baselineId?: string;
  startedAt?: string;
  closedAt?: string;
  logicalStartedAt?: string;
  autoResumeCount?: number;
  stagnantResumeCount?: number;
  lastProgressSteps?: number;
  lastProgressTools?: number;
  lastAutoResumeAt?: string;
};

export type ExecutionRunRecord = {
  schemaVersion: 1;
  runId: string;
  blueprintId: string;
  threadId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  agyProjectId?: string;
  model?: string;
  effort?: string;
  plans: Record<string, PlanRunState>;
};

function assertRunId(runId: string): void {
  if (!/^run_[A-Za-z0-9-]{8,}$/.test(runId)) throw new Error(`Invalid execution run ID: ${runId}`);
}

function isRunRecord(value: unknown): value is ExecutionRunRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.runId === 'string'
    && typeof record.blueprintId === 'string'
    && typeof record.threadId === 'string'
    && typeof record.cwd === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && Boolean(record.plans)
    && typeof record.plans === 'object'
    && !Array.isArray(record.plans);
}

export class RunStore {
  readonly rootDir: string;

  constructor(rootDir: string = resolveRunStateDir()) {
    this.rootDir = path.resolve(rootDir);
  }

  runDir(runId: string): string {
    assertRunId(runId);
    return path.join(this.rootDir, runId);
  }

  filePath(runId: string): string {
    return path.join(this.runDir(runId), 'run.json');
  }

  baselineDir(runId: string, planId: string): string {
    assertRunId(runId);
    if (!/^PLAN-\d{2,}$/.test(planId)) throw new Error(`Invalid PLAN id: ${planId}`);
    return path.join(this.runDir(runId), 'baselines', planId);
  }

  private async atomicWrite(filename: string, value: ExecutionRunRecord): Promise<void> {
    await mkdir(path.dirname(filename), { recursive: true });
    const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temp, filename);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async create(input: { blueprintId: string; threadId: string; cwd: string }): Promise<ExecutionRunRecord> {
    const now = new Date().toISOString();
    const record: ExecutionRunRecord = {
      schemaVersion: 1,
      runId: `run_${randomUUID()}`,
      blueprintId: input.blueprintId,
      threadId: input.threadId,
      cwd: path.resolve(input.cwd),
      createdAt: now,
      updatedAt: now,
      plans: {},
    };
    await this.atomicWrite(this.filePath(record.runId), record);
    const cleanup = setTimeout(() => {
      void this.deleteRunIfEmpty(record.runId).catch(() => undefined);
    }, EMPTY_RUN_CLEANUP_MS);
    cleanup.unref?.();
    return record;
  }

  async read(runId: string): Promise<ExecutionRunRecord> {
    const raw = JSON.parse(await readFile(this.filePath(runId), 'utf8')) as unknown;
    if (!isRunRecord(raw) || raw.runId !== runId) throw new Error(`Invalid execution run record: ${runId}`);
    return raw;
  }

  async write(record: ExecutionRunRecord): Promise<void> {
    if (!isRunRecord(record)) throw new Error('Refusing to persist invalid execution run record.');
    record.updatedAt = new Date().toISOString();
    await this.atomicWrite(this.filePath(record.runId), record);
  }

  async list(): Promise<ExecutionRunRecord[]> {
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: ExecutionRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('run_')) continue;
      try {
        records.push(await this.read(entry.name));
      } catch {
        // Ignore malformed historical entries here; direct reads still surface their error.
      }
    }
    return records;
  }

  async findByWorkerId(workerId: string): Promise<{ run: ExecutionRunRecord; planId: string } | undefined> {
    for (const run of await this.list()) {
      for (const [planId, state] of Object.entries(run.plans)) {
        if (state.workerId === workerId) return { run, planId };
      }
    }
    return undefined;
  }

  async updatePlanState(runId: string, planId: string, patch: Partial<PlanRunState>): Promise<ExecutionRunRecord> {
    const run = await this.read(runId);
    run.plans[planId] = { ...(run.plans[planId] ?? {}), ...patch };
    await this.write(run);
    return run;
  }

  async removePlanState(runId: string, planId: string): Promise<ExecutionRunRecord> {
    const run = await this.read(runId);
    delete run.plans[planId];
    await this.write(run);
    return run;
  }

  async attachPlanWorker(input: {
    runId: string;
    planId: string;
    workerId: string;
    conversationId?: string;
    idempotencyKey: string;
    baselineId: string;
    agyProjectId?: string;
    model?: string;
    effort?: string;
  }): Promise<ExecutionRunRecord> {
    const run = await this.read(input.runId);
    const existing = run.plans[input.planId] ?? {};
    run.plans[input.planId] = {
      ...existing,
      workerId: input.workerId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      baselineId: input.baselineId,
      startedAt: existing.startedAt ?? new Date().toISOString(),
      logicalStartedAt: existing.logicalStartedAt ?? new Date().toISOString(),
      autoResumeCount: existing.autoResumeCount ?? 0,
      stagnantResumeCount: existing.stagnantResumeCount ?? 0,
    };
    if (input.agyProjectId) run.agyProjectId = input.agyProjectId;
    if (input.model) run.model = input.model;
    if (input.effort) run.effort = input.effort;
    await this.write(run);
    return run;
  }

  async markWorkerClosed(workerId: string): Promise<{ run: ExecutionRunRecord; allClosed: boolean } | undefined> {
    const found = await this.findByWorkerId(workerId);
    if (!found) return undefined;
    const state = found.run.plans[found.planId] ?? {};
    state.closedAt = new Date().toISOString();
    found.run.plans[found.planId] = state;
    await this.write(found.run);
    const states = Object.values(found.run.plans).filter((entry) => entry.workerId);
    return { run: found.run, allClosed: states.length > 0 && states.every((entry) => Boolean(entry.closedAt)) };
  }

  async cleanupPlanBaseline(runId: string, planId: string): Promise<void> {
    await rm(this.baselineDir(runId, planId), { recursive: true, force: true });
  }

  async cleanupBaselines(runId: string): Promise<void> {
    await rm(path.join(this.runDir(runId), 'baselines'), { recursive: true, force: true });
  }

  async deleteRunIfEmpty(runId: string): Promise<boolean> {
    const run = await this.read(runId).catch(() => undefined);
    if (!run) return false;
    if (Object.values(run.plans).some((state) => Boolean(state.workerId))) return false;
    await rm(this.runDir(runId), { recursive: true, force: true });
    return true;
  }
}

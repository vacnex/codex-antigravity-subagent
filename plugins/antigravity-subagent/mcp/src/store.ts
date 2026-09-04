import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgyUsage } from './streaming.js';

export type WorkerLedgerTransport = 'stream' | 'oneshot';
export type WorkerLifecycleState = 'ready' | 'running' | 'recoverable' | 'closed' | 'error';
export type WorkerTurnKind = 'start' | 'followup';

export type WorkerLedgerRecord = {
  schemaVersion: 1;
  workerId: string;
  conversationId: string;
  name?: string;
  idempotencyKey?: string;
  cwd: string;
  mode: string;
  agent?: string;
  model: string;
  effort: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  closedAt?: string;
  state?: WorkerLifecycleState;
  activeTurnKind?: WorkerTurnKind;
  activeTurnKey?: string;
  activeTurnStartedAt?: string;
  lastTurnKind?: WorkerTurnKind;
  lastTurnKey?: string;
  lastTurnCompletedAt?: string;
  lastTransport?: WorkerLedgerTransport;
  lastDriverPid?: number;
  lastResultStatus?: string;
  lastDurationSeconds?: number;
  lastNumTurns?: number;
  lastUsage?: AgyUsage;
  lastTurnUsage?: AgyUsage;
  lastTimedOut?: boolean;
  lastCanceled?: boolean;
  lastError?: string;
};

export type WorkerLeaseRecord = {
  schemaVersion: 1;
  workerId: string;
  ownerId: string;
  processPid: number;
  acquiredAt: string;
  expiresAt: string;
};

export type WorkerLeaseResult = {
  acquired: boolean;
  lease?: WorkerLeaseRecord;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isUsage(value: unknown): value is AgyUsage | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return [
    value.input_tokens,
    value.output_tokens,
    value.thinking_tokens,
    value.cache_read_tokens,
    value.total_tokens,
  ].every(optionalNumber);
}

function isLifecycleState(value: unknown): value is WorkerLifecycleState | undefined {
  return value === undefined || ['ready', 'running', 'recoverable', 'closed', 'error'].includes(String(value));
}

function isTurnKind(value: unknown): value is WorkerTurnKind | undefined {
  return value === undefined || value === 'start' || value === 'followup';
}

export function isWorkerLedgerRecord(value: unknown): value is WorkerLedgerRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.workerId !== 'string' || !value.workerId) return false;
  if (typeof value.conversationId !== 'string' || !value.conversationId) return false;
  if (!optionalString(value.name) || !optionalString(value.idempotencyKey)) return false;
  if (typeof value.cwd !== 'string' || !value.cwd) return false;
  if (typeof value.mode !== 'string' || !value.mode) return false;
  if (!optionalString(value.agent)) return false;
  if (typeof value.model !== 'string' || !value.model) return false;
  if (typeof value.effort !== 'string' || !value.effort) return false;
  if (typeof value.createdAt !== 'string' || !value.createdAt) return false;
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) return false;
  if (!optionalString(value.lastActivityAt) || !optionalString(value.closedAt)) return false;
  if (!isLifecycleState(value.state)) return false;
  if (!isTurnKind(value.activeTurnKind) || !isTurnKind(value.lastTurnKind)) return false;
  if (!optionalString(value.activeTurnKey) || !optionalString(value.activeTurnStartedAt)) return false;
  if (!optionalString(value.lastTurnKey) || !optionalString(value.lastTurnCompletedAt)) return false;
  if (value.lastTransport !== undefined && value.lastTransport !== 'stream' && value.lastTransport !== 'oneshot') return false;
  if (!optionalNumber(value.lastDriverPid)) return false;
  if (!optionalString(value.lastResultStatus)) return false;
  if (!optionalNumber(value.lastDurationSeconds) || !optionalNumber(value.lastNumTurns)) return false;
  if (!isUsage(value.lastUsage) || !isUsage(value.lastTurnUsage)) return false;
  if (!optionalBoolean(value.lastTimedOut) || !optionalBoolean(value.lastCanceled)) return false;
  if (!optionalString(value.lastError)) return false;
  return true;
}

export function isWorkerLeaseRecord(value: unknown): value is WorkerLeaseRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  return typeof value.workerId === 'string' && value.workerId.length > 0
    && typeof value.ownerId === 'string' && value.ownerId.length > 0
    && typeof value.processPid === 'number' && Number.isInteger(value.processPid) && value.processPid > 0
    && typeof value.acquiredAt === 'string' && value.acquiredAt.length > 0
    && typeof value.expiresAt === 'string' && value.expiresAt.length > 0;
}

export function resolveWorkerStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = env.AGY_MCP_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const codexHome = env.CODEX_HOME?.trim() ? path.resolve(env.CODEX_HOME) : path.join(homeDir, '.codex');
  return path.join(codexHome, 'antigravity-subagent', 'workers');
}

function assertWorkerId(workerId: string): void {
  if (!/^agy_[A-Za-z0-9-]+$/.test(workerId)) {
    throw new Error(`Invalid Antigravity worker ID for ledger storage: ${workerId}`);
  }
}

function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function readJsonFile(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class WorkerStore {
  readonly rootDir: string;

  constructor(rootDir: string = resolveWorkerStateDir()) {
    this.rootDir = path.resolve(rootDir);
  }

  filePath(workerId: string): string {
    assertWorkerId(workerId);
    return path.join(this.rootDir, `${workerId}.json`);
  }

  leasePath(workerId: string): string {
    assertWorkerId(workerId);
    return path.join(this.rootDir, `${workerId}.lease.json`);
  }

  private reclaimPath(workerId: string): string {
    assertWorkerId(workerId);
    return path.join(this.rootDir, `${workerId}.lease.reclaim`);
  }

  private async atomicWrite(target: string, value: unknown): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const temporary = path.join(this.rootDir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async write(record: WorkerLedgerRecord): Promise<void> {
    const candidate: unknown = record;
    if (!isWorkerLedgerRecord(candidate)) throw new Error('Refusing to persist invalid Antigravity worker ledger record.');
    await this.atomicWrite(this.filePath(record.workerId), record);
  }

  async read(workerId: string): Promise<WorkerLedgerRecord | undefined> {
    const filename = this.filePath(workerId);
    const parsed = await readJsonFile(filename);
    if (parsed === undefined) return undefined;
    if (!isWorkerLedgerRecord(parsed)) throw new Error(`Invalid Antigravity worker ledger schema: ${filename}`);
    return parsed;
  }

  async listWithWarnings(): Promise<{ records: WorkerLedgerRecord[]; warnings: string[] }> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], warnings: [] };
      throw error;
    }

    const records: WorkerLedgerRecord[] = [];
    const warnings: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.startsWith('agy_') || !entry.endsWith('.json') || entry.endsWith('.lease.json')) continue;
      const workerId = entry.slice(0, -'.json'.length);
      try {
        const record = await this.read(workerId);
        if (record) records.push(record);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { records, warnings };
  }

  async list(): Promise<WorkerLedgerRecord[]> {
    return (await this.listWithWarnings()).records;
  }

  async readLease(workerId: string): Promise<WorkerLeaseRecord | undefined> {
    const filename = this.leasePath(workerId);
    let parsed: unknown;
    try {
      parsed = await readJsonFile(filename);
    } catch {
      return undefined;
    }
    if (parsed === undefined || !isWorkerLeaseRecord(parsed)) return undefined;
    return parsed;
  }

  private leaseIsStale(lease: WorkerLeaseRecord, now = Date.now()): boolean {
    const expiry = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiry) || expiry <= now || !pidIsAlive(lease.processPid);
  }

  private newLease(workerId: string, ownerId: string, ttlMs: number): WorkerLeaseRecord {
    const now = Date.now();
    return {
      schemaVersion: 1,
      workerId,
      ownerId,
      processPid: process.pid,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
  }

  private async writeLeaseExclusive(filename: string, lease: WorkerLeaseRecord): Promise<boolean> {
    try {
      await writeFile(filename, `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private async reclaimLease(workerId: string, ownerId: string, ttlMs: number): Promise<WorkerLeaseResult> {
    const filename = this.leasePath(workerId);
    const reclaim = this.reclaimPath(workerId);
    const marker = `${process.pid}:${randomUUID()}`;
    try {
      await writeFile(reclaim, `${marker}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { acquired: false, reason: 'another MCP process is reclaiming this stale worker lease' };
      }
      throw error;
    }

    try {
      const current = await this.readLease(workerId);
      if (current && !this.leaseIsStale(current)) {
        return {
          acquired: false,
          lease: current,
          reason: `worker is leased by MCP process ${current.processPid} until ${current.expiresAt}`,
        };
      }

      await rm(filename, { force: true });
      const lease = this.newLease(workerId, ownerId, ttlMs);
      if (await this.writeLeaseExclusive(filename, lease)) return { acquired: true, lease };

      const winner = await this.readLease(workerId);
      return {
        acquired: false,
        lease: winner,
        reason: winner
          ? `worker is leased by MCP process ${winner.processPid} until ${winner.expiresAt}`
          : 'worker lease was acquired concurrently by another MCP process',
      };
    } finally {
      await rm(reclaim, { force: true }).catch(() => undefined);
    }
  }

  async acquireLease(workerId: string, ownerId: string, ttlMs = 120_000): Promise<WorkerLeaseResult> {
    assertWorkerId(workerId);
    await mkdir(this.rootDir, { recursive: true });
    const filename = this.leasePath(workerId);
    const lease = this.newLease(workerId, ownerId, ttlMs);
    if (await this.writeLeaseExclusive(filename, lease)) return { acquired: true, lease };

    const existing = await this.readLease(workerId);
    if (existing?.ownerId === ownerId) {
      await this.refreshLease(workerId, ownerId, ttlMs);
      return { acquired: true, lease: await this.readLease(workerId) ?? existing };
    }
    if (!existing || this.leaseIsStale(existing)) return this.reclaimLease(workerId, ownerId, ttlMs);
    return {
      acquired: false,
      lease: existing,
      reason: `worker is leased by MCP process ${existing.processPid} until ${existing.expiresAt}`,
    };
  }

  async refreshLease(workerId: string, ownerId: string, ttlMs = 120_000): Promise<boolean> {
    const existing = await this.readLease(workerId);
    if (!existing || existing.ownerId !== ownerId) return false;
    await this.atomicWrite(this.leasePath(workerId), {
      ...existing,
      processPid: process.pid,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    } satisfies WorkerLeaseRecord);
    return true;
  }

  async releaseLease(workerId: string, ownerId: string): Promise<boolean> {
    const existing = await this.readLease(workerId);
    if (!existing) return true;
    if (existing.ownerId !== ownerId) return false;
    await rm(this.leasePath(workerId), { force: true });
    return true;
  }
}

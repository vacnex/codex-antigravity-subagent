import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgyUsage } from './streaming.js';

export type WorkerLedgerTransport = 'stream' | 'oneshot';

export type WorkerLedgerRecord = {
  schemaVersion: 1;
  workerId: string;
  conversationId: string;
  cwd: string;
  mode: string;
  agent?: string;
  model: string;
  effort: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  lastTransport?: WorkerLedgerTransport;
  lastDriverPid?: number;
  lastResultStatus?: string;
  lastDurationSeconds?: number;
  lastNumTurns?: number;
  lastUsage?: AgyUsage;
  lastTimedOut?: boolean;
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

export function isWorkerLedgerRecord(value: unknown): value is WorkerLedgerRecord {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.workerId !== 'string' || !value.workerId) return false;
  if (typeof value.conversationId !== 'string' || !value.conversationId) return false;
  if (typeof value.cwd !== 'string' || !value.cwd) return false;
  if (typeof value.mode !== 'string' || !value.mode) return false;
  if (!optionalString(value.agent)) return false;
  if (typeof value.model !== 'string' || !value.model) return false;
  if (typeof value.effort !== 'string' || !value.effort) return false;
  if (typeof value.createdAt !== 'string' || !value.createdAt) return false;
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) return false;
  if (!optionalString(value.closedAt)) return false;
  if (value.lastTransport !== undefined && value.lastTransport !== 'stream' && value.lastTransport !== 'oneshot') return false;
  if (!optionalNumber(value.lastDriverPid)) return false;
  if (!optionalString(value.lastResultStatus)) return false;
  if (!optionalNumber(value.lastDurationSeconds)) return false;
  if (!optionalNumber(value.lastNumTurns)) return false;
  if (!isUsage(value.lastUsage)) return false;
  if (!optionalBoolean(value.lastTimedOut)) return false;
  return true;
}

export function resolveWorkerStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = env.AGY_MCP_STATE_DIR?.trim();
  if (override) return path.resolve(override);

  const codexHome = env.CODEX_HOME?.trim()
    ? path.resolve(env.CODEX_HOME)
    : path.join(homeDir, '.codex');
  return path.join(codexHome, 'antigravity-subagent', 'workers');
}

function assertWorkerId(workerId: string): void {
  if (!/^agy_[A-Za-z0-9-]+$/.test(workerId)) {
    throw new Error(`Invalid Antigravity worker ID for ledger storage: ${workerId}`);
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

  async write(record: WorkerLedgerRecord): Promise<void> {
    if (!isWorkerLedgerRecord(record)) {
      throw new Error(`Refusing to persist invalid Antigravity worker ledger record: ${record.workerId ?? 'unknown'}`);
    }
    assertWorkerId(record.workerId);
    await mkdir(this.rootDir, { recursive: true });

    const target = this.filePath(record.workerId);
    const temporary = path.join(
      this.rootDir,
      `.${record.workerId}.${process.pid}.${randomUUID()}.tmp`,
    );
    const json = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(temporary, json, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(workerId: string): Promise<WorkerLedgerRecord | undefined> {
    const filename = this.filePath(workerId);
    let raw: string;
    try {
      raw = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in Antigravity worker ledger: ${filename}`);
    }
    if (!isWorkerLedgerRecord(parsed)) {
      throw new Error(`Invalid Antigravity worker ledger schema: ${filename}`);
    }
    return parsed;
  }

  async list(): Promise<WorkerLedgerRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const records: WorkerLedgerRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.startsWith('agy_') || !entry.endsWith('.json')) continue;
      const workerId = entry.slice(0, -'.json'.length);
      try {
        const record = await this.read(workerId);
        if (record) records.push(record);
      } catch {
        // A single corrupted record must not prevent discovery of every other worker.
        // Plan 4 recovery will surface corruption warnings explicitly.
      }
    }
    return records;
  }
}

import { WorkerStore, type WorkerLedgerRecord, type WorkerLedgerTransport } from './store.js';
import type { AgyUsage } from './streaming.js';

export type WorkerLedgerWorker = {
  workerId: string;
  conversationId: string;
  cwd: string;
  mode: string;
  agent?: string;
  model: string;
  effort: string;
  createdAt: string;
};

export type WorkerLedgerTurn = {
  transport: WorkerLedgerTransport;
  driverPid?: number;
  status?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: AgyUsage;
  timedOut?: boolean;
};

type ToolResultLike = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

type LedgerDecoratedResult = ToolResultLike & {
  structuredContent: Record<string, unknown> & {
    ledgerPersisted: boolean;
    persistenceError?: string;
  };
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseRecord(worker: WorkerLedgerWorker, updatedAt: string): WorkerLedgerRecord {
  return {
    schemaVersion: 1,
    workerId: worker.workerId,
    conversationId: worker.conversationId,
    cwd: worker.cwd,
    mode: worker.mode,
    agent: worker.agent,
    model: worker.model,
    effort: worker.effort,
    createdAt: worker.createdAt,
    updatedAt,
  };
}

export class WorkerLedger {
  readonly store: WorkerStore;

  constructor(store: WorkerStore = new WorkerStore()) {
    this.store = store;
  }

  get stateDir(): string {
    return this.store.rootDir;
  }

  async recordTurn(worker: WorkerLedgerWorker, turn: WorkerLedgerTurn): Promise<string | undefined> {
    const updatedAt = new Date().toISOString();
    const record: WorkerLedgerRecord = {
      ...baseRecord(worker, updatedAt),
      lastTransport: turn.transport,
      lastDriverPid: turn.driverPid,
      lastResultStatus: turn.status,
      lastDurationSeconds: turn.durationSeconds,
      lastNumTurns: turn.numTurns,
      lastUsage: turn.usage,
      lastTimedOut: turn.timedOut,
    };

    try {
      await this.store.write(record);
      return undefined;
    } catch (error) {
      return errorText(error);
    }
  }

  async markClosed(worker: WorkerLedgerWorker): Promise<string | undefined> {
    const closedAt = new Date().toISOString();
    let existing: WorkerLedgerRecord | undefined;
    let warning: string | undefined;
    try {
      existing = await this.store.read(worker.workerId);
    } catch (error) {
      warning = `Could not read prior ledger record: ${errorText(error)}`;
    }

    const record: WorkerLedgerRecord = {
      ...(existing ?? baseRecord(worker, closedAt)),
      conversationId: worker.conversationId,
      updatedAt: closedAt,
      closedAt,
    };

    try {
      await this.store.write(record);
      return warning;
    } catch (error) {
      const writeError = `Could not persist closed worker ledger: ${errorText(error)}`;
      return warning ? `${warning} | ${writeError}` : writeError;
    }
  }
}

export function withLedgerStatus(
  result: ToolResultLike,
  persistenceError?: string,
): LedgerDecoratedResult {
  const warning = persistenceError
    ? `\n\n[Warning: worker ledger update failed: ${persistenceError}]`
    : '';
  return {
    ...result,
    content: result.content.map((entry, index) => (
      index === 0 && warning
        ? { ...entry, text: `${entry.text}${warning}` }
        : entry
    )),
    structuredContent: {
      ...result.structuredContent,
      ledgerPersisted: !persistenceError,
      ...(persistenceError ? { persistenceError } : {}),
    },
  };
}

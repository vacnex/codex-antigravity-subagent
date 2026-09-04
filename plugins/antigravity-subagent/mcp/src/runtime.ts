import { randomUUID } from 'node:crypto';

import {
  buildOneShotArgs,
  buildPersistentArgs,
  findAgy,
  parseAgyEnvelope,
  probeAgyCapabilities,
  runAgy,
  type Effort,
  type RunMode,
  type WorkerExecutionOptions,
} from './cli.js';
import { AgyPersistentDriver, type AgyDriverTurnResult } from './driver.js';
import {
  WorkerStore,
  type WorkerLedgerRecord,
  type WorkerLifecycleState,
  type WorkerTurnKind,
} from './store.js';
import type { AgyStreamEvent, AgyUsage } from './streaming.js';

export type WorkerState = {
  workerId: string;
  conversationId: string;
  name: string;
  idempotencyKey?: string;
  cwd: string;
  mode: RunMode;
  agent?: string;
  model: string;
  effort: Effort;
  createdAt: string;
  lastActivityAt: string;
  lastUsage?: AgyUsage;
  state: WorkerLifecycleState;
  recovered: boolean;
};

export type WorkerStartInput = WorkerExecutionOptions & {
  prompt: string;
  name?: string;
  idempotencyKey?: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
};

export type WorkerFollowupInput = {
  workerId: string;
  prompt: string;
  idempotencyKey?: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
};

export type RuntimeToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

type ProgressSummary = {
  stepUpdates: number;
  toolEvents: number;
  subagentEvents: number;
};

type ActiveOneShot = { controller: AbortController };

type ActiveTurn = {
  token: string;
  kind: WorkerTurnKind;
  key?: string;
  startedAt: string;
  timeoutSeconds: number;
  transport: 'stream' | 'oneshot';
  previousUsage?: AgyUsage;
};

const MAX_RESPONSE_BYTES = 64 * 1024;
const LEASE_TTL_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const DEFAULT_IDLE_DRIVER_MS = 10 * 60_000;
const START_DUPLICATE_WINDOW_MS = 30 * 60_000;
const DRIVER_INIT_TIMEOUT_MS = 15_000;

function textError(text: string, structuredContent: Record<string, unknown> = {}): RuntimeToolResult {
  return { content: [{ type: 'text', text }], structuredContent, isError: true };
}

function clipResponse(text: string): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= MAX_RESPONSE_BYTES) return { text, truncated: false };
  return {
    text: `${encoded.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')}\n\n[Response truncated at 64 KiB]`,
    truncated: true,
  };
}

function normalizeRequestedName(name: string | undefined): string | undefined {
  const trimmed = name?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function normalizeName(name: string | undefined, workerId: string): string {
  return normalizeRequestedName(name) ?? `Antigravity worker ${workerId.slice(-8)}`;
}

function normalizeKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function pathIdentity(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function asRunMode(value: string): RunMode | undefined {
  return value === 'plan' || value === 'default' || value === 'accept-edits' ? value : undefined;
}

function asEffort(value: string): Effort | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function usageDelta(current: AgyUsage | undefined, previous: AgyUsage | undefined): AgyUsage | undefined {
  if (!current) return undefined;
  const delta: AgyUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'] as const) {
    const now = current[key];
    if (typeof now !== 'number') continue;
    const before = previous?.[key];
    delta[key] = typeof before === 'number' && now >= before ? now - before : now;
  }
  return delta;
}

function workerFromRecord(record: WorkerLedgerRecord): WorkerState | undefined {
  const mode = asRunMode(record.mode);
  const effort = asEffort(record.effort);
  if (!mode || !effort || record.closedAt) return undefined;
  return {
    workerId: record.workerId,
    conversationId: record.conversationId,
    name: record.name || `Antigravity worker ${record.workerId.slice(-8)}`,
    idempotencyKey: record.idempotencyKey,
    cwd: record.cwd,
    mode,
    agent: record.agent,
    model: record.model,
    effort,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt ?? record.updatedAt,
    lastUsage: record.lastUsage,
    state: 'recoverable',
    recovered: true,
  };
}

function executionOptions(worker: WorkerState): WorkerExecutionOptions {
  return { cwd: worker.cwd, mode: worker.mode, agent: worker.agent, model: worker.model, effort: worker.effort };
}

function cloneResult(result: RuntimeToolResult): RuntimeToolResult {
  return {
    content: result.content.map((entry) => ({ ...entry })),
    structuredContent: { ...result.structuredContent },
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

export class WorkerRuntime {
  readonly store: WorkerStore;
  readonly ownerId = `mcp_${randomUUID()}`;
  private readonly workers = new Map<string, WorkerState>();
  private readonly drivers = new Map<string, AgyPersistentDriver>();
  private readonly activeOneShots = new Map<string, ActiveOneShot>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly completedResults = new Map<string, RuntimeToolResult>();
  private readonly leaseHeartbeats = new Map<string, NodeJS.Timeout>();
  private readonly closing = new Set<string>();
  private readonly progress = new WeakMap<AgyPersistentDriver, ProgressSummary>();
  private recoveryPromise?: Promise<void>;
  private recoveryWarnings: string[] = [];
  private readonly idleDriverMs: number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(store = new WorkerStore()) {
    this.store = store;
    const configured = Number(process.env.AGY_MCP_IDLE_DRIVER_MS);
    this.idleDriverMs = Number.isFinite(configured) && configured >= 10_000 ? configured : DEFAULT_IDLE_DRIVER_MS;
    this.sweepTimer = setInterval(
      () => { void this.sweepIdleDrivers(); },
      Math.min(60_000, Math.max(10_000, this.idleDriverMs / 2)),
    );
    this.sweepTimer.unref?.();
  }

  async ensureRecovered(): Promise<void> {
    if (!this.recoveryPromise) this.recoveryPromise = this.loadRecovery();
    await this.recoveryPromise;
  }

  private async loadRecovery(): Promise<void> {
    try {
      const { records, warnings } = await this.store.listWithWarnings();
      this.recoveryWarnings = warnings;
      for (const record of records) {
        const worker = workerFromRecord(record);
        if (!worker || this.workers.has(worker.workerId)) continue;

        const activeLease = (record.state === 'running' || record.activeTurnKind)
          ? await this.store.readActiveLease(record.workerId)
          : undefined;
        if (activeLease) {
          // Another live MCP process still owns this running worker. Keep the logical state visible
          // as running, but never mutate its ledger or attempt to recover it from this process.
          worker.state = 'running';
          worker.recovered = true;
          this.workers.set(worker.workerId, worker);
          continue;
        }

        this.workers.set(worker.workerId, worker);
        // A persisted running turn with no live lease cannot still be executing under a managed
        // owner. Mark it interrupted immediately so status/result never report a ghost process.
        if (record.state === 'running' || record.activeTurnKind) {
          const now = new Date().toISOString();
          worker.state = 'recoverable';
          worker.recovered = true;
          worker.lastActivityAt = now;
          const persistenceError = await this.persist(worker, {
            state: 'recoverable',
            activeTurnKind: undefined,
            activeTurnKey: undefined,
            activeTurnStartedAt: undefined,
            lastTurnKind: record.activeTurnKind ?? record.lastTurnKind,
            lastTurnKey: record.activeTurnKey ?? record.lastTurnKey,
            lastTurnCompletedAt: now,
            lastResultStatus: record.lastResultStatus === 'RUNNING' || !record.lastResultStatus
              ? 'INTERRUPTED'
              : record.lastResultStatus,
            lastDriverPid: undefined,
            lastError: record.lastError ?? 'MCP restarted while the Antigravity turn was active',
          });
          if (persistenceError) this.recoveryWarnings.push(persistenceError);
        }
      }
    } catch (error) {
      this.recoveryWarnings = [error instanceof Error ? error.message : String(error)];
    }
  }

  getRecoveryWarnings(): string[] { return [...this.recoveryWarnings]; }

  private async acquireLease(workerId: string, keepAlive: boolean): Promise<string | undefined> {
    const result = await this.store.acquireLease(workerId, this.ownerId, LEASE_TTL_MS);
    if (!result.acquired) return result.reason ?? 'worker lease is held by another MCP process';
    if (keepAlive) this.startLeaseHeartbeat(workerId);
    return undefined;
  }

  private startLeaseHeartbeat(workerId: string): void {
    if (this.leaseHeartbeats.has(workerId)) return;
    const timer = setInterval(() => {
      void this.store.refreshLease(workerId, this.ownerId, LEASE_TTL_MS).then(async (refreshed) => {
        if (refreshed) return;
        const driver = this.drivers.get(workerId);
        if (driver?.isBusy) await driver.cancelCurrentTurn().catch(() => false);
        else if (driver) await driver.close().catch(() => undefined);
        this.drivers.delete(workerId);
        this.activeOneShots.get(workerId)?.controller.abort(new Error('Worker lease was lost'));
        const worker = this.workers.get(workerId);
        if (worker) {
          worker.state = 'recoverable';
          worker.recovered = true;
          worker.lastActivityAt = new Date().toISOString();
          await this.persist(worker, { state: 'recoverable', lastDriverPid: undefined, lastError: 'Worker lease was lost' });
        }
        this.stopLeaseHeartbeat(workerId);
      }).catch(() => undefined);
    }, LEASE_HEARTBEAT_MS);
    timer.unref?.();
    this.leaseHeartbeats.set(workerId, timer);
  }

  private stopLeaseHeartbeat(workerId: string): void {
    const timer = this.leaseHeartbeats.get(workerId);
    if (timer) clearInterval(timer);
    this.leaseHeartbeats.delete(workerId);
  }

  private async releaseLease(workerId: string): Promise<void> {
    this.stopLeaseHeartbeat(workerId);
    await this.store.releaseLease(workerId, this.ownerId).catch(() => false);
  }

  private async persist(worker: WorkerState, patch: Partial<WorkerLedgerRecord> = {}): Promise<string | undefined> {
    const updatedAt = new Date().toISOString();
    let existing: WorkerLedgerRecord | undefined;
    try { existing = await this.store.read(worker.workerId); } catch { /* rebuild from memory */ }
    const record: WorkerLedgerRecord = {
      ...(existing ?? {}),
      ...patch,
      schemaVersion: 1,
      workerId: worker.workerId,
      conversationId: worker.conversationId,
      name: worker.name,
      idempotencyKey: worker.idempotencyKey,
      cwd: worker.cwd,
      mode: worker.mode,
      agent: worker.agent,
      model: worker.model,
      effort: worker.effort,
      createdAt: worker.createdAt,
      updatedAt,
      lastActivityAt: worker.lastActivityAt,
      state: patch.state ?? worker.state,
    };
    try {
      await this.store.write(record);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private decoratePersistence(result: RuntimeToolResult, error?: string): RuntimeToolResult {
    result.structuredContent.ledgerPersisted = !error;
    if (!error) return result;
    result.structuredContent.persistenceError = error;
    if (result.content[0]) result.content[0].text += `\n\n[Warning: worker ledger update failed: ${error}]`;
    return result;
  }

  private createProgress(): { summary: ProgressSummary; onEvent: (event: AgyStreamEvent) => void } {
    const summary: ProgressSummary = { stepUpdates: 0, toolEvents: 0, subagentEvents: 0 };
    return {
      summary,
      onEvent: (event) => {
        if (event.event !== 'step_update') return;
        summary.stepUpdates += 1;
        if (event.toolInfo || event.toolName) summary.toolEvents += 1;
        if (event.subagentInfo) summary.subagentEvents += 1;
      },
    };
  }

  private createDriver(worker: WorkerState, executable: string, resume: boolean): AgyPersistentDriver {
    const progress = this.createProgress();
    let driver!: AgyPersistentDriver;
    driver = new AgyPersistentDriver({
      command: executable,
      args: buildPersistentArgs(executionOptions(worker), resume ? worker.conversationId : undefined),
      cwd: worker.cwd,
      onEvent: progress.onEvent,
      onExit: () => queueMicrotask(() => { void this.handleDriverExit(worker.workerId, driver); }),
    });
    this.progress.set(driver, progress.summary);
    return driver;
  }

  private async handleDriverExit(workerId: string, driver: AgyPersistentDriver): Promise<void> {
    if (this.drivers.get(workerId) !== driver) return;
    this.drivers.delete(workerId);
    if (this.closing.has(workerId) || this.activeTurns.has(workerId)) return;
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.state = 'recoverable';
      worker.recovered = true;
      worker.lastActivityAt = new Date().toISOString();
      await this.persist(worker, { state: 'recoverable', lastDriverPid: undefined });
    }
    await this.releaseLease(workerId);
  }

  private streamResult(
    worker: WorkerState,
    turn: AgyDriverTurnResult,
    driver: AgyPersistentDriver,
    timeoutSeconds: number,
    previousUsage?: AgyUsage,
  ): RuntimeToolResult {
    const event = turn.result;
    const rawText = turn.timedOut
      ? `Antigravity timed out after ${timeoutSeconds} seconds.`
      : turn.canceled
        ? 'Antigravity turn was canceled.'
        : event?.response?.trim() || event?.error?.trim() || turn.stderr || '(Antigravity returned no output)';
    const clipped = clipResponse(rawText);
    const sessionUsage = event?.usage;
    const turnUsage = usageDelta(sessionUsage, previousUsage);
    const isError = turn.timedOut || turn.canceled || !event || event.status !== 'SUCCESS';
    return {
      content: [{ type: 'text', text: clipped.text }],
      structuredContent: {
        workerId: worker.workerId,
        conversationId: event?.conversationId ?? worker.conversationId,
        name: worker.name,
        idempotencyKey: worker.idempotencyKey,
        status: event?.status ?? (turn.canceled ? 'CANCELED' : 'ERROR'),
        state: worker.state,
        model: worker.model,
        effort: worker.effort,
        mode: worker.mode,
        cwd: worker.cwd,
        durationSeconds: event?.durationSeconds,
        numTurns: event?.numTurns,
        usage: sessionUsage,
        sessionUsage,
        turnUsage,
        timedOut: turn.timedOut,
        canceled: turn.canceled,
        truncated: turn.diagnosticsTruncated || clipped.truncated,
        transport: 'stream',
        driverPid: driver.pid,
        warm: driver.isAlive,
        progress: this.progress.get(driver),
        background: true,
        done: true,
        resultAvailable: true,
      },
      isError,
    };
  }

  private oneShotResult(
    worker: WorkerState,
    result: Awaited<ReturnType<typeof runAgy>>,
    timeoutSeconds: number,
    previousUsage?: AgyUsage,
  ): RuntimeToolResult {
    const envelope = parseAgyEnvelope(result);
    const rawText = result.timedOut
      ? `Antigravity timed out after ${timeoutSeconds} seconds.`
      : result.canceled
        ? 'Antigravity turn was canceled.'
        : envelope?.response?.trim() || envelope?.error?.trim() || result.stderr.trim() || result.stdout.trim() || '(Antigravity returned no output)';
    const clipped = clipResponse(rawText);
    const sessionUsage = envelope?.usage;
    const isError = result.timedOut || result.canceled || result.exitCode !== 0 || Boolean(envelope && envelope.status !== 'SUCCESS');
    return {
      content: [{ type: 'text', text: clipped.text }],
      structuredContent: {
        workerId: worker.workerId,
        conversationId: envelope?.conversation_id ?? worker.conversationId,
        name: worker.name,
        idempotencyKey: worker.idempotencyKey,
        status: envelope?.status ?? (result.canceled ? 'CANCELED' : isError ? 'ERROR' : 'SUCCESS'),
        state: worker.state,
        model: worker.model,
        effort: worker.effort,
        mode: worker.mode,
        cwd: worker.cwd,
        durationSeconds: envelope?.duration_seconds,
        numTurns: envelope?.num_turns,
        usage: sessionUsage,
        sessionUsage,
        turnUsage: usageDelta(sessionUsage, previousUsage),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        canceled: result.canceled,
        truncated: result.truncated || clipped.truncated,
        transport: 'oneshot',
        warm: false,
        background: true,
        done: true,
        resultAvailable: true,
      },
      isError,
    };
  }

  private runningResult(worker: WorkerState, transport: 'stream' | 'oneshot', reused = false): RuntimeToolResult {
    const driver = this.drivers.get(worker.workerId);
    const active = this.activeTurns.get(worker.workerId);
    return {
      content: [{
        type: 'text',
        text: `${reused ? 'Reusing' : 'Started'} ${worker.name} (${worker.workerId}) in the background. Use agy_result or agy_status for its current state.`,
      }],
      structuredContent: {
        workerId: worker.workerId,
        conversationId: worker.conversationId,
        name: worker.name,
        idempotencyKey: worker.idempotencyKey,
        state: 'running',
        status: 'RUNNING',
        model: worker.model,
        effort: worker.effort,
        mode: worker.mode,
        cwd: worker.cwd,
        transport,
        driverPid: driver?.pid,
        warm: Boolean(driver?.isAlive),
        progress: driver ? this.progress.get(driver) : undefined,
        activeTurnKind: active?.kind,
        activeTurnKey: active?.key,
        activeTurnStartedAt: active?.startedAt,
        background: true,
        done: false,
        resultAvailable: false,
        reused,
        ledgerPersisted: true,
      },
    };
  }

  private async findStartDuplicates(input: { name?: string; cwd: string; idempotencyKey?: string }): Promise<WorkerLedgerRecord[]> {
    const records = await this.store.list();
    const key = normalizeKey(input.idempotencyKey);
    if (key) return records.filter((record) => record.idempotencyKey === key);

    const name = normalizeRequestedName(input.name);
    if (!name) return [];
    const cwd = pathIdentity(input.cwd);
    const now = Date.now();
    return records.filter((record) => {
      if (record.closedAt || record.name !== name || pathIdentity(record.cwd) !== cwd) return false;
      const created = Date.parse(record.createdAt);
      return Number.isFinite(created) && now - created <= START_DUPLICATE_WINDOW_MS;
    });
  }

  async reuseExistingStart(input: { name?: string; cwd: string; idempotencyKey?: string }): Promise<RuntimeToolResult | undefined> {
    await this.ensureRecovered();
    const matches = await this.findStartDuplicates(input);
    if (matches.length === 0) return undefined;
    matches.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const record = matches[0];
    const worker = this.workers.get(record.workerId);
    const driver = this.drivers.get(record.workerId);
    const active = this.activeTurns.get(record.workerId);
    const activeLease = await this.store.readActiveLease(record.workerId);
    if (worker?.recovered && !active && !driver?.isBusy && !(record.state === 'running' && activeLease)) {
      worker.state = 'recoverable';
    }
    const state: WorkerLifecycleState = record.closedAt
      ? 'closed'
      : active || driver?.isBusy || (record.state === 'running' && Boolean(activeLease))
        ? 'running'
        : worker?.state ?? 'recoverable';
    const duplicateWorkerIds = matches.slice(1).map((item) => item.workerId);
    return {
      content: [{
        type: 'text',
        text: `Reusing existing worker ${record.workerId} for ${record.name ?? 'the same plan step'}; no duplicate Antigravity worker was started.`,
      }],
      structuredContent: {
        workerId: record.workerId,
        conversationId: record.conversationId,
        name: record.name,
        idempotencyKey: record.idempotencyKey,
        state,
        status: state === 'running' ? 'RUNNING' : record.lastResultStatus,
        warm: Boolean(driver?.isAlive),
        driverPid: driver?.pid,
        model: record.model,
        effort: record.effort,
        mode: record.mode,
        cwd: record.cwd,
        activeTurnKind: active?.kind ?? record.activeTurnKind,
        activeTurnKey: active?.key ?? record.activeTurnKey,
        activeTurnStartedAt: active?.startedAt ?? record.activeTurnStartedAt,
        lastTimedOut: record.lastTimedOut,
        lastCanceled: record.lastCanceled,
        lastError: record.lastError,
        reused: true,
        duplicateWorkerIds,
        background: true,
        done: state !== 'running',
        resultAvailable: this.completedResults.has(record.workerId),
        ledgerPersisted: true,
      },
    };
  }

  private async finishStreamTurn(
    worker: WorkerState,
    driver: AgyPersistentDriver,
    turn: AgyDriverTurnResult,
    active: ActiveTurn,
  ): Promise<void> {
    if (this.activeTurns.get(worker.workerId)?.token !== active.token) return;
    if (turn.result?.conversationId) worker.conversationId = turn.result.conversationId;
    worker.lastUsage = turn.result?.usage ?? worker.lastUsage;
    worker.lastActivityAt = new Date().toISOString();
    worker.state = turn.timedOut || turn.canceled || !driver.isAlive ? 'recoverable' : 'ready';
    worker.recovered = worker.state === 'recoverable';
    if (!driver.isAlive) this.drivers.delete(worker.workerId);

    const resultStatus = turn.result?.status ?? (turn.canceled ? 'CANCELED' : 'ERROR');
    const lastError = resultStatus === 'SUCCESS'
      ? undefined
      : ((turn.result?.error ?? turn.stderr) || undefined);
    const persistenceError = await this.persist(worker, {
      state: worker.state,
      activeTurnKind: undefined,
      activeTurnKey: undefined,
      activeTurnStartedAt: undefined,
      lastTurnKind: active.kind,
      lastTurnKey: active.key,
      lastTurnCompletedAt: new Date().toISOString(),
      lastTransport: 'stream',
      lastDriverPid: driver.isAlive ? driver.pid : undefined,
      lastResultStatus: resultStatus,
      lastDurationSeconds: turn.result?.durationSeconds,
      lastNumTurns: turn.result?.numTurns,
      lastUsage: worker.lastUsage,
      lastTurnUsage: usageDelta(worker.lastUsage, active.previousUsage),
      lastTimedOut: turn.timedOut,
      lastCanceled: turn.canceled,
      lastError,
    });
    this.activeTurns.delete(worker.workerId);
    if (!driver.isAlive) await this.releaseLease(worker.workerId);
    this.completedResults.set(
      worker.workerId,
      this.decoratePersistence(this.streamResult(worker, turn, driver, active.timeoutSeconds, active.previousUsage), persistenceError),
    );
  }

  private async finishOneShotTurn(
    worker: WorkerState,
    result: Awaited<ReturnType<typeof runAgy>>,
    active: ActiveTurn,
  ): Promise<void> {
    if (this.activeTurns.get(worker.workerId)?.token !== active.token) return;
    const envelope = parseAgyEnvelope(result);
    if (envelope?.conversation_id) worker.conversationId = envelope.conversation_id;
    worker.lastUsage = envelope?.usage ?? worker.lastUsage;
    worker.lastActivityAt = new Date().toISOString();
    worker.state = result.timedOut || result.canceled ? 'recoverable' : 'ready';
    worker.recovered = result.timedOut || result.canceled;
    const resultStatus = envelope?.status ?? (result.canceled ? 'CANCELED' : result.exitCode === 0 ? 'SUCCESS' : 'ERROR');
    const lastError = resultStatus === 'SUCCESS'
      ? undefined
      : ((envelope?.error ?? result.stderr.trim()) || undefined);
    const persistenceError = await this.persist(worker, {
      state: worker.state,
      activeTurnKind: undefined,
      activeTurnKey: undefined,
      activeTurnStartedAt: undefined,
      lastTurnKind: active.kind,
      lastTurnKey: active.key,
      lastTurnCompletedAt: new Date().toISOString(),
      lastTransport: 'oneshot',
      lastDriverPid: undefined,
      lastResultStatus: resultStatus,
      lastDurationSeconds: envelope?.duration_seconds,
      lastNumTurns: envelope?.num_turns,
      lastUsage: worker.lastUsage,
      lastTurnUsage: usageDelta(worker.lastUsage, active.previousUsage),
      lastTimedOut: result.timedOut,
      lastCanceled: result.canceled,
      lastError,
    });
    this.activeOneShots.delete(worker.workerId);
    this.activeTurns.delete(worker.workerId);
    await this.releaseLease(worker.workerId);
    this.completedResults.set(
      worker.workerId,
      this.decoratePersistence(this.oneShotResult(worker, result, active.timeoutSeconds, active.previousUsage), persistenceError),
    );
  }

  private async finishTurnFailure(worker: WorkerState, active: ActiveTurn, error: unknown): Promise<void> {
    if (this.activeTurns.get(worker.workerId)?.token !== active.token) return;
    const message = error instanceof Error ? error.message : String(error);
    worker.state = 'recoverable';
    worker.recovered = true;
    worker.lastActivityAt = new Date().toISOString();
    const persistenceError = await this.persist(worker, {
      state: 'recoverable',
      activeTurnKind: undefined,
      activeTurnKey: undefined,
      activeTurnStartedAt: undefined,
      lastTurnKind: active.kind,
      lastTurnKey: active.key,
      lastTurnCompletedAt: new Date().toISOString(),
      lastResultStatus: 'ERROR',
      lastDriverPid: undefined,
      lastError: message,
    });
    this.activeOneShots.delete(worker.workerId);
    this.activeTurns.delete(worker.workerId);
    const driver = this.drivers.get(worker.workerId);
    if (driver && !driver.isBusy) await driver.close().catch(() => undefined);
    this.drivers.delete(worker.workerId);
    await this.releaseLease(worker.workerId);
    this.completedResults.set(worker.workerId, this.decoratePersistence(textError(
      `Antigravity worker turn failed: ${message}`,
      {
        workerId: worker.workerId,
        conversationId: worker.conversationId,
        name: worker.name,
        state: worker.state,
        status: 'ERROR',
        background: true,
        done: true,
        resultAvailable: true,
      },
    ), persistenceError));
  }

  async start(input: WorkerStartInput): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const reused = await this.reuseExistingStart(input);
    if (reused) return reused;

    const executable = await findAgy();
    if (!executable) return textError('Antigravity CLI was not found. Run agy_check first.');
    if (input.signal?.aborted) return textError('Antigravity start was canceled before launch.');

    const workerId = `agy_${randomUUID()}`;
    const now = new Date().toISOString();
    const worker: WorkerState = {
      workerId,
      conversationId: '',
      name: normalizeName(input.name, workerId),
      idempotencyKey: normalizeKey(input.idempotencyKey),
      cwd: input.cwd,
      mode: input.mode,
      agent: input.agent,
      model: input.model,
      effort: input.effort,
      createdAt: now,
      lastActivityAt: now,
      state: 'running',
      recovered: false,
    };

    const capabilities = await probeAgyCapabilities(executable);
    if (capabilities.streaming.persistentDriver) {
      const leaseError = await this.acquireLease(workerId, true);
      if (leaseError) return textError(`Could not acquire worker lease: ${leaseError}`, { workerId });
      const driver = this.createDriver(worker, executable, false);
      this.drivers.set(workerId, driver);
      try {
        const init = await driver.waitForInit(DRIVER_INIT_TIMEOUT_MS, input.signal);
        if (!init || input.signal?.aborted) {
          await driver.close().catch(() => undefined);
          this.drivers.delete(workerId);
          await this.releaseLease(workerId);
          return textError(input.signal?.aborted
            ? 'Antigravity start was canceled before the stream handshake completed.'
            : `Antigravity stream did not initialize within ${DRIVER_INIT_TIMEOUT_MS / 1000} seconds.`);
        }

        worker.conversationId = init.conversationId;
        this.workers.set(workerId, worker);
        const active: ActiveTurn = {
          token: randomUUID(),
          kind: 'start',
          key: worker.idempotencyKey,
          startedAt: new Date().toISOString(),
          timeoutSeconds: input.timeoutSeconds,
          transport: 'stream',
          previousUsage: undefined,
        };
        const persistenceError = await this.persist(worker, {
          state: 'running',
          idempotencyKey: worker.idempotencyKey,
          activeTurnKind: active.kind,
          activeTurnKey: active.key,
          activeTurnStartedAt: active.startedAt,
          lastTransport: 'stream',
          lastDriverPid: driver.pid,
          lastResultStatus: 'RUNNING',
          lastTimedOut: false,
          lastCanceled: false,
          lastError: undefined,
        });
        if (persistenceError) {
          await driver.close().catch(() => undefined);
          this.drivers.delete(workerId);
          this.workers.delete(workerId);
          await this.releaseLease(workerId);
          return textError(`Failed to persist Antigravity worker before launch: ${persistenceError}`, { workerId, conversationId: worker.conversationId });
        }

        this.activeTurns.set(workerId, active);
        this.completedResults.delete(workerId);
        const turnPromise = driver.send(input.prompt, input.timeoutSeconds * 1000);
        void turnPromise
          .then((turn) => this.finishStreamTurn(worker, driver, turn, active))
          .catch((error) => this.finishTurnFailure(worker, active, error));
        return this.runningResult(worker, 'stream');
      } catch (error) {
        this.activeTurns.delete(workerId);
        this.closing.add(workerId);
        if (driver.isBusy) await driver.cancelCurrentTurn().catch(() => false);
        await driver.close().catch(() => undefined);
        this.closing.delete(workerId);
        this.drivers.delete(workerId);
        this.workers.delete(workerId);
        await this.releaseLease(workerId);
        return textError(`Failed to start Antigravity worker: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Legacy AGY cannot reveal a conversation ID until its one-shot start completes, so this
    // compatibility path remains blocking. The plugin MCP timeout is raised separately.
    const result = await runAgy(
      executable,
      buildOneShotArgs(input.prompt, executionOptions(worker)),
      worker.cwd,
      input.timeoutSeconds * 1000,
      { signal: input.signal },
    );
    const envelope = parseAgyEnvelope(result);
    if (!envelope?.conversation_id) {
      return textError(result.canceled
        ? 'Antigravity start was canceled before a conversation was created.'
        : result.stderr || 'Antigravity did not return a conversation ID.');
    }
    worker.conversationId = envelope.conversation_id;
    worker.lastUsage = envelope.usage;
    worker.lastActivityAt = new Date().toISOString();
    worker.state = result.timedOut || result.canceled ? 'recoverable' : 'ready';
    worker.recovered = worker.state === 'recoverable';
    this.workers.set(workerId, worker);
    const persistenceError = await this.persist(worker, {
      state: worker.state,
      idempotencyKey: worker.idempotencyKey,
      lastTurnKind: 'start',
      lastTurnKey: worker.idempotencyKey,
      lastTurnCompletedAt: new Date().toISOString(),
      lastTransport: 'oneshot',
      lastResultStatus: envelope.status,
      lastDurationSeconds: envelope.duration_seconds,
      lastNumTurns: envelope.num_turns,
      lastUsage: worker.lastUsage,
      lastTurnUsage: usageDelta(worker.lastUsage, undefined),
      lastTimedOut: result.timedOut,
      lastCanceled: result.canceled,
      lastError: envelope.status === 'SUCCESS' ? undefined : envelope.error,
    });
    const final = this.decoratePersistence(this.oneShotResult(worker, result, input.timeoutSeconds), persistenceError);
    this.completedResults.set(workerId, final);
    return final;
  }

  async followup(input: WorkerFollowupInput): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const worker = this.workers.get(input.workerId);
    if (!worker) return textError(`Unknown or closed Antigravity worker: ${input.workerId}.`, { workerId: input.workerId });
    if (this.activeTurns.has(worker.workerId)) {
      const active = this.activeTurns.get(worker.workerId)!;
      const retryKey = normalizeKey(input.idempotencyKey);
      if (retryKey && retryKey === active.key) return this.runningResult(worker, active.transport, true);
      return textError(`Antigravity worker ${worker.workerId} already has a turn in progress.`, { workerId: worker.workerId, state: 'running' });
    }

    const requestedKey = normalizeKey(input.idempotencyKey);
    if (requestedKey) {
      const record = await this.store.read(worker.workerId).catch(() => undefined);
      if (record?.lastTurnKey === requestedKey) {
        const previous = await this.result(worker.workerId);
        previous.structuredContent.reused = true;
        return previous;
      }
    }

    const executable = await findAgy();
    if (!executable) return textError('Antigravity CLI was not found. Run agy_check first.', { workerId: worker.workerId });
    if (input.signal?.aborted) return textError('Antigravity follow-up was canceled before launch.', { workerId: worker.workerId });

    let driver = this.drivers.get(worker.workerId);
    if (driver && !driver.isAlive) {
      this.drivers.delete(worker.workerId);
      driver = undefined;
    }
    const capabilities = driver ? undefined : await probeAgyCapabilities(executable);
    const useStream = Boolean(driver || capabilities?.streaming.persistentDriver);
    const leaseError = await this.acquireLease(worker.workerId, true);
    if (leaseError) return textError(`Antigravity worker ${worker.workerId} is busy elsewhere: ${leaseError}`, { workerId: worker.workerId });

    const previousUsage = worker.lastUsage;
    const active: ActiveTurn = {
      token: randomUUID(),
      kind: 'followup',
      key: requestedKey,
      startedAt: new Date().toISOString(),
      timeoutSeconds: input.timeoutSeconds,
      transport: useStream ? 'stream' : 'oneshot',
      previousUsage,
    };

    try {
      if (!driver && useStream) {
        driver = this.createDriver(worker, executable, true);
        this.drivers.set(worker.workerId, driver);
        const init = await driver.waitForInit(DRIVER_INIT_TIMEOUT_MS, input.signal);
        if (!init || input.signal?.aborted) {
          await driver.close().catch(() => undefined);
          this.drivers.delete(worker.workerId);
          await this.releaseLease(worker.workerId);
          return textError(input.signal?.aborted
            ? 'Antigravity follow-up was canceled before the stream handshake completed.'
            : `Antigravity resume stream did not initialize within ${DRIVER_INIT_TIMEOUT_MS / 1000} seconds.`,
          { workerId: worker.workerId, conversationId: worker.conversationId });
        }
        if (init.conversationId !== worker.conversationId) {
          await driver.close().catch(() => undefined);
          this.drivers.delete(worker.workerId);
          await this.releaseLease(worker.workerId);
          return textError(`Antigravity resumed the wrong conversation: expected ${worker.conversationId}, got ${init.conversationId}.`, {
            workerId: worker.workerId,
            conversationId: worker.conversationId,
          });
        }
      }

      worker.state = 'running';
      worker.lastActivityAt = new Date().toISOString();
      const prePersistError = await this.persist(worker, {
        state: 'running',
        activeTurnKind: active.kind,
        activeTurnKey: active.key,
        activeTurnStartedAt: active.startedAt,
        lastTransport: active.transport,
        lastDriverPid: driver?.pid,
        lastResultStatus: 'RUNNING',
        lastTimedOut: false,
        lastCanceled: false,
        lastError: undefined,
      });
      if (prePersistError) {
        if (driver && !driver.isBusy) await driver.close().catch(() => undefined);
        this.drivers.delete(worker.workerId);
        worker.state = 'recoverable';
        worker.recovered = true;
        await this.releaseLease(worker.workerId);
        return textError(`Failed to persist Antigravity follow-up before launch: ${prePersistError}`, {
          workerId: worker.workerId,
          conversationId: worker.conversationId,
        });
      }

      this.activeTurns.set(worker.workerId, active);
      this.completedResults.delete(worker.workerId);

      if (driver) {
        const streamDriver = driver;
        const turnPromise = streamDriver.send(input.prompt, input.timeoutSeconds * 1000);
        void turnPromise
          .then((turn) => this.finishStreamTurn(worker, streamDriver, turn, active))
          .catch((error) => this.finishTurnFailure(worker, active, error));
        return this.runningResult(worker, 'stream');
      }

      const controller = new AbortController();
      this.activeOneShots.set(worker.workerId, { controller });
      const promise = runAgy(
        executable,
        buildOneShotArgs(input.prompt, executionOptions(worker), worker.conversationId),
        worker.cwd,
        input.timeoutSeconds * 1000,
        { signal: controller.signal },
      );
      void promise
        .then((oneShotResult) => this.finishOneShotTurn(worker, oneShotResult, active))
        .catch((error) => this.finishTurnFailure(worker, active, error));
      return this.runningResult(worker, 'oneshot');
    } catch (error) {
      this.activeOneShots.delete(worker.workerId);
      this.activeTurns.delete(worker.workerId);
      const activeDriver = this.drivers.get(worker.workerId);
      if (activeDriver) {
        this.closing.add(worker.workerId);
        if (activeDriver.isBusy) await activeDriver.cancelCurrentTurn().catch(() => false);
        await activeDriver.close().catch(() => undefined);
        this.closing.delete(worker.workerId);
        this.drivers.delete(worker.workerId);
      }
      worker.state = 'recoverable';
      worker.recovered = true;
      worker.lastActivityAt = new Date().toISOString();
      await this.persist(worker, {
        state: 'recoverable',
        activeTurnKind: undefined,
        activeTurnKey: undefined,
        activeTurnStartedAt: undefined,
        lastResultStatus: 'ERROR',
        lastDriverPid: undefined,
        lastError: error instanceof Error ? error.message : String(error),
      });
      await this.releaseLease(worker.workerId);
      return textError(`Failed to resume Antigravity worker: ${error instanceof Error ? error.message : String(error)}`, {
        workerId: worker.workerId,
        conversationId: worker.conversationId,
        state: worker.state,
      });
    }
  }

  async result(workerId: string): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const active = this.activeTurns.get(workerId);
    const worker = this.workers.get(workerId);
    if (active && worker) return this.runningResult(worker, active.transport, false);

    const cached = this.completedResults.get(workerId);
    if (cached) {
      const cloned = cloneResult(cached);
      cloned.structuredContent.done = true;
      cloned.structuredContent.resultAvailable = true;
      return cloned;
    }

    const record = await this.store.read(workerId).catch(() => undefined);
    if (!record) return textError(`Unknown Antigravity worker: ${workerId}.`, { workerId });
    const activeLease = await this.store.readActiveLease(workerId);
    const runningElsewhere = record.state === 'running' && Boolean(activeLease);
    if (runningElsewhere) {
      return {
        content: [{ type: 'text', text: `${record.name ?? workerId} is still running under another MCP process.` }],
        structuredContent: {
          workerId: record.workerId,
          conversationId: record.conversationId,
          name: record.name,
          idempotencyKey: record.idempotencyKey,
          state: 'running',
          status: 'RUNNING',
          model: record.model,
          effort: record.effort,
          mode: record.mode,
          cwd: record.cwd,
          activeTurnKind: record.activeTurnKind,
          activeTurnKey: record.activeTurnKey,
          activeTurnStartedAt: record.activeTurnStartedAt,
          background: true,
          done: false,
          resultAvailable: false,
        },
      };
    }

    if (worker?.recovered) worker.state = 'recoverable';
    const state: WorkerLifecycleState = record.closedAt ? 'closed' : worker?.state ?? 'recoverable';
    const done = state !== 'running';
    return {
      content: [{ type: 'text', text: done
        ? `The last turn for ${record.name ?? workerId} finished with status ${record.lastResultStatus ?? 'unknown'}. The final response is not persisted; review the workspace and ledger metadata.`
        : `${record.name ?? workerId} is still running.` }],
      structuredContent: {
        workerId: record.workerId,
        conversationId: record.conversationId,
        name: record.name,
        idempotencyKey: record.idempotencyKey,
        state,
        status: record.lastResultStatus,
        model: record.model,
        effort: record.effort,
        mode: record.mode,
        cwd: record.cwd,
        lastTurnKind: record.lastTurnKind,
        lastTurnKey: record.lastTurnKey,
        lastTurnCompletedAt: record.lastTurnCompletedAt,
        sessionUsage: record.lastUsage,
        turnUsage: record.lastTurnUsage,
        lastTimedOut: record.lastTimedOut,
        lastCanceled: record.lastCanceled,
        lastError: record.lastError,
        background: true,
        done,
        resultAvailable: false,
      },
      isError: Boolean(done && record.lastResultStatus && record.lastResultStatus !== 'SUCCESS'),
    };
  }

  async cancel(workerId: string): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const worker = this.workers.get(workerId);
    if (!worker) return textError(`Unknown or closed Antigravity worker: ${workerId}.`, { workerId });
    const active = this.activeTurns.get(workerId);
    if (!active) {
      const activeLease = await this.store.readActiveLease(workerId);
      const record = await this.store.read(workerId).catch(() => undefined);
      if (record?.state === 'running' && activeLease) {
        return textError(`Worker ${workerId} is running under MCP process ${activeLease.processPid}; cancel it from the owning MCP process.`, {
          workerId,
          conversationId: worker.conversationId,
          state: 'running',
          leaseOwnerPid: activeLease.processPid,
        });
      }
      return {
        content: [{ type: 'text', text: `Worker ${workerId} has no turn in progress.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, canceled: false, state: worker.state },
      };
    }

    const driver = this.drivers.get(workerId);
    if (driver?.isBusy) {
      const canceled = await driver.cancelCurrentTurn();
      return {
        content: [{ type: 'text', text: canceled
          ? `Cancellation requested for ${workerId}. The conversation remains recoverable.`
          : `No active stream turn for ${workerId}.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, canceled, cancellationRequested: canceled, state: worker.state },
      };
    }

    const oneShot = this.activeOneShots.get(workerId);
    if (oneShot) {
      oneShot.controller.abort(new Error('Canceled by agy_cancel'));
      return {
        content: [{ type: 'text', text: `Cancellation requested for ${workerId}. The conversation remains recoverable.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, canceled: true, cancellationRequested: true, state: worker.state },
      };
    }

    return {
      content: [{ type: 'text', text: `Worker ${workerId} has no cancellable process, but its active turn metadata is still present.` }],
      structuredContent: { workerId, conversationId: worker.conversationId, canceled: false, state: worker.state },
    };
  }

  async close(workerId: string): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const worker = this.workers.get(workerId);
    if (!worker) {
      const record = await this.store.read(workerId).catch(() => undefined);
      if (record?.closedAt) {
        return {
          content: [{ type: 'text', text: `Antigravity worker is already closed: ${workerId}` }],
          structuredContent: { workerId, conversationId: record.conversationId, closed: true, state: 'closed' },
        };
      }
      return textError(`Unknown Antigravity worker: ${workerId}.`, { workerId });
    }
    if (this.activeTurns.has(workerId) || this.drivers.get(workerId)?.isBusy || this.activeOneShots.has(workerId)) {
      return textError(`Worker ${workerId} has a turn in progress. Cancel it before closing.`, { workerId, state: 'running' });
    }
    const leaseError = await this.acquireLease(workerId, false);
    if (leaseError) return textError(`Cannot close ${workerId}: ${leaseError}`, { workerId });

    this.closing.add(workerId);
    try {
      const driver = this.drivers.get(workerId);
      if (driver) await driver.close();
      this.drivers.delete(workerId);
      worker.state = 'closed';
      worker.lastActivityAt = new Date().toISOString();
      const closedAt = new Date().toISOString();
      const persistenceError = await this.persist(worker, {
        state: 'closed',
        closedAt,
        lastDriverPid: undefined,
        activeTurnKind: undefined,
        activeTurnKey: undefined,
        activeTurnStartedAt: undefined,
      });
      this.workers.delete(workerId);
      this.completedResults.delete(workerId);
      await this.releaseLease(workerId);
      return this.decoratePersistence({
        content: [{ type: 'text', text: `Closed ${workerId}. Antigravity conversation ${worker.conversationId} remains resumable through AGY history.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, name: worker.name, closed: true, state: 'closed' },
      }, persistenceError);
    } finally {
      this.closing.delete(workerId);
    }
  }

  async status(workerId?: string, includeClosed = false): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const { records, warnings } = await this.store.listWithWarnings();
    const recordMap = new Map(records.map((record) => [record.workerId, record]));

    const duplicateMap = new Map<string, string[]>();
    for (const record of records.filter((item) => !item.closedAt)) {
      const identity = record.idempotencyKey
        ? `key:${record.idempotencyKey}`
        : `name:${pathIdentity(record.cwd)}\u0000${record.name ?? ''}`;
      const group = duplicateMap.get(identity) ?? [];
      group.push(record.workerId);
      duplicateMap.set(identity, group);
    }

    const describe = async (record: WorkerLedgerRecord) => {
      const runtime = this.workers.get(record.workerId);
      const driver = this.drivers.get(record.workerId);
      const active = this.activeTurns.get(record.workerId);
      const lease = await this.store.readActiveLease(record.workerId);
      if (runtime?.recovered && !active && !driver?.isBusy && !(record.state === 'running' && lease)) {
        runtime.state = 'recoverable';
      }
      const state: WorkerLifecycleState = record.closedAt
        ? 'closed'
        : active || driver?.isBusy || (record.state === 'running' && Boolean(lease))
          ? 'running'
          : runtime?.state ?? 'recoverable';
      const identity = record.idempotencyKey
        ? `key:${record.idempotencyKey}`
        : `name:${pathIdentity(record.cwd)}\u0000${record.name ?? ''}`;
      const duplicates = (duplicateMap.get(identity) ?? []).filter((id) => id !== record.workerId);
      return {
        workerId: record.workerId,
        conversationId: record.conversationId,
        name: record.name,
        idempotencyKey: record.idempotencyKey,
        state,
        warm: Boolean(driver?.isAlive),
        driverPid: driver?.pid,
        leased: Boolean(lease),
        leaseOwnerPid: lease?.processPid,
        leaseExpiresAt: lease?.expiresAt,
        cwd: record.cwd,
        model: record.model,
        effort: record.effort,
        mode: record.mode,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastActivityAt: record.lastActivityAt,
        closedAt: record.closedAt,
        activeTurnKind: active?.kind ?? record.activeTurnKind,
        activeTurnKey: active?.key ?? record.activeTurnKey,
        activeTurnStartedAt: active?.startedAt ?? record.activeTurnStartedAt,
        lastTurnKind: record.lastTurnKind,
        lastTurnKey: record.lastTurnKey,
        lastTurnCompletedAt: record.lastTurnCompletedAt,
        lastResultStatus: state === 'running' ? 'RUNNING' : record.lastResultStatus,
        lastNumTurns: record.lastNumTurns,
        sessionUsage: record.lastUsage,
        turnUsage: record.lastTurnUsage,
        lastTransport: record.lastTransport,
        lastTimedOut: record.lastTimedOut,
        lastCanceled: record.lastCanceled,
        lastError: record.lastError,
        progress: driver ? this.progress.get(driver) : undefined,
        duplicateWorkerIds: duplicates,
        done: state !== 'running',
        resultAvailable: this.completedResults.has(record.workerId),
      };
    };

    if (workerId) {
      let record = recordMap.get(workerId);
      const runtime = this.workers.get(workerId);
      if (!record && runtime) {
        await this.persist(runtime);
        record = await this.store.read(workerId);
      }
      if (!record) return textError(`Unknown Antigravity worker: ${workerId}.`, { workerId });
      const detail = await describe(record);
      return {
        content: [{ type: 'text', text: `${detail.name ?? detail.workerId}: ${detail.state}${detail.warm ? ' (warm)' : ''}` }],
        structuredContent: { ...detail, recoveryWarnings: this.recoveryWarnings },
      };
    }

    const visible = records.filter((record) => includeClosed || !record.closedAt);
    const described = await Promise.all(visible.map(describe));
    return {
      content: [{ type: 'text', text: described.length > 0 ? `${described.length} Antigravity worker(s) found.` : 'No Antigravity workers found.' }],
      structuredContent: { workers: described, warnings: [...this.recoveryWarnings, ...warnings] },
    };
  }

  private async sweepIdleDrivers(): Promise<void> {
    const now = Date.now();
    for (const [workerId, driver] of this.drivers) {
      if (!driver.isAlive || driver.isBusy || this.activeTurns.has(workerId) || now - driver.lastActivityAt < this.idleDriverMs) continue;
      const worker = this.workers.get(workerId);
      this.closing.add(workerId);
      await driver.close().catch(() => undefined);
      this.closing.delete(workerId);
      this.drivers.delete(workerId);
      if (worker) {
        worker.state = 'recoverable';
        worker.recovered = true;
        worker.lastActivityAt = new Date().toISOString();
        await this.persist(worker, { state: 'recoverable', lastDriverPid: undefined });
      }
      await this.releaseLease(workerId);
    }
  }
}

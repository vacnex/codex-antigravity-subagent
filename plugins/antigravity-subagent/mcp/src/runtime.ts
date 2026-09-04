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
} from './store.js';
import type { AgyStreamEvent, AgyUsage } from './streaming.js';

export type WorkerState = {
  workerId: string;
  conversationId: string;
  name: string;
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
  timeoutSeconds: number;
  signal?: AbortSignal;
};

export type WorkerFollowupInput = {
  workerId: string;
  prompt: string;
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

const MAX_RESPONSE_BYTES = 64 * 1024;
const LEASE_TTL_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const DEFAULT_IDLE_DRIVER_MS = 10 * 60_000;

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

function normalizeName(name: string | undefined, workerId: string): string {
  const trimmed = name?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 120) : `Antigravity worker ${workerId.slice(-8)}`;
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

function combineWarnings(...values: Array<string | undefined>): string | undefined {
  const warnings = values.filter((value): value is string => Boolean(value));
  return warnings.length > 0 ? warnings.join(' | ') : undefined;
}

export class WorkerRuntime {
  readonly store: WorkerStore;
  readonly ownerId = `mcp_${randomUUID()}`;
  private readonly workers = new Map<string, WorkerState>();
  private readonly drivers = new Map<string, AgyPersistentDriver>();
  private readonly activeOneShots = new Map<string, ActiveOneShot>();
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
        if (worker && !this.workers.has(worker.workerId)) this.workers.set(worker.workerId, worker);
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
        if (driver && !driver.isBusy) await driver.close().catch(() => undefined);
        this.drivers.delete(workerId);
        const worker = this.workers.get(workerId);
        if (worker) {
          worker.state = 'recoverable';
          worker.recovered = true;
          worker.lastActivityAt = new Date().toISOString();
          await this.persist(worker, { state: 'recoverable', lastDriverPid: undefined });
        }
        this.stopLeaseHeartbeat(workerId);
      });
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
    if (this.closing.has(workerId)) return;
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
      },
      isError,
    };
  }

  async start(input: WorkerStartInput): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const executable = await findAgy();
    if (!executable) return textError('Antigravity CLI was not found. Run agy_check first.');

    const workerId = `agy_${randomUUID()}`;
    const now = new Date().toISOString();
    const worker: WorkerState = {
      workerId,
      conversationId: '',
      name: normalizeName(input.name, workerId),
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
      try {
        const turn = await driver.send(input.prompt, input.timeoutSeconds * 1000, input.signal);
        const conversationId = turn.result?.conversationId ?? driver.currentConversationId;
        if (!conversationId) {
          await driver.close().catch(() => undefined);
          await this.releaseLease(workerId);
          return textError(turn.canceled
            ? 'Antigravity start was canceled before a conversation was created.'
            : 'Antigravity stream did not return a conversation ID.');
        }
        worker.conversationId = conversationId;
        worker.lastUsage = turn.result?.usage;
        worker.lastActivityAt = new Date().toISOString();
        worker.state = turn.timedOut || turn.canceled || !driver.isAlive ? 'recoverable' : 'ready';
        worker.recovered = worker.state === 'recoverable';
        this.workers.set(workerId, worker);
        if (driver.isAlive) this.drivers.set(workerId, driver);
        else await this.releaseLease(workerId);
        const persistenceError = await this.persist(worker, {
          state: worker.state,
          lastTransport: 'stream',
          lastDriverPid: driver.isAlive ? driver.pid : undefined,
          lastResultStatus: turn.result?.status ?? (turn.canceled ? 'CANCELED' : 'ERROR'),
          lastDurationSeconds: turn.result?.durationSeconds,
          lastNumTurns: turn.result?.numTurns,
          lastUsage: worker.lastUsage,
          lastTurnUsage: usageDelta(worker.lastUsage, undefined),
          lastTimedOut: turn.timedOut,
          lastCanceled: turn.canceled,
        });
        return this.decoratePersistence(this.streamResult(worker, turn, driver, input.timeoutSeconds), persistenceError);
      } catch (error) {
        this.closing.add(workerId);
        await driver.close().catch(() => undefined);
        this.closing.delete(workerId);
        this.drivers.delete(workerId);
        await this.releaseLease(workerId);
        return textError(`Failed to start Antigravity worker: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

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
      lastTransport: 'oneshot',
      lastResultStatus: envelope.status,
      lastDurationSeconds: envelope.duration_seconds,
      lastNumTurns: envelope.num_turns,
      lastUsage: worker.lastUsage,
      lastTurnUsage: usageDelta(worker.lastUsage, undefined),
      lastTimedOut: result.timedOut,
      lastCanceled: result.canceled,
    });
    return this.decoratePersistence(this.oneShotResult(worker, result, input.timeoutSeconds), persistenceError);
  }

  async followup(input: WorkerFollowupInput): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const worker = this.workers.get(input.workerId);
    if (!worker) return textError(`Unknown or closed Antigravity worker: ${input.workerId}.`, { workerId: input.workerId });
    const executable = await findAgy();
    if (!executable) return textError('Antigravity CLI was not found. Run agy_check first.', { workerId: worker.workerId });

    let driver = this.drivers.get(worker.workerId);
    if (driver && !driver.isAlive) {
      this.drivers.delete(worker.workerId);
      driver = undefined;
    }
    const capabilities = driver ? undefined : await probeAgyCapabilities(executable);
    const useStream = Boolean(driver || capabilities?.streaming.persistentDriver);
    const leaseError = await this.acquireLease(worker.workerId, useStream);
    if (leaseError) return textError(`Antigravity worker ${worker.workerId} is busy elsewhere: ${leaseError}`, { workerId: worker.workerId });

    const previousUsage = worker.lastUsage;
    worker.state = 'running';
    worker.lastActivityAt = new Date().toISOString();
    const prePersistError = await this.persist(worker, { state: 'running' });

    try {
      if (!driver && useStream) {
        driver = this.createDriver(worker, executable, true);
        this.drivers.set(worker.workerId, driver);
      }

      if (driver) {
        const turn = await driver.send(input.prompt, input.timeoutSeconds * 1000, input.signal);
        if (turn.result?.conversationId) worker.conversationId = turn.result.conversationId;
        worker.lastUsage = turn.result?.usage ?? worker.lastUsage;
        worker.lastActivityAt = new Date().toISOString();
        worker.state = turn.timedOut || turn.canceled || !driver.isAlive ? 'recoverable' : 'ready';
        worker.recovered = worker.state === 'recoverable';
        if (!driver.isAlive) {
          this.drivers.delete(worker.workerId);
          await this.releaseLease(worker.workerId);
        }
        const persistenceError = await this.persist(worker, {
          state: worker.state,
          lastTransport: 'stream',
          lastDriverPid: driver.isAlive ? driver.pid : undefined,
          lastResultStatus: turn.result?.status ?? (turn.canceled ? 'CANCELED' : 'ERROR'),
          lastDurationSeconds: turn.result?.durationSeconds,
          lastNumTurns: turn.result?.numTurns,
          lastUsage: worker.lastUsage,
          lastTurnUsage: usageDelta(worker.lastUsage, previousUsage),
          lastTimedOut: turn.timedOut,
          lastCanceled: turn.canceled,
        });
        return this.decoratePersistence(
          this.streamResult(worker, turn, driver, input.timeoutSeconds, previousUsage),
          combineWarnings(prePersistError, persistenceError),
        );
      }

      const controller = new AbortController();
      const forwardAbort = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) controller.abort(input.signal.reason);
      else input.signal?.addEventListener('abort', forwardAbort, { once: true });
      this.activeOneShots.set(worker.workerId, { controller });
      let result: Awaited<ReturnType<typeof runAgy>>;
      try {
        result = await runAgy(
          executable,
          buildOneShotArgs(input.prompt, executionOptions(worker), worker.conversationId),
          worker.cwd,
          input.timeoutSeconds * 1000,
          { signal: controller.signal },
        );
      } finally {
        input.signal?.removeEventListener('abort', forwardAbort);
        this.activeOneShots.delete(worker.workerId);
      }
      const envelope = parseAgyEnvelope(result);
      if (envelope?.conversation_id) worker.conversationId = envelope.conversation_id;
      worker.lastUsage = envelope?.usage ?? worker.lastUsage;
      worker.lastActivityAt = new Date().toISOString();
      worker.state = result.timedOut || result.canceled ? 'recoverable' : 'ready';
      worker.recovered = false;
      const persistenceError = await this.persist(worker, {
        state: worker.state,
        lastTransport: 'oneshot',
        lastResultStatus: envelope?.status ?? (result.canceled ? 'CANCELED' : result.exitCode === 0 ? 'SUCCESS' : 'ERROR'),
        lastDurationSeconds: envelope?.duration_seconds,
        lastNumTurns: envelope?.num_turns,
        lastUsage: worker.lastUsage,
        lastTurnUsage: usageDelta(worker.lastUsage, previousUsage),
        lastTimedOut: result.timedOut,
        lastCanceled: result.canceled,
      });
      await this.releaseLease(worker.workerId);
      return this.decoratePersistence(
        this.oneShotResult(worker, result, input.timeoutSeconds, previousUsage),
        combineWarnings(prePersistError, persistenceError),
      );
    } catch (error) {
      this.activeOneShots.delete(worker.workerId);
      const activeDriver = this.drivers.get(worker.workerId);
      if (activeDriver) {
        this.closing.add(worker.workerId);
        await activeDriver.close().catch(() => undefined);
        this.closing.delete(worker.workerId);
        this.drivers.delete(worker.workerId);
      }
      worker.state = 'recoverable';
      worker.recovered = true;
      worker.lastActivityAt = new Date().toISOString();
      await this.persist(worker, { state: 'recoverable', lastResultStatus: 'ERROR', lastDriverPid: undefined });
      await this.releaseLease(worker.workerId);
      return textError(`Failed to resume Antigravity worker: ${error instanceof Error ? error.message : String(error)}`, {
        workerId: worker.workerId,
        conversationId: worker.conversationId,
        state: worker.state,
      });
    }
  }

  async cancel(workerId: string): Promise<RuntimeToolResult> {
    await this.ensureRecovered();
    const worker = this.workers.get(workerId);
    if (!worker) return textError(`Unknown or closed Antigravity worker: ${workerId}.`, { workerId });

    const driver = this.drivers.get(workerId);
    if (driver?.isBusy) {
      const canceled = await driver.cancelCurrentTurn();
      worker.state = 'recoverable';
      worker.recovered = true;
      worker.lastActivityAt = new Date().toISOString();
      const persistenceError = await this.persist(worker, {
        state: 'recoverable',
        lastResultStatus: 'CANCELED',
        lastCanceled: true,
        lastDriverPid: undefined,
      });
      await this.releaseLease(workerId);
      return this.decoratePersistence({
        content: [{ type: 'text', text: canceled
          ? `Canceled the active turn for ${workerId}. The conversation remains recoverable.`
          : `No active turn for ${workerId}.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, canceled, state: worker.state },
      }, persistenceError);
    }

    const oneShot = this.activeOneShots.get(workerId);
    if (oneShot) {
      oneShot.controller.abort(new Error('Canceled by agy_cancel'));
      worker.state = 'recoverable';
      worker.recovered = true;
      worker.lastActivityAt = new Date().toISOString();
      const persistenceError = await this.persist(worker, { state: 'recoverable', lastResultStatus: 'CANCELED', lastCanceled: true });
      return this.decoratePersistence({
        content: [{ type: 'text', text: `Cancellation requested for ${workerId}. The conversation remains recoverable.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, canceled: true, state: worker.state },
      }, persistenceError);
    }

    return {
      content: [{ type: 'text', text: `Worker ${workerId} has no turn in progress.` }],
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
    if (this.drivers.get(workerId)?.isBusy || this.activeOneShots.has(workerId)) {
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
      const persistenceError = await this.persist(worker, { state: 'closed', closedAt, lastDriverPid: undefined });
      this.workers.delete(workerId);
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

    const describe = async (record: WorkerLedgerRecord) => {
      const runtime = this.workers.get(record.workerId);
      const driver = this.drivers.get(record.workerId);
      const lease = await this.store.readLease(record.workerId);
      const state: WorkerLifecycleState = record.closedAt
        ? 'closed'
        : driver?.isBusy
          ? 'running'
          : runtime?.state ?? 'recoverable';
      return {
        workerId: record.workerId,
        conversationId: record.conversationId,
        name: record.name,
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
        lastResultStatus: record.lastResultStatus,
        lastNumTurns: record.lastNumTurns,
        sessionUsage: record.lastUsage,
        turnUsage: record.lastTurnUsage,
        lastTransport: record.lastTransport,
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
      if (!driver.isAlive || driver.isBusy || now - driver.lastActivityAt < this.idleDriverMs) continue;
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

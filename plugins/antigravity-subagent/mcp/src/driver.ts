import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { terminateChildProcess } from './cli.js';
import { canonicalProjectPath } from './projects.js';
import { isAgyResponseTimeoutText } from './result-semantics.js';
import {
  parseAgyStreamLine,
  type AgyStreamEvent,
  type AgyStreamInitEvent,
  type AgyStreamResultEvent,
} from './streaming.js';

export type AgyTimeoutKind = 'idle' | 'deadline';

export type AgyDriverTurnResult = {
  result?: AgyStreamResultEvent;
  timedOut: boolean;
  timeoutKind?: AgyTimeoutKind;
  canceled: boolean;
  stderr: string;
  diagnosticsTruncated: boolean;
  autoResumeCount?: number;
  logicalTurnCount?: number;
  logicalFailureKind?: 'logical_plan_stalled' | 'logical_plan_recovery_exhausted';
};

export type AgyPersistentDriverOptions = {
  command: string;
  args: string[];
  cwd: string;
  maxDiagnosticBytes?: number;
  inactivityTimeoutMs?: number;
  onEvent?: (event: AgyStreamEvent) => void;
  onExit?: (exitCode: number | null) => void;
};

type PendingTurn = {
  resolve: (result: AgyDriverTurnResult) => void;
  reject: (error: Error) => void;
  deadlineTimer: NodeJS.Timeout;
  inactivityTimer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const MAX_PLAN_AUTO_RESUMES = 4;
const MAX_LOGICAL_PLAN_WALL_MS = 30 * 60_000;
const MAX_STAGNANT_RESPONSE_TIMEOUTS = 2;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const DRIVER_RESTART_INIT_TIMEOUT_MS = 15_000;
const PLAN_PROMPT_PREFIX = /^AGY (?:EXECUTION|CORRECTION|PLAN RECOVERY) POLICY\b/;
const INTERNAL_PLAN_RESUME_PROMPT = `AGY INTERNAL PLAN CONTINUATION

Continue the same approved PLAN in this existing conversation after the provider stopped returning a response.
- Inspect and preserve the current workspace state; do not restart completed work.
- Continue only unfinished requirements from the already-approved PLAN.
- Do not broaden scope, redesign architecture, or perform repository-wide rediscovery.
- If the remaining work needs a material decision absent from the approved PLAN, stop and report BLOCKED.
- Run the approved canonical validation when implementation is complete, then report concisely.`;

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
): { buffer: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
}

function isAgyResponseTimeout(result: AgyDriverTurnResult): boolean {
  const event = result.result;
  if (result.timedOut || result.canceled || !event) return false;
  return isAgyResponseTimeoutText([event.response, event.error].filter(Boolean).join('\n'));
}

function withLogicalFailure(
  result: AgyDriverTurnResult,
  kind: 'logical_plan_stalled' | 'logical_plan_recovery_exhausted',
  autoResumeCount: number,
  logicalTurnCount: number,
  detail?: string,
  conversationId?: string,
): AgyDriverTurnResult {
  const base = kind === 'logical_plan_stalled'
    ? `LOGICAL_PLAN_STALLED: AGY returned repeated response timeouts without meaningful stream progress after ${logicalTurnCount} logical turns.`
    : `LOGICAL_PLAN_RECOVERY_EXHAUSTED: AGY response-timeout recovery stopped after ${autoResumeCount} automatic resumes / ${logicalTurnCount} logical turns.`;
  const message = detail ? `${base} ${detail}` : base;
  const event = result.result
    ? { ...result.result, error: message }
    : conversationId
      ? { event: 'result' as const, conversationId, status: 'ERROR', response: '', error: message }
      : undefined;
  return {
    ...result,
    result: event,
    autoResumeCount,
    logicalTurnCount,
    logicalFailureKind: kind,
  };
}

function resumeArgs(args: string[], conversationId: string): string[] {
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === '--new-project') continue;
    if (value === '--project' || value === '--conversation') {
      i += 1;
      continue;
    }
    cleaned.push(value);
  }
  cleaned.push('--conversation', conversationId);
  return cleaned;
}

export function buildAgyStreamUserMessage(prompt: string): string {
  return JSON.stringify({ event: 'user', message: { content: prompt } });
}

/** Owns one logical Antigravity conversation and serializes stream-json turns across process relaunches. */
export class AgyPersistentDriver {
  private child!: ChildProcessWithoutNullStreams;
  private readonly command: string;
  private readonly initialArgs: string[];
  private readonly maxDiagnosticBytes: number;
  private readonly inactivityTimeoutMs: number;
  private readonly onEvent?: (event: AgyStreamEvent) => void;
  private readonly onExit?: (exitCode: number | null) => void;
  private readonly expectedCwd: string;
  private readonly parentExitHandler: () => void;
  private initPromise!: Promise<AgyStreamInitEvent | undefined>;
  private resolveInit!: (event: AgyStreamInitEvent | undefined) => void;
  private initSettled = false;
  private initError?: Error;
  private stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private diagnosticsTruncated = false;
  private pending?: PendingTurn;
  private initEvent?: AgyStreamInitEvent;
  private conversationId?: string;
  private closed = false;
  private exitCode: number | null | undefined;
  private lastActivity = Date.now();
  private progressSequence = 0;
  private readonly suppressedExitNotifications = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(options: AgyPersistentDriverOptions) {
    this.command = options.command;
    this.initialArgs = [...options.args];
    this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? 8 * 1024;
    this.inactivityTimeoutMs = Number.isFinite(options.inactivityTimeoutMs) && (options.inactivityTimeoutMs ?? 0) > 0
      ? options.inactivityTimeoutMs!
      : DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    this.onExit = options.onExit;
    this.expectedCwd = options.cwd;
    this.parentExitHandler = () => {
      try { this.child?.kill(); } catch { /* parent is already exiting */ }
    };
    process.once('exit', this.parentExitHandler);
    this.resetInitState();
    this.spawnChild(this.initialArgs);
  }

  get pid(): number | undefined { return this.child?.pid; }
  get isAlive(): boolean { return Boolean(this.child) && !this.closed && this.exitCode === undefined; }
  get isBusy(): boolean { return Boolean(this.pending); }
  get currentConversationId(): string | undefined { return this.conversationId; }
  get init(): AgyStreamInitEvent | undefined { return this.initEvent; }
  get lastActivityAt(): number { return this.lastActivity; }

  private resetInitState(): void {
    this.initSettled = false;
    this.initError = undefined;
    this.initEvent = undefined;
    this.initPromise = new Promise<AgyStreamInitEvent | undefined>((resolve) => {
      this.resolveInit = resolve;
    });
  }

  private spawnChild(args: string[]): void {
    this.closed = false;
    this.exitCode = undefined;
    this.stderrTail = Buffer.alloc(0);
    this.diagnosticsTruncated = false;
    const child = spawn(this.command, args, {
      cwd: this.expectedCwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stderr as unknown as { unref?: () => void }).unref?.();

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(child, line));
    child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      if (this.child !== child) return;
      const appended = appendTail(this.stderrTail, chunk, this.maxDiagnosticBytes);
      this.stderrTail = appended.buffer;
      this.diagnosticsTruncated ||= appended.truncated;
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.closed = true;
      this.exitCode = null;
      this.settleInit(undefined);
      this.failPending(new Error(`Antigravity stream process error: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      const current = this.child === child;
      if (current) {
        this.closed = true;
        this.exitCode = exitCode;
        this.settleInit(undefined);
        if (this.pending) {
          this.failPending(new Error(
            `Antigravity stream process exited before returning a result (exit ${exitCode ?? 'unknown'}). ${this.stderrText()}`.trim(),
          ));
        }
      }
      if (!this.suppressedExitNotifications.has(child)) {
        process.removeListener('exit', this.parentExitHandler);
        this.onExit?.(exitCode);
      }
    });
  }

  async waitForInit(timeoutMs = 15_000, signal?: AbortSignal): Promise<AgyStreamInitEvent | undefined> {
    if (this.initEvent) return this.initEvent;
    if (this.initError) throw this.initError;
    if (!this.isAlive) return undefined;
    if (signal?.aborted) return undefined;

    let timeout: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const abortPromise = signal
      ? new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined);
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : new Promise<undefined>(() => undefined);

    try {
      const result = await Promise.race([this.initPromise, timeoutPromise, abortPromise]);
      if (!result && this.initError) throw this.initError;
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async send(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgyDriverTurnResult> {
    if (!PLAN_PROMPT_PREFIX.test(prompt.trimStart())) return this.sendOnce(prompt, timeoutMs, signal);

    const logicalStartedAt = Date.now();
    let currentPrompt = prompt;
    let autoResumeCount = 0;
    let logicalTurnCount = 0;
    let stagnantTimeouts = 0;
    let progressWatermark = this.progressSequence;

    while (true) {
      let result: AgyDriverTurnResult;
      try {
        result = await this.sendOnce(currentPrompt, timeoutMs, signal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const fallback: AgyDriverTurnResult = {
          timedOut: false,
          canceled: Boolean(signal?.aborted),
          stderr: this.stderrText(),
          diagnosticsTruncated: this.diagnosticsTruncated,
        };
        return withLogicalFailure(fallback, 'logical_plan_recovery_exhausted', autoResumeCount, logicalTurnCount, detail, this.conversationId);
      }
      logicalTurnCount += 1;
      if (!isAgyResponseTimeout(result)) {
        return { ...result, autoResumeCount, logicalTurnCount };
      }

      const progressed = this.progressSequence > progressWatermark;
      progressWatermark = this.progressSequence;
      stagnantTimeouts = progressed ? 0 : stagnantTimeouts + 1;

      if (stagnantTimeouts >= MAX_STAGNANT_RESPONSE_TIMEOUTS) {
        return withLogicalFailure(result, 'logical_plan_stalled', autoResumeCount, logicalTurnCount, undefined, this.conversationId);
      }
      if (autoResumeCount >= MAX_PLAN_AUTO_RESUMES || Date.now() - logicalStartedAt >= MAX_LOGICAL_PLAN_WALL_MS) {
        return withLogicalFailure(result, 'logical_plan_recovery_exhausted', autoResumeCount, logicalTurnCount, undefined, this.conversationId);
      }
      if (signal?.aborted) return { ...result, canceled: true, autoResumeCount, logicalTurnCount };

      autoResumeCount += 1;
      try {
        await this.restartForConversation(signal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return withLogicalFailure(result, 'logical_plan_recovery_exhausted', autoResumeCount, logicalTurnCount, detail, this.conversationId);
      }
      currentPrompt = INTERNAL_PLAN_RESUME_PROMPT;
      progressWatermark = this.progressSequence;
    }
  }

  private async restartForConversation(signal?: AbortSignal): Promise<void> {
    const conversationId = this.conversationId;
    if (!conversationId) throw new Error('Cannot auto-resume PLAN because Antigravity did not provide a conversation id.');
    const previous = this.child;
    this.suppressedExitNotifications.add(previous);
    if (previous && !this.closed) await terminateChildProcess(previous).catch(() => undefined);
    this.pending = undefined;
    this.resetInitState();
    const args = resumeArgs(this.initialArgs, conversationId);
    this.spawnChild(args);
    const init = await this.waitForInit(DRIVER_RESTART_INIT_TIMEOUT_MS, signal);
    if (!init) {
      const child = this.child;
      this.suppressedExitNotifications.add(child);
      await terminateChildProcess(child).catch(() => undefined);
      throw new Error(`Antigravity conversation ${conversationId} did not reinitialize within ${DRIVER_RESTART_INIT_TIMEOUT_MS}ms.`);
    }
    if (init.conversationId !== conversationId) {
      throw new Error(`Antigravity resumed unexpected conversation ${init.conversationId}; expected ${conversationId}.`);
    }
  }

  private async sendOnce(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgyDriverTurnResult> {
    if (!this.isAlive) throw new Error('Antigravity stream driver is not running.');
    if (this.pending) throw new Error('Antigravity stream driver already has a turn in progress.');
    if (signal?.aborted) {
      return { timedOut: false, canceled: true, stderr: this.stderrText(), diagnosticsTruncated: this.diagnosticsTruncated };
    }

    this.lastActivity = Date.now();
    return await new Promise<AgyDriverTurnResult>((resolve, reject) => {
      const pending: PendingTurn = {
        resolve,
        reject,
        deadlineTimer: setTimeout(() => { this.timeoutCurrentTurn('deadline'); }, timeoutMs),
        inactivityTimer: setTimeout(() => { this.timeoutCurrentTurn('idle'); }, Math.min(this.inactivityTimeoutMs, timeoutMs)),
        signal,
        onAbort: undefined,
      };

      const onAbort = () => { void this.cancelCurrentTurn(); };
      pending.onAbort = onAbort;
      this.pending = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
      const line = `${buildAgyStreamUserMessage(prompt)}\n`;
      this.child.stdin.write(line, 'utf8', (error) => {
        if (!error) return;
        this.failPending(new Error(`Failed to write Antigravity stream input: ${error.message}`));
        void terminateChildProcess(this.child);
      });
    });
  }

  async cancelCurrentTurn(): Promise<boolean> {
    const pending = this.detachPending();
    if (!pending) return false;
    this.lastActivity = Date.now();
    pending.resolve({
      timedOut: false,
      canceled: true,
      stderr: this.stderrText(),
      diagnosticsTruncated: this.diagnosticsTruncated,
    });
    await terminateChildProcess(this.child);
    return true;
  }

  async close(graceMs = 2_000): Promise<void> {
    if (this.closed) {
      process.removeListener('exit', this.parentExitHandler);
      return;
    }
    if (this.pending) throw new Error('Cannot close Antigravity stream driver while a turn is running. Cancel it first.');
    const child = this.child;
    const closePromise = once(child, 'close').then(() => undefined);
    child.stdin.end();
    const graceful = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!graceful && !this.closed) {
      await terminateChildProcess(child, 500);
      await Promise.race([closePromise, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
    process.removeListener('exit', this.parentExitHandler);
  }

  private handleLine(source: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== source) return;
    const event = parseAgyStreamLine(line);
    if (!event) return;
    this.lastActivity = Date.now();
    this.resetInactivityTimer();
    if (event.event === 'init') {
      if (!event.cwd) {
        this.initError = new Error(`Antigravity stream init did not report cwd; expected ${this.expectedCwd}.`);
        this.settleInit(undefined);
        void terminateChildProcess(source);
        return;
      }
      const expected = canonicalProjectPath(this.expectedCwd);
      const actual = canonicalProjectPath(event.cwd);
      if (expected !== actual) {
        this.initError = new Error(`Antigravity workspace mismatch: expected ${this.expectedCwd}, got ${event.cwd}.`);
        this.settleInit(undefined);
        void terminateChildProcess(source);
        return;
      }
      this.acceptConversationId(event.conversationId);
      this.initEvent = event;
      this.onEvent?.(event);
      this.settleInit(event);
      return;
    }
    if (event.event === 'step_update') this.progressSequence += 1;
    this.onEvent?.(event);
    if (event.event !== 'result') return;
    this.acceptConversationId(event.conversationId);
    const pending = this.detachPending();
    if (!pending) return;
    pending.resolve({
      result: event,
      timedOut: false,
      canceled: false,
      stderr: this.stderrText(),
      diagnosticsTruncated: this.diagnosticsTruncated,
    });
  }

  private acceptConversationId(next: string): void {
    if (this.conversationId && this.conversationId !== next) {
      this.failPending(new Error(`Antigravity stream conversation changed unexpectedly from ${this.conversationId} to ${next}.`));
      return;
    }
    this.conversationId = next;
  }

  private settleInit(event: AgyStreamInitEvent | undefined): void {
    if (this.initSettled) return;
    this.initSettled = true;
    this.resolveInit(event);
  }

  private stderrText(): string { return this.stderrTail.toString('utf8').trim(); }

  private detachPending(): PendingTurn | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    clearTimeout(pending.deadlineTimer);
    clearTimeout(pending.inactivityTimer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    return pending;
  }

  private failPending(error: Error): void {
    const pending = this.detachPending();
    if (pending) pending.reject(error);
  }

  private resetInactivityTimer(): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.inactivityTimer);
    pending.inactivityTimer = setTimeout(() => { this.timeoutCurrentTurn('idle'); }, this.inactivityTimeoutMs);
  }

  private timeoutCurrentTurn(timeoutKind: AgyTimeoutKind): void {
    const pending = this.detachPending();
    if (!pending) return;
    pending.resolve({
      timedOut: true,
      timeoutKind,
      canceled: false,
      stderr: this.stderrText(),
      diagnosticsTruncated: this.diagnosticsTruncated,
    });
    void terminateChildProcess(this.child);
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { terminateChildProcess } from './cli.js';
import { canonicalProjectPath } from './projects.js';
import {
  parseAgyStreamLine,
  type AgyStreamEvent,
  type AgyStreamInitEvent,
  type AgyStreamResultEvent,
} from './streaming.js';

export type AgyDriverTurnResult = {
  result?: AgyStreamResultEvent;
  timedOut: boolean;
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
  onEvent?: (event: AgyStreamEvent) => void;
  onExit?: (exitCode: number | null) => void;
};

type PendingTurn = {
  resolve: (result: AgyDriverTurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const MAX_PLAN_AUTO_RESUMES = 4;
const MAX_LOGICAL_PLAN_WALL_MS = 30 * 60_000;
const MAX_STAGNANT_RESPONSE_TIMEOUTS = 2;
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
  if (result.timedOut || result.canceled || !event || event.status === 'SUCCESS') return false;
  return /timeout waiting for response/i.test([event.response, event.error].filter(Boolean).join('\n'));
}

function withLogicalFailure(
  result: AgyDriverTurnResult,
  kind: 'logical_plan_stalled' | 'logical_plan_recovery_exhausted',
  autoResumeCount: number,
  logicalTurnCount: number,
): AgyDriverTurnResult {
  const message = kind === 'logical_plan_stalled'
    ? `LOGICAL_PLAN_STALLED: AGY returned repeated response timeouts without meaningful stream progress after ${logicalTurnCount} logical turns.`
    : `LOGICAL_PLAN_RECOVERY_EXHAUSTED: AGY response-timeout recovery stopped after ${autoResumeCount} automatic resumes / ${logicalTurnCount} logical turns.`;
  return {
    ...result,
    result: result.result ? { ...result.result, error: message } : result.result,
    autoResumeCount,
    logicalTurnCount,
    logicalFailureKind: kind,
  };
}

export function buildAgyStreamUserMessage(prompt: string): string {
  return JSON.stringify({ event: 'user', message: { content: prompt } });
}

/** Owns one warm Antigravity stream-json process and serializes turns over stdin. */
export class AgyPersistentDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxDiagnosticBytes: number;
  private readonly onEvent?: (event: AgyStreamEvent) => void;
  private readonly onExit?: (exitCode: number | null) => void;
  private readonly expectedCwd: string;
  private readonly parentExitHandler: () => void;
  private readonly initPromise: Promise<AgyStreamInitEvent | undefined>;
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

  constructor(options: AgyPersistentDriverOptions) {
    this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? 8 * 1024;
    this.onEvent = options.onEvent;
    this.onExit = options.onExit;
    this.expectedCwd = options.cwd;
    this.initPromise = new Promise<AgyStreamInitEvent | undefined>((resolve) => {
      this.resolveInit = resolve;
    });
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.unref();
    (this.child.stdin as unknown as { unref?: () => void }).unref?.();
    (this.child.stdout as unknown as { unref?: () => void }).unref?.();
    (this.child.stderr as unknown as { unref?: () => void }).unref?.();
    this.parentExitHandler = () => {
      try { this.child.kill(); } catch { /* parent is already exiting */ }
    };
    process.once('exit', this.parentExitHandler);

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const appended = appendTail(this.stderrTail, chunk, this.maxDiagnosticBytes);
      this.stderrTail = appended.buffer;
      this.diagnosticsTruncated ||= appended.truncated;
    });
    this.child.on('error', (error) => {
      this.closed = true;
      this.exitCode = null;
      this.settleInit(undefined);
      this.failPending(new Error(`Antigravity stream process error: ${error.message}`));
    });
    this.child.on('close', (exitCode) => {
      process.removeListener('exit', this.parentExitHandler);
      this.closed = true;
      this.exitCode = exitCode;
      this.settleInit(undefined);
      if (this.pending) {
        this.failPending(new Error(
          `Antigravity stream process exited before returning a result (exit ${exitCode ?? 'unknown'}). ${this.stderrText()}`.trim(),
        ));
      }
      this.onExit?.(exitCode);
    });
  }

  get pid(): number | undefined { return this.child.pid; }
  get isAlive(): boolean { return !this.closed && this.exitCode === undefined; }
  get isBusy(): boolean { return Boolean(this.pending); }
  get currentConversationId(): string | undefined { return this.conversationId; }
  get init(): AgyStreamInitEvent | undefined { return this.initEvent; }
  get lastActivityAt(): number { return this.lastActivity; }

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
      const result = await this.sendOnce(currentPrompt, timeoutMs, signal);
      logicalTurnCount += 1;
      if (!isAgyResponseTimeout(result)) {
        return { ...result, autoResumeCount, logicalTurnCount };
      }

      const progressed = this.progressSequence > progressWatermark;
      progressWatermark = this.progressSequence;
      stagnantTimeouts = progressed ? 0 : stagnantTimeouts + 1;

      if (stagnantTimeouts >= MAX_STAGNANT_RESPONSE_TIMEOUTS) {
        return withLogicalFailure(result, 'logical_plan_stalled', autoResumeCount, logicalTurnCount);
      }
      if (autoResumeCount >= MAX_PLAN_AUTO_RESUMES || Date.now() - logicalStartedAt >= MAX_LOGICAL_PLAN_WALL_MS) {
        return withLogicalFailure(result, 'logical_plan_recovery_exhausted', autoResumeCount, logicalTurnCount);
      }
      if (signal?.aborted) return { ...result, canceled: true, autoResumeCount, logicalTurnCount };
      if (!this.isAlive) {
        return withLogicalFailure(result, 'logical_plan_recovery_exhausted', autoResumeCount, logicalTurnCount);
      }

      autoResumeCount += 1;
      currentPrompt = INTERNAL_PLAN_RESUME_PROMPT;
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
      const timer = setTimeout(() => {
        const pending = this.detachPending();
        if (!pending) return;
        pending.resolve({
          timedOut: true,
          canceled: false,
          stderr: this.stderrText(),
          diagnosticsTruncated: this.diagnosticsTruncated,
        });
        void terminateChildProcess(this.child);
      }, timeoutMs);

      const onAbort = () => { void this.cancelCurrentTurn(); };
      this.pending = { resolve, reject, timer, signal, onAbort };
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
    if (this.closed) return;
    if (this.pending) throw new Error('Cannot close Antigravity stream driver while a turn is running. Cancel it first.');
    const closePromise = once(this.child, 'close').then(() => undefined);
    this.child.stdin.end();
    const graceful = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (graceful || this.closed) return;
    await terminateChildProcess(this.child, 500);
    await Promise.race([closePromise, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }

  private handleLine(line: string): void {
    const event = parseAgyStreamLine(line);
    if (!event) return;
    this.lastActivity = Date.now();
    if (event.event === 'init') {
      if (!event.cwd) {
        this.initError = new Error(`Antigravity stream init did not report cwd; expected ${this.expectedCwd}.`);
        this.settleInit(undefined);
        void terminateChildProcess(this.child);
        return;
      }
      const expected = canonicalProjectPath(this.expectedCwd);
      const actual = canonicalProjectPath(event.cwd);
      if (expected !== actual) {
        this.initError = new Error(`Antigravity workspace mismatch: expected ${this.expectedCwd}, got ${event.cwd}.`);
        this.settleInit(undefined);
        void terminateChildProcess(this.child);
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
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    return pending;
  }

  private failPending(error: Error): void {
    const pending = this.detachPending();
    if (pending) pending.reject(error);
  }
}

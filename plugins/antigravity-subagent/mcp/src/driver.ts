import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { terminateChildProcess } from './cli.js';
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

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
): { buffer: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
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
  private readonly parentExitHandler: () => void;
  private stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private diagnosticsTruncated = false;
  private pending?: PendingTurn;
  private initEvent?: AgyStreamInitEvent;
  private conversationId?: string;
  private closed = false;
  private exitCode: number | null | undefined;
  private lastActivity = Date.now();

  constructor(options: AgyPersistentDriverOptions) {
    this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? 8 * 1024;
    this.onEvent = options.onEvent;
    this.onExit = options.onExit;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A warm worker must not keep an MCP stdio server alive after its parent connection closes.
    // The parent exit hook still terminates the child so it does not become an orphan process.
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
      this.failPending(new Error(`Antigravity stream process error: ${error.message}`));
    });
    this.child.on('close', (exitCode) => {
      process.removeListener('exit', this.parentExitHandler);
      this.closed = true;
      this.exitCode = exitCode;
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

  async send(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgyDriverTurnResult> {
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
    this.onEvent?.(event);
    if (event.event === 'init') {
      this.acceptConversationId(event.conversationId);
      this.initEvent = event;
      return;
    }
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

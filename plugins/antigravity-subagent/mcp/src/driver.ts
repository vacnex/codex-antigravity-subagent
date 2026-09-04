import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import {
  parseAgyStreamLine,
  type AgyStreamEvent,
  type AgyStreamInitEvent,
  type AgyStreamResultEvent,
} from './streaming.js';

export type AgyDriverTurnResult = {
  result?: AgyStreamResultEvent;
  timedOut: boolean;
  stderr: string;
  diagnosticsTruncated: boolean;
};

export type AgyPersistentDriverOptions = {
  command: string;
  args: string[];
  cwd: string;
  maxDiagnosticBytes?: number;
  onEvent?: (event: AgyStreamEvent) => void;
};

type PendingTurn = {
  resolve: (result: AgyDriverTurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
): { buffer: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return {
    buffer: combined.subarray(combined.length - maxBytes),
    truncated: true,
  };
}

export function buildAgyStreamUserMessage(prompt: string): string {
  return JSON.stringify({
    event: 'user',
    message: { content: prompt },
  });
}

export class AgyPersistentDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxDiagnosticBytes: number;
  private readonly onEvent?: (event: AgyStreamEvent) => void;
  private stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private diagnosticsTruncated = false;
  private pending?: PendingTurn;
  private initEvent?: AgyStreamInitEvent;
  private conversationId?: string;
  private closed = false;
  private exitCode: number | null | undefined;

  constructor(options: AgyPersistentDriverOptions) {
    this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? 8 * 1024;
    this.onEvent = options.onEvent;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
      this.closed = true;
      this.exitCode = exitCode;
      if (this.pending) {
        this.failPending(new Error(
          `Antigravity stream process exited before returning a result (exit ${exitCode ?? 'unknown'}). ${this.stderrText()}`.trim(),
        ));
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isAlive(): boolean {
    return !this.closed && this.exitCode === undefined;
  }

  get currentConversationId(): string | undefined {
    return this.conversationId;
  }

  get init(): AgyStreamInitEvent | undefined {
    return this.initEvent;
  }

  async send(prompt: string, timeoutMs: number): Promise<AgyDriverTurnResult> {
    if (!this.isAlive) throw new Error('Antigravity stream driver is not running.');
    if (this.pending) throw new Error('Antigravity stream driver already has a turn in progress.');

    return await new Promise<AgyDriverTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending) return;
        this.pending = undefined;
        resolve({
          timedOut: true,
          stderr: this.stderrText(),
          diagnosticsTruncated: this.diagnosticsTruncated,
        });
        this.child.kill();
      }, timeoutMs);

      this.pending = { resolve, reject, timer };
      const line = `${buildAgyStreamUserMessage(prompt)}\n`;
      this.child.stdin.write(line, 'utf8', (error) => {
        if (error) {
          this.failPending(new Error(`Failed to write Antigravity stream input: ${error.message}`));
          this.child.kill();
        }
      });
    });
  }

  async close(graceMs = 2_000): Promise<void> {
    if (this.closed) return;
    if (this.pending) throw new Error('Cannot close Antigravity stream driver while a turn is running.');

    const closePromise = once(this.child, 'close').then(() => undefined);
    this.child.stdin.end();
    const graceful = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (graceful || this.closed) return;

    this.child.kill();
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  private handleLine(line: string): void {
    const event = parseAgyStreamLine(line);
    if (!event) return;

    this.onEvent?.(event);
    if (event.event === 'init') {
      this.acceptConversationId(event.conversationId);
      this.initEvent = event;
      return;
    }

    if (event.event !== 'result') return;
    this.acceptConversationId(event.conversationId);
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve({
      result: event,
      timedOut: false,
      stderr: this.stderrText(),
      diagnosticsTruncated: this.diagnosticsTruncated,
    });
  }

  private acceptConversationId(next: string): void {
    if (this.conversationId && this.conversationId !== next) {
      this.failPending(new Error(
        `Antigravity stream conversation changed unexpectedly from ${this.conversationId} to ${next}.`,
      ));
      return;
    }
    this.conversationId = next;
  }

  private stderrText(): string {
    return this.stderrTail.toString('utf8').trim();
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

export type ManagedToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export type ManagedFailureKind =
  | 'none'
  | 'agy_response_timeout'
  | 'logical_plan_stalled'
  | 'logical_plan_recovery_exhausted'
  | 'agy_error'
  | 'transport_timeout'
  | 'process_exit'
  | 'canceled'
  | 'protocol_error'
  | 'unknown';

function text(result: ManagedToolResult): string {
  return result.content.map((entry) => entry.text).join('\n').trim();
}

/**
 * Antigravity can report a response timeout either as an ERROR envelope or as
 * a SUCCESS envelope containing the partial-output print-timeout marker. Keep
 * these markers exact so an unrelated timeout in a worker report is not
 * mistaken for a recoverable provider timeout.
 */
export function isAgyResponseTimeoutText(value: string): boolean {
  return /timeout waiting for response/i.test(value)
    || /print timeout after[\s\S]*?with turn in progress/i.test(value);
}

function logicalFailure(value: string): ManagedFailureKind | undefined {
  if (/LOGICAL_PLAN_STALLED/i.test(value)) return 'logical_plan_stalled';
  if (/LOGICAL_PLAN_RECOVERY_EXHAUSTED/i.test(value)) return 'logical_plan_recovery_exhausted';
  return undefined;
}

function terminalStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value && value !== 'RUNNING' ? value : undefined;
}

/**
 * Adds transport-vs-AGY semantics to a managed result without changing the worker lifecycle.
 * A valid terminal AGY envelope with status=ERROR is still a successful MCP transport result.
 * Codex must audit the workspace before deciding whether a correction is needed.
 */
export function normalizeManagedResult<T extends ManagedToolResult>(result: T): T {
  const data = result.structuredContent;
  const done = data.done === true;
  const running = data.done === false || data.state === 'running';
  if (running) {
    data.transportStatus = 'running';
    data.failureKind = 'none';
    data.retryable = false;
    return result;
  }
  if (!done) return result;

  const timedOut = data.timedOut === true || data.lastTimedOut === true;
  const canceled = data.canceled === true || data.lastCanceled === true;
  if (timedOut) {
    data.transportStatus = 'timeout';
    data.failureKind = 'transport_timeout';
    data.retryable = true;
    data.reportAvailable = false;
    result.isError = true;
    return result;
  }
  if (canceled) {
    data.transportStatus = 'canceled';
    data.failureKind = 'canceled';
    data.retryable = true;
    data.reportAvailable = false;
    result.isError = true;
    return result;
  }

  const status = terminalStatus(data.status);
  const transport = typeof data.transport === 'string' ? data.transport : undefined;
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : undefined;
  const terminalEnvelope = transport === 'stream' || (transport === 'oneshot' && exitCode === 0);
  const message = [text(result), typeof data.lastError === 'string' ? data.lastError : ''].filter(Boolean).join('\n');
  const responseTimeout = isAgyResponseTimeoutText(message);

  if (terminalEnvelope && status) {
    data.transportStatus = 'ok';
    data.agyStatus = status;
    data.terminalEnvelopeReceived = true;
    const logical = logicalFailure(message);
    if (responseTimeout) {
      data.failureKind = 'agy_response_timeout';
      data.retryable = true;
      data.reportAvailable = false;
    } else if (logical) {
      data.failureKind = logical;
      data.retryable = true;
      data.reportAvailable = true;
    } else if (status === 'SUCCESS') {
      data.failureKind = 'none';
      data.retryable = false;
      data.reportAvailable = Boolean(text(result));
    } else {
      data.failureKind = 'agy_error';
      data.retryable = true;
      data.reportAvailable = Boolean(logical) || Boolean(text(result));
    }
    // The MCP call successfully received a terminal AGY envelope. Whether the implementation
    // passed is a separate workspace-audit decision, not an MCP transport error.
    result.isError = false;
    return result;
  }

  if (transport === 'oneshot' && exitCode !== undefined && exitCode !== 0) {
    data.transportStatus = 'crashed';
    data.failureKind = 'process_exit';
    data.retryable = true;
    data.reportAvailable = false;
    result.isError = true;
    return result;
  }

  if (status) {
    const logical = logicalFailure(message);
    data.transportStatus = 'unknown';
    data.agyStatus = status;
    data.failureKind = responseTimeout
      ? 'agy_response_timeout'
      : status === 'SUCCESS'
        ? 'none'
        : logical ?? 'agy_error';
    data.retryable = responseTimeout || status !== 'SUCCESS';
    data.reportAvailable = responseTimeout ? false : Boolean(logical);
    return result;
  }

  if (result.isError) {
    data.transportStatus = 'protocol_error';
    data.failureKind = 'protocol_error';
    data.retryable = true;
    data.reportAvailable = false;
  } else {
    data.transportStatus = 'unknown';
    data.failureKind = 'unknown';
  }
  return result;
}

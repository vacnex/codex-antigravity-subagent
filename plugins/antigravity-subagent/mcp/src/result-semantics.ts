export type ManagedToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export type ManagedFailureKind =
  | 'none'
  | 'agy_response_timeout'
  | 'agy_error'
  | 'transport_timeout'
  | 'process_exit'
  | 'canceled'
  | 'protocol_error'
  | 'unknown';

function text(result: ManagedToolResult): string {
  return result.content.map((entry) => entry.text).join('\n').trim();
}

function responseTimeout(value: string): boolean {
  return /timeout waiting for response/i.test(value);
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

  if (terminalEnvelope && status) {
    data.transportStatus = 'ok';
    data.agyStatus = status;
    data.terminalEnvelopeReceived = true;
    if (status === 'SUCCESS') {
      data.failureKind = 'none';
      data.retryable = false;
      data.reportAvailable = Boolean(text(result));
    } else {
      const timeout = responseTimeout(message);
      data.failureKind = timeout ? 'agy_response_timeout' : 'agy_error';
      data.retryable = true;
      data.reportAvailable = !timeout && Boolean(text(result));
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
    // Persisted results after MCP restart do not retain enough transport detail to prove that a
    // terminal envelope was received. Preserve the existing error bit but expose the AGY status.
    data.transportStatus = 'unknown';
    data.agyStatus = status;
    data.failureKind = status === 'SUCCESS'
      ? 'none'
      : responseTimeout(message) ? 'agy_response_timeout' : 'agy_error';
    data.retryable = status !== 'SUCCESS';
    data.reportAvailable = false;
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

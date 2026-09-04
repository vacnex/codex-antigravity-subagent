export type AgyUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

export type AgyStreamInitEvent = {
  event: 'init';
  conversationId: string;
  cwd?: string;
  tools?: string[];
  permissionMode?: string;
  model?: string;
  agent?: string;
};

export type AgyStreamStepUpdateEvent = {
  event: 'step_update';
  conversationId: string;
  stepIndex?: number;
  state?: string;
  stepType?: string;
  toolName?: string;
  textDelta?: string;
  durationSeconds?: number;
  usage?: AgyUsage;
  toolInfo?: Record<string, unknown>;
  subagentInfo?: Record<string, unknown>;
};

export type AgyStreamResultEvent = {
  event: 'result';
  conversationId: string;
  status: string;
  response: string;
  error?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: AgyUsage;
};

export type AgyStreamEvent =
  | AgyStreamInitEvent
  | AgyStreamStepUpdateEvent
  | AgyStreamResultEvent;

export type AgyStreamingCapabilities = {
  streamOutput: boolean;
  streamInput: boolean;
  persistentDriver: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value as string[]
    : undefined;
}

function parseUsage(value: unknown): AgyUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  return {
    input_tokens: asNumber(usage.input_tokens),
    output_tokens: asNumber(usage.output_tokens),
    thinking_tokens: asNumber(usage.thinking_tokens),
    cache_read_tokens: asNumber(usage.cache_read_tokens),
    total_tokens: asNumber(usage.total_tokens),
  };
}

/**
 * Parse one NDJSON line from Antigravity `--output-format stream-json`.
 * Unknown event types are ignored for forward compatibility.
 */
export function parseAgyStreamLine(line: string): AgyStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record) return undefined;
    root = record;
  } catch {
    return undefined;
  }

  const event = asString(root.event);
  if (event === 'init') {
    const init = asRecord(root.init);
    if (!init) return undefined;
    const conversationId = asString(root.conversation_id) ?? asString(init.conversation_id);
    if (!conversationId) return undefined;
    return {
      event: 'init',
      conversationId,
      cwd: asString(init.cwd),
      tools: asStringArray(init.tools),
      permissionMode: asString(init.permission_mode),
      model: asString(init.model),
      agent: asString(init.agent),
    };
  }

  if (event === 'step_update') {
    const update = asRecord(root.step_update);
    if (!update) return undefined;
    const conversationId = asString(update.conversation_id);
    if (!conversationId) return undefined;
    return {
      event: 'step_update',
      conversationId,
      stepIndex: asNumber(update.step_index),
      state: asString(update.state),
      stepType: asString(update.step_type),
      toolName: asString(update.tool_name),
      textDelta: asString(update.text_delta),
      durationSeconds: asNumber(update.duration_seconds),
      usage: parseUsage(update.usage),
      toolInfo: asRecord(update.tool_info),
      subagentInfo: asRecord(update.subagent_info),
    };
  }

  if (event === 'result') {
    const result = asRecord(root.result);
    if (!result) return undefined;
    const conversationId = asString(result.conversation_id);
    const status = asString(result.status);
    const response = asString(result.response);
    if (!conversationId || !status || response === undefined) return undefined;
    return {
      event: 'result',
      conversationId,
      status,
      response,
      error: asString(result.error),
      durationSeconds: asNumber(result.duration_seconds),
      numTurns: asNumber(result.num_turns),
      usage: parseUsage(result.usage),
    };
  }

  return undefined;
}

/**
 * Detect the streaming surfaces exposed by `agy --help`.
 * The presence of stream input implies stream-json output on supported AGY versions,
 * because the CLI requires both modes to be paired for persistent stdin sessions.
 */
export function detectAgyStreamingCapabilities(helpText: string): AgyStreamingCapabilities {
  const streamInput = helpText.includes('--input-format');
  const streamOutput = helpText.includes('--output-format')
    && (helpText.includes('stream-json') || streamInput);
  return {
    streamOutput,
    streamInput,
    persistentDriver: streamInput && streamOutput,
  };
}

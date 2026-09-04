import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const VERSION = '0.2.0';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MODEL_LIST_TIMEOUT_MS = 15_000;

type Effort = 'low' | 'medium' | 'high';
type RunMode = 'plan' | 'default' | 'accept-edits';

type ModelOption = {
  slug: string;
  label: string;
};

type AgyUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

type AgyEnvelope = {
  conversation_id: string;
  status: string;
  response: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
};

type WorkerState = {
  workerId: string;
  conversationId: string;
  cwd: string;
  mode: RunMode;
  agent?: string;
  model: string;
  effort: Effort;
  createdAt: string;
};

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findAgy(): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      if (await isExecutable(candidate)) return candidate;
    }
  }

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

function runAgy(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const remaining = MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });
    child.on('error', reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        truncated,
      });
    });
  });
}

function collectModelOptions(value: unknown): ModelOption[] {
  const collected: ModelOption[] = [];

  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (/^[a-z0-9][a-z0-9._/-]*$/i.test(node)) collected.push({ slug: node, label: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    const slugKeys = ['slug', 'id', 'value', 'model'];
    const labelKeys = ['display_name', 'displayName', 'name', 'label', 'title'];
    const slug = slugKeys.map((key) => record[key]).find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    const label = labelKeys.map((key) => record[key]).find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (slug) collected.push({ slug, label: label ?? slug });

    for (const child of Object.values(record)) {
      if (child !== slug && child !== label) visit(child);
    }
  };

  visit(value);
  const seen = new Set<string>();
  return collected.filter((option) => {
    if (seen.has(option.slug)) return false;
    seen.add(option.slug);
    return true;
  });
}

async function listAgyModels(executable: string, cwd: string): Promise<ModelOption[]> {
  const result = await runAgy(executable, ['models', '--output-format', 'json'], cwd, MODEL_LIST_TIMEOUT_MS);
  if (result.timedOut || result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'unknown error';
    throw new Error(`Could not list Antigravity models: ${detail}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('Antigravity returned invalid JSON from `agy models --output-format json`.');
  }

  const models = collectModelOptions(payload);
  if (models.length === 0) throw new Error('Antigravity returned no selectable models.');
  return models;
}

async function chooseModelAndEffort(
  ctx: ServerContext,
  executable: string,
  cwd: string,
  requestedModel?: string,
  requestedEffort?: Effort,
): Promise<{ model: string; effort: Effort } | { error: string }> {
  if (requestedModel && requestedEffort) return { model: requestedModel, effort: requestedEffort };

  let models: ModelOption[] = [];
  if (!requestedModel) {
    try {
      models = await listAgyModels(executable, cwd);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];
  if (!requestedModel) {
    properties.model = {
      type: 'string',
      title: 'Model',
      description: 'Antigravity model for this worker',
      enum: models.map((option) => option.slug),
      enumNames: models.map((option) => option.label),
    };
    required.push('model');
  }
  if (!requestedEffort) {
    properties.effort = {
      type: 'string',
      title: 'Effort',
      description: 'Reasoning effort for this worker',
      enum: ['low', 'medium', 'high'],
      enumNames: ['Low', 'Medium', 'High'],
      default: 'medium',
    };
    required.push('effort');
  }

  try {
    const result = await ctx.mcpReq.elicitInput({
      mode: 'form',
      message: 'Choose the Antigravity model and reasoning effort for this worker.',
      requestedSchema: {
        type: 'object',
        properties,
        required,
      },
    });

    if (result.action !== 'accept') {
      return { error: result.action === 'decline' ? 'Antigravity worker selection was declined.' : 'Antigravity worker selection was canceled.' };
    }

    const model = requestedModel ?? result.content?.model;
    const effort = requestedEffort ?? result.content?.effort;
    if (typeof model !== 'string' || !model) return { error: 'No Antigravity model was selected.' };
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return { error: 'No valid Antigravity effort was selected.' };
    return { model, effort };
  } catch (error) {
    return {
      error: `This MCP client could not show the model/effort picker. Pass both \`model\` and \`effort\` explicitly. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseAgyEnvelope(result: RunResult): AgyEnvelope | undefined {
  try {
    const parsed = JSON.parse(result.stdout) as Partial<AgyEnvelope>;
    if (typeof parsed.status !== 'string' || typeof parsed.response !== 'string' || typeof parsed.conversation_id !== 'string') return undefined;
    return parsed as AgyEnvelope;
  } catch {
    return undefined;
  }
}

function buildManagedArgs(prompt: string, worker: Omit<WorkerState, 'workerId' | 'conversationId' | 'createdAt'>, conversationId?: string): string[] {
  const args = [
    '--print', prompt,
    '--output-format', 'json',
    '--mode', worker.mode,
    '--model', worker.model,
    '--effort', worker.effort,
  ];
  if (worker.agent) args.push('--agent', worker.agent);
  if (conversationId) args.push('--conversation', conversationId);
  return args;
}

function managedResult(
  result: RunResult,
  envelope: AgyEnvelope | undefined,
  worker: WorkerState | undefined,
  timeoutSeconds: number,
) {
  const response = envelope?.response?.trim() || '';
  const error = envelope?.error?.trim() || '';
  const fallbackError = result.stderr.trim() || result.stdout.trim();
  const text = result.timedOut
    ? `Antigravity timed out after ${timeoutSeconds} seconds.`
    : response || error || fallbackError || '(Antigravity returned no output)';
  const isError = result.timedOut || result.exitCode !== 0 || (envelope !== undefined && envelope.status !== 'SUCCESS');
  const conversationId = worker?.conversationId ?? envelope?.conversation_id ?? undefined;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      workerId: worker?.workerId,
      conversationId,
      status: envelope?.status ?? (isError ? 'ERROR' : 'SUCCESS'),
      model: worker?.model,
      effort: worker?.effort,
      mode: worker?.mode,
      cwd: worker?.cwd,
      durationSeconds: envelope?.duration_seconds,
      numTurns: envelope?.num_turns,
      usage: envelope?.usage,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
    },
    isError,
  };
}

function createServer(): McpServer {
  const workers = new Map<string, WorkerState>();
  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Use agy_check before first delegation. Use agy_start for resumable work, agy_followup for corrections, and agy_close after the worker passes review. Verify delegated output and workspace changes independently.',
    },
  );

  server.registerTool(
    'agy_check',
    {
      title: 'Check Antigravity CLI',
      description: 'Verify that Google Antigravity CLI is installed and return its executable path.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const executable = await findAgy();
      if (!executable) {
        return {
          content: [{ type: 'text', text: 'Antigravity CLI was not found. Install the official `agy` CLI and authenticate it first.' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Antigravity CLI is available at: ${executable}` }],
        structuredContent: { available: true, executable },
      };
    },
  );

  server.registerTool(
    'agy_delegate',
    {
      title: 'Delegate to Antigravity',
      description: 'Run one bounded one-shot prompt through Google Antigravity CLI. Prefer agy_start when follow-up review may be needed.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000).describe('Complete bounded task prompt'),
        cwd: z.string().min(1).describe('Absolute existing workspace directory'),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('plan'),
        outputFormat: z.enum(['text', 'json']).default('text'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional().describe('Antigravity model slug. If omitted, ask the user to choose.'),
        effort: z.enum(['low', 'medium', 'high']).optional().describe('Reasoning effort. If omitted, ask the user to choose.'),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, cwd, mode, outputFormat, timeoutSeconds, agent, model, effort }, ctx) => {
      const executable = await findAgy();
      if (!executable) {
        return {
          content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check for installation guidance.' }],
          isError: true,
        };
      }

      const resolvedCwd = path.resolve(cwd);
      try {
        await access(resolvedCwd, constants.R_OK);
      } catch {
        return {
          content: [{ type: 'text', text: `Workspace is not accessible: ${resolvedCwd}` }],
          isError: true,
        };
      }

      const selection = await chooseModelAndEffort(ctx, executable, resolvedCwd, model, effort);
      if ('error' in selection) {
        return {
          content: [{ type: 'text', text: selection.error }],
          isError: true,
        };
      }

      const args = ['--print', prompt, '--output-format', outputFormat, '--mode', mode, '--model', selection.model, '--effort', selection.effort];
      if (agent) args.push('--agent', agent);

      try {
        const result = await runAgy(executable, args, resolvedCwd, timeoutSeconds * 1000);
        const summary = [result.stdout.trim()];
        if (result.stderr.trim()) summary.push(`stderr:\n${result.stderr.trim()}`);
        if (result.truncated) summary.push('[Output truncated at 2 MiB]');
        if (result.timedOut) summary.push(`[Timed out after ${timeoutSeconds} seconds]`);
        const isError = result.timedOut || result.exitCode !== 0;
        return {
          content: [{ type: 'text', text: summary.filter(Boolean).join('\n\n') || '(Antigravity returned no output)' }],
          structuredContent: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
            mode,
            cwd: resolvedCwd,
            model: selection.model,
            effort: selection.effort,
          },
          isError,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Failed to start Antigravity: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'agy_start',
    {
      title: 'Start Antigravity Worker',
      description: 'Start a resumable Antigravity worker conversation. Use the returned workerId for review corrections with agy_followup.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000).describe('Complete bounded task prompt'),
        cwd: z.string().min(1).describe('Absolute existing workspace directory'),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('accept-edits'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional().describe('Antigravity model slug. If omitted, ask the user to choose.'),
        effort: z.enum(['low', 'medium', 'high']).optional().describe('Reasoning effort. If omitted, ask the user to choose.'),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, cwd, mode, timeoutSeconds, agent, model, effort }, ctx) => {
      const executable = await findAgy();
      if (!executable) return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check first.' }], isError: true };

      const resolvedCwd = path.resolve(cwd);
      try {
        await access(resolvedCwd, constants.R_OK);
      } catch {
        return { content: [{ type: 'text', text: `Workspace is not accessible: ${resolvedCwd}` }], isError: true };
      }

      const selection = await chooseModelAndEffort(ctx, executable, resolvedCwd, model, effort);
      if ('error' in selection) return { content: [{ type: 'text', text: selection.error }], isError: true };

      const baseWorker = { cwd: resolvedCwd, mode, agent, model: selection.model, effort: selection.effort };
      try {
        const result = await runAgy(executable, buildManagedArgs(prompt, baseWorker), resolvedCwd, timeoutSeconds * 1000);
        const envelope = parseAgyEnvelope(result);
        let worker: WorkerState | undefined;
        if (envelope?.conversation_id) {
          worker = {
            workerId: `agy_${randomUUID()}`,
            conversationId: envelope.conversation_id,
            ...baseWorker,
            createdAt: new Date().toISOString(),
          };
          workers.set(worker.workerId, worker);
        }
        return managedResult(result, envelope, worker, timeoutSeconds);
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to start Antigravity: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'agy_followup',
    {
      title: 'Follow Up Antigravity Worker',
      description: 'Send review feedback or a correction to an existing Antigravity worker conversation using the same model, effort, and workspace.',
      inputSchema: z.object({
        workerId: z.string().min(1),
        prompt: z.string().min(1).max(100_000).describe('Review feedback or correction for the existing worker'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ workerId, prompt, timeoutSeconds }) => {
      const worker = workers.get(workerId);
      if (!worker) {
        return {
          content: [{ type: 'text', text: `Unknown or closed Antigravity worker: ${workerId}. Start a new worker with agy_start.` }],
          isError: true,
        };
      }
      const executable = await findAgy();
      if (!executable) return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check first.' }], isError: true };

      try {
        const baseWorker = { cwd: worker.cwd, mode: worker.mode, agent: worker.agent, model: worker.model, effort: worker.effort };
        const result = await runAgy(
          executable,
          buildManagedArgs(prompt, baseWorker, worker.conversationId),
          worker.cwd,
          timeoutSeconds * 1000,
        );
        const envelope = parseAgyEnvelope(result);
        if (envelope?.conversation_id && envelope.conversation_id !== worker.conversationId) {
          worker.conversationId = envelope.conversation_id;
        }
        return managedResult(result, envelope, worker, timeoutSeconds);
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to resume Antigravity worker: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'agy_close',
    {
      title: 'Close Antigravity Worker',
      description: 'Forget a managed worker after review passes. This does not delete the Antigravity conversation, so it remains available through `agy /resume` or `agy --conversation <id>`.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ workerId }) => {
      const worker = workers.get(workerId);
      if (!worker) {
        return {
          content: [{ type: 'text', text: `Antigravity worker is already closed or unknown: ${workerId}` }],
          structuredContent: { workerId, closed: false },
        };
      }
      workers.delete(workerId);
      return {
        content: [{ type: 'text', text: `Closed ${workerId}. Antigravity conversation ${worker.conversationId} remains resumable.` }],
        structuredContent: { workerId, conversationId: worker.conversationId, closed: true },
      };
    },
  );

  return server;
}

void serveStdio(createServer);
console.error(`agy MCP server ${VERSION} running on stdio`);

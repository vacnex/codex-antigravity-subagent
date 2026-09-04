import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import {
  detectAgyStreamingCapabilities,
  type AgyStreamingCapabilities,
  type AgyUsage,
} from './streaming.js';

const VERSION = '0.3.0';
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const CAPABILITY_TIMEOUT_MS = 10_000;

type Effort = 'low' | 'medium' | 'high';
type RunMode = 'plan' | 'default' | 'accept-edits';

type ModelOption = {
  slug: string;
  label: string;
};

type ModelFamilyOption = {
  value: string;
  label: string;
  directSlug?: string;
  variants: Partial<Record<Effort, string>>;
};

type AgyCapabilities = {
  jsonOutput: boolean;
  modelSelection: boolean;
  effort: boolean;
  conversationResume: boolean;
  mode: boolean;
  modelCatalog: boolean;
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

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
): { buffer: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.length >= maxBytes) return { buffer: current, truncated: true };
  const remaining = maxBytes - current.length;
  return {
    buffer: Buffer.concat([current, chunk.subarray(0, remaining)]),
    truncated: chunk.length > remaining,
  };
}

function clipResponse(text: string): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= MAX_RESPONSE_BYTES) return { text, truncated: false };
  const clipped = encoded.subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
  return { text: `${clipped}\n\n[Response truncated at 64 KiB]`, truncated: true };
}

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

    child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const appended = appendBounded(stdout, chunk, MAX_STDOUT_BYTES);
      stdout = appended.buffer;
      truncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const appended = appendBounded(stderr, chunk, MAX_STDERR_BYTES);
      stderr = appended.buffer;
      truncated ||= appended.truncated;
    });
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

function dedupeModelOptions(options: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.slug || seen.has(option.slug)) return false;
    seen.add(option.slug);
    return true;
  });
}

function collectModelOptions(value: unknown): ModelOption[] {
  const collected: ModelOption[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    const slug = ['slug', 'id', 'value', 'model']
      .map((key) => record[key])
      .find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    const label = ['display_name', 'displayName', 'name', 'label', 'title']
      .map((key) => record[key])
      .find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (slug) collected.push({ slug, label: label ?? slug });

    for (const child of Object.values(record)) {
      if (Array.isArray(child) || (child && typeof child === 'object')) visit(child);
    }
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') collected.push({ slug: item, label: item });
      else visit(item);
    }
  } else {
    visit(value);
  }
  return dedupeModelOptions(collected);
}

function parseTextModelOptions(text: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s{2,}(.+)$/);
    if (match) {
      options.push({ slug: match[1], label: match[2].trim() });
      continue;
    }
    const firstToken = line.split(/\s+/)[0];
    if (/^[a-z0-9][a-z0-9._/-]*$/i.test(firstToken) && firstToken.includes('-')) {
      options.push({ slug: firstToken, label: line.slice(firstToken.length).trim() || firstToken });
    }
  }
  return dedupeModelOptions(options);
}

async function listAgyModels(executable: string, cwd: string): Promise<ModelOption[]> {
  const jsonAttempts = [
    ['models', '--output-format', 'json'],
    ['--output-format', 'json', 'models'],
  ];
  const failures: string[] = [];

  for (const args of jsonAttempts) {
    const result = await runAgy(executable, args, cwd, MODEL_LIST_TIMEOUT_MS);
    if (!result.timedOut && result.exitCode === 0) {
      try {
        const models = collectModelOptions(JSON.parse(result.stdout));
        if (models.length > 0) return models;
        failures.push(`${args.join(' ')} returned an empty model catalog`);
      } catch {
        failures.push(`${args.join(' ')} returned invalid JSON`);
      }
    } else {
      failures.push(result.stderr.trim() || `${args.join(' ')} failed with exit ${result.exitCode}`);
    }
  }

  const plain = await runAgy(executable, ['models'], cwd, MODEL_LIST_TIMEOUT_MS);
  if (!plain.timedOut && plain.exitCode === 0) {
    const models = parseTextModelOptions(plain.stdout);
    if (models.length > 0) return models;
    failures.push('agy models returned no parseable entries');
  } else {
    failures.push(plain.stderr.trim() || `agy models failed with exit ${plain.exitCode}`);
  }

  throw new Error(`Could not list Antigravity models. ${failures.filter(Boolean).join(' | ')}`);
}

function inferPinnedEffort(model: string): Effort | undefined {
  const match = model.match(/-(low|medium|high)$/i);
  if (!match) return undefined;
  return match[1].toLowerCase() as Effort;
}

function stripPinnedEffortLabel(label: string): string {
  const stripped = label.replace(/\s*\((?:low|medium|high)\)\s*$/i, '').trim();
  return stripped || label;
}

function groupModelOptions(models: ModelOption[]): ModelFamilyOption[] {
  const families = new Map<string, ModelFamilyOption>();

  for (const option of models) {
    const pinnedEffort = inferPinnedEffort(option.slug);
    const value = pinnedEffort
      ? option.slug.slice(0, -(pinnedEffort.length + 1))
      : option.slug;
    const key = value.toLowerCase();
    let family = families.get(key);
    if (!family) {
      family = {
        value,
        label: pinnedEffort ? stripPinnedEffortLabel(option.label) : option.label,
        variants: {},
      };
      families.set(key, family);
    }

    if (pinnedEffort) {
      family.variants[pinnedEffort] = option.slug;
    } else {
      family.directSlug = option.slug;
      family.label = option.label;
    }
  }

  return [...families.values()];
}

function firstNonEmptyLine(...values: string[]): string | undefined {
  for (const value of values) {
    const line = value.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    if (line) return line;
  }
  return undefined;
}

async function probeAgyCapabilities(executable: string): Promise<{
  version?: string;
  capabilities: AgyCapabilities;
  streaming: AgyStreamingCapabilities;
  modelCount?: number;
  baseModelCount?: number;
  warnings: string[];
}> {
  const cwd = process.cwd();
  const warnings: string[] = [];

  const versionResult = await runAgy(executable, ['--version'], cwd, CAPABILITY_TIMEOUT_MS);
  const version = versionResult.exitCode === 0
    ? firstNonEmptyLine(versionResult.stdout, versionResult.stderr)
    : undefined;
  if (!version) warnings.push('Could not read `agy --version`.');

  const helpResult = await runAgy(executable, ['--help'], cwd, CAPABILITY_TIMEOUT_MS);
  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  const streaming = detectAgyStreamingCapabilities(helpText);
  if (helpResult.timedOut || helpResult.exitCode !== 0) warnings.push('Could not fully inspect `agy --help`.');

  let modelCount: number | undefined;
  let baseModelCount: number | undefined;
  let modelCatalog = false;
  try {
    const models = await listAgyModels(executable, cwd);
    modelCount = models.length;
    baseModelCount = groupModelOptions(models).length;
    modelCatalog = models.length > 0;
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  return {
    version,
    capabilities: {
      jsonOutput: helpText.includes('--output-format'),
      modelSelection: helpText.includes('--model'),
      effort: helpText.includes('--effort'),
      conversationResume: helpText.includes('--conversation'),
      mode: helpText.includes('--mode'),
      modelCatalog,
    },
    streaming,
    modelCount,
    baseModelCount,
    warnings,
  };
}

function resolveModelFamilySelection(
  families: ModelFamilyOption[],
  selectedModel: string,
  effort: Effort,
): { model: string; effort: Effort } | { error: string } {
  const family = families.find((option) => option.value.toLowerCase() === selectedModel.toLowerCase());
  if (!family) return { error: `Unknown Antigravity model selection: ${selectedModel}.` };

  const variant = family.variants[effort];
  if (variant) return { model: variant, effort };
  if (family.directSlug) return { model: family.directSlug, effort };

  const available = (Object.keys(family.variants) as Effort[]).join(', ');
  return {
    error: `${family.label} does not expose ${effort} effort in the current Antigravity model catalog. Available efforts: ${available || 'none'}.`,
  };
}

function appendModelAndEffortArgs(args: string[], model: string, effort: Effort): void {
  args.push('--model', model);
  if (!inferPinnedEffort(model)) args.push('--effort', effort);
}

async function chooseModelAndEffort(
  ctx: ServerContext,
  executable: string,
  cwd: string,
  requestedModel?: string,
  requestedEffort?: Effort,
): Promise<{ model: string; effort: Effort } | { error: string }> {
  if (requestedModel && requestedEffort) {
    const pinnedEffort = inferPinnedEffort(requestedModel);
    if (pinnedEffort && pinnedEffort !== requestedEffort) {
      return {
        error: `Antigravity model ${requestedModel} already pins effort ${pinnedEffort}; requested effort ${requestedEffort} conflicts with that slug.`,
      };
    }
    return { model: requestedModel, effort: requestedEffort };
  }

  let families: ModelFamilyOption[] = [];
  if (!requestedModel) {
    try {
      families = groupModelOptions(await listAgyModels(executable, cwd));
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
      description: 'Antigravity base model for this worker',
      enum: families.map((option) => option.value),
      enumNames: families.map((option) => option.label),
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

    if (!requestedModel) return resolveModelFamilySelection(families, model, effort);

    const pinnedEffort = inferPinnedEffort(model);
    if (pinnedEffort && pinnedEffort !== effort) {
      return {
        error: `Antigravity model ${model} already pins effort ${pinnedEffort}; selected effort ${effort} conflicts with that slug.`,
      };
    }
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
  ];
  appendModelAndEffortArgs(args, worker.model, worker.effort);
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
  const rawText = result.timedOut
    ? `Antigravity timed out after ${timeoutSeconds} seconds.`
    : response || error || fallbackError || '(Antigravity returned no output)';
  const clipped = clipResponse(rawText);
  const isError = result.timedOut || result.exitCode !== 0 || (envelope !== undefined && envelope.status !== 'SUCCESS');
  const conversationId = worker?.conversationId ?? envelope?.conversation_id ?? undefined;

  return {
    content: [{ type: 'text' as const, text: clipped.text }],
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
      truncated: result.truncated || clipped.truncated,
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
      description: 'Verify the Google Antigravity CLI installation and report the capabilities required by this plugin.',
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

      const report = await probeAgyCapabilities(executable);
      const capabilityEntries = Object.entries(report.capabilities);
      const streamingEntries = Object.entries(report.streaming);
      const missing = capabilityEntries.filter(([, supported]) => !supported).map(([name]) => name);
      const lines = [
        `Antigravity CLI is available at: ${executable}`,
        report.version ? `Version: ${report.version}` : 'Version: unknown',
        `Capabilities: ${capabilityEntries.map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
        `Streaming: ${streamingEntries.map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
      ];
      if (report.modelCount !== undefined) {
        lines.push(`Models: ${report.modelCount} variants across ${report.baseModelCount ?? report.modelCount} base models`);
      }
      if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.join(' | ')}`);
      if (missing.length > 0) lines.push(`Missing capabilities: ${missing.join(', ')}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          available: true,
          executable,
          version: report.version,
          capabilities: report.capabilities,
          streaming: report.streaming,
          modelCount: report.modelCount,
          baseModelCount: report.baseModelCount,
          warnings: report.warnings,
          compatible: missing.length === 0,
        },
        isError: missing.length > 0,
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

      const args = ['--print', prompt, '--output-format', outputFormat, '--mode', mode];
      appendModelAndEffortArgs(args, selection.model, selection.effort);
      if (agent) args.push('--agent', agent);

      try {
        const result = await runAgy(executable, args, resolvedCwd, timeoutSeconds * 1000);
        const isError = result.timedOut || result.exitCode !== 0;
        const clippedStdout = clipResponse(result.stdout.trim());
        const summary = [clippedStdout.text];
        if (isError && result.stderr.trim()) {
          const clippedStderr = clipResponse(result.stderr.trim());
          summary.push(`stderr:\n${clippedStderr.text}`);
        }
        if (result.timedOut) summary.push(`[Timed out after ${timeoutSeconds} seconds]`);
        const responseTruncated = result.truncated || clippedStdout.truncated;
        return {
          content: [{ type: 'text', text: summary.filter(Boolean).join('\n\n') || '(Antigravity returned no output)' }],
          structuredContent: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: responseTruncated,
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

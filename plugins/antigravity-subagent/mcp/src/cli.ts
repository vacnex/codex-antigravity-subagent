import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import type { ServerContext } from '@modelcontextprotocol/server';

import {
  detectAgyStreamingCapabilities,
  type AgyStreamingCapabilities,
  type AgyUsage,
} from './streaming.js';

export type Effort = 'low' | 'medium' | 'high';
export type RunMode = 'plan' | 'default' | 'accept-edits';

export type WorkerExecutionOptions = {
  cwd: string;
  mode: RunMode;
  agent?: string;
  model: string;
  effort: Effort;
};

export type AgyEnvelope = {
  conversation_id: string;
  status: string;
  response: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
};

export type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
  truncated: boolean;
};

export type AgyCapabilities = {
  jsonOutput: boolean;
  modelSelection: boolean;
  effort: boolean;
  conversationResume: boolean;
  mode: boolean;
  modelCatalog: boolean;
};

export type AgyCapabilityReport = {
  version?: string;
  capabilities: AgyCapabilities;
  streaming: AgyStreamingCapabilities;
  modelCount?: number;
  baseModelCount?: number;
  warnings: string[];
};

type ModelOption = { slug: string; label: string };
type ModelFamilyOption = {
  value: string;
  label: string;
  directSlug?: string;
  variants: Partial<Record<Effort, string>>;
};

type CacheEntry<T> = { value: T; expiresAt: number };

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const CAPABILITY_TIMEOUT_MS = 10_000;
const EXECUTABLE_CACHE_MS = 60_000;
const CAPABILITY_CACHE_MS = 60_000;
const MODEL_CACHE_MS = 30_000;

let executableCache: CacheEntry<string | undefined> | undefined;
const capabilityCache = new Map<string, CacheEntry<AgyCapabilityReport>>();
const modelCache = new Map<string, CacheEntry<ModelOption[]>>();

function cacheGet<T>(entry: CacheEntry<T> | undefined): T | undefined {
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.value;
}

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

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findAgy(forceRefresh = false): Promise<string | undefined> {
  if (!forceRefresh) {
    const cached = cacheGet(executableCache);
    if (cached !== undefined || executableCache?.expiresAt && executableCache.expiresAt > Date.now()) return cached;
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
  let found: string | undefined;
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      if (await isExecutable(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }

  if (!found && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (await isExecutable(candidate)) found = candidate;
  }

  executableCache = { value: found, expiresAt: Date.now() + EXECUTABLE_CACHE_MS };
  return found;
}

async function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const closed = once(child, 'close').then(() => true, () => true);
  return await Promise.race([
    closed,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function terminateChildProcess(child: ChildProcess, graceMs = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGINT');
  } catch {
    // Continue to the platform fallback below.
  }
  if (await waitForClose(child, graceMs)) return;

  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // Process may already have exited.
    }
  }
  await waitForClose(child, 1_000);
}

export function runAgy(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: {
    signal?: AbortSignal;
    onSpawn?: (child: ChildProcess) => void;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.onSpawn?.(child);

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let canceled = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        canceled,
        truncated,
      });
    };

    const stop = async (reason: 'timeout' | 'cancel') => {
      if (reason === 'timeout') timedOut = true;
      else canceled = true;
      await terminateChildProcess(child);
    };

    const onAbort = () => { void stop('cancel'); };
    if (options.signal?.aborted) void stop('cancel');
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const appended = appendBounded(stdout, chunk, MAX_STDOUT_BYTES);
      stdout = appended.buffer;
      truncated ||= appended.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const appended = appendBounded(stderr, chunk, MAX_STDERR_BYTES);
      stderr = appended.buffer;
      truncated ||= appended.truncated;
    });
    child.on('error', reject);

    const timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
    child.on('close', finish);
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
    for (const item of value) typeof item === 'string'
      ? collected.push({ slug: item, label: item })
      : visit(item);
  } else visit(value);
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

export function inferPinnedEffort(model: string): Effort | undefined {
  const match = model.match(/-(low|medium|high)$/i);
  return match ? match[1].toLowerCase() as Effort : undefined;
}

function stripPinnedEffortLabel(label: string): string {
  return label.replace(/\s*\((?:low|medium|high)\)\s*$/i, '').trim() || label;
}

export function groupModelOptions(models: ModelOption[]): ModelFamilyOption[] {
  const families = new Map<string, ModelFamilyOption>();
  for (const option of models) {
    const pinnedEffort = inferPinnedEffort(option.slug);
    const value = pinnedEffort ? option.slug.slice(0, -(pinnedEffort.length + 1)) : option.slug;
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
    if (pinnedEffort) family.variants[pinnedEffort] = option.slug;
    else {
      family.directSlug = option.slug;
      family.label = option.label;
    }
  }
  return [...families.values()];
}

export async function listAgyModels(
  executable: string,
  cwd: string,
  forceRefresh = false,
): Promise<ModelOption[]> {
  const key = `${executable}\0${cwd}`;
  if (!forceRefresh) {
    const cached = cacheGet(modelCache.get(key));
    if (cached) return cached;
  }

  const jsonAttempts = [
    ['models', '--output-format', 'json'],
    ['--output-format', 'json', 'models'],
  ];
  const failures: string[] = [];
  for (const args of jsonAttempts) {
    const result = await runAgy(executable, args, cwd, MODEL_LIST_TIMEOUT_MS);
    if (!result.timedOut && !result.canceled && result.exitCode === 0) {
      try {
        const models = collectModelOptions(JSON.parse(result.stdout));
        if (models.length > 0) {
          modelCache.set(key, { value: models, expiresAt: Date.now() + MODEL_CACHE_MS });
          return models;
        }
        failures.push(`${args.join(' ')} returned an empty model catalog`);
      } catch {
        failures.push(`${args.join(' ')} returned invalid JSON`);
      }
    } else failures.push(result.stderr.trim() || `${args.join(' ')} failed with exit ${result.exitCode}`);
  }

  const plain = await runAgy(executable, ['models'], cwd, MODEL_LIST_TIMEOUT_MS);
  if (!plain.timedOut && !plain.canceled && plain.exitCode === 0) {
    const models = parseTextModelOptions(plain.stdout);
    if (models.length > 0) {
      modelCache.set(key, { value: models, expiresAt: Date.now() + MODEL_CACHE_MS });
      return models;
    }
    failures.push('agy models returned no parseable entries');
  } else failures.push(plain.stderr.trim() || `agy models failed with exit ${plain.exitCode}`);

  throw new Error(`Could not list Antigravity models. ${failures.filter(Boolean).join(' | ')}`);
}

function firstNonEmptyLine(...values: string[]): string | undefined {
  for (const value of values) {
    const line = value.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    if (line) return line;
  }
  return undefined;
}

export async function probeAgyCapabilities(
  executable: string,
  forceRefresh = false,
): Promise<AgyCapabilityReport> {
  if (!forceRefresh) {
    const cached = cacheGet(capabilityCache.get(executable));
    if (cached) return cached;
  }

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
    const models = await listAgyModels(executable, cwd, forceRefresh);
    modelCount = models.length;
    baseModelCount = groupModelOptions(models).length;
    modelCatalog = models.length > 0;
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const report: AgyCapabilityReport = {
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
  capabilityCache.set(executable, { value: report, expiresAt: Date.now() + CAPABILITY_CACHE_MS });
  return report;
}

export function appendModelAndEffortArgs(args: string[], model: string, effort: Effort): void {
  args.push('--model', model);
  if (!inferPinnedEffort(model)) args.push('--effort', effort);
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
  return { error: `${family.label} does not expose ${effort} effort. Available efforts: ${available || 'none'}.` };
}

export async function chooseModelAndEffort(
  ctx: ServerContext,
  executable: string,
  cwd: string,
  requestedModel?: string,
  requestedEffort?: Effort,
): Promise<{ model: string; effort: Effort } | { error: string }> {
  if (requestedModel && requestedEffort) {
    const pinned = inferPinnedEffort(requestedModel);
    return pinned && pinned !== requestedEffort
      ? { error: `Antigravity model ${requestedModel} pins effort ${pinned}; requested ${requestedEffort}.` }
      : { model: requestedModel, effort: requestedEffort };
  }

  let families: ModelFamilyOption[] = [];
  if (!requestedModel) {
    try {
      families = groupModelOptions(await listAgyModels(executable, cwd));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (!requestedModel) {
    properties.model = {
      type: 'string', title: 'Model', description: 'Antigravity base model for this worker',
      enum: families.map((entry) => entry.value), enumNames: families.map((entry) => entry.label),
    };
    required.push('model');
  }
  if (!requestedEffort) {
    properties.effort = {
      type: 'string', title: 'Effort', description: 'Reasoning effort for this worker',
      enum: ['low', 'medium', 'high'], enumNames: ['Low', 'Medium', 'High'], default: 'medium',
    };
    required.push('effort');
  }

  try {
    const result = await ctx.mcpReq.elicitInput({
      mode: 'form',
      message: 'Choose the Antigravity model and reasoning effort for this worker.',
      requestedSchema: { type: 'object', properties, required },
    });
    if (result.action !== 'accept') {
      return { error: result.action === 'decline' ? 'Antigravity worker selection was declined.' : 'Antigravity worker selection was canceled.' };
    }
    const model = requestedModel ?? result.content?.model;
    const effort = requestedEffort ?? result.content?.effort;
    if (typeof model !== 'string' || !model) return { error: 'No Antigravity model was selected.' };
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return { error: 'No valid Antigravity effort was selected.' };
    if (!requestedModel) return resolveModelFamilySelection(families, model, effort);
    const pinned = inferPinnedEffort(model);
    return pinned && pinned !== effort
      ? { error: `Antigravity model ${model} pins effort ${pinned}; selected ${effort}.` }
      : { model, effort };
  } catch (error) {
    return { error: `This MCP client could not show the model/effort picker. Pass both model and effort explicitly. ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function buildOneShotArgs(
  prompt: string,
  worker: WorkerExecutionOptions,
  conversationId?: string,
  outputFormat: 'text' | 'json' = 'json',
): string[] {
  const args = ['--print', prompt, '--output-format', outputFormat, '--mode', worker.mode];
  appendModelAndEffortArgs(args, worker.model, worker.effort);
  if (worker.agent) args.push('--agent', worker.agent);
  if (conversationId) args.push('--conversation', conversationId);
  return args;
}

export function buildPersistentArgs(worker: WorkerExecutionOptions, conversationId?: string): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', worker.mode];
  appendModelAndEffortArgs(args, worker.model, worker.effort);
  if (worker.agent) args.push('--agent', worker.agent);
  if (conversationId) args.push('--conversation', conversationId);
  return args;
}

export function parseAgyEnvelope(result: RunResult): AgyEnvelope | undefined {
  try {
    const parsed = JSON.parse(result.stdout) as Partial<AgyEnvelope>;
    if (typeof parsed.status !== 'string' || typeof parsed.response !== 'string' || typeof parsed.conversation_id !== 'string') return undefined;
    return parsed as AgyEnvelope;
  } catch {
    return undefined;
  }
}

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import {
  buildOneShotArgs,
  findAgy,
  probeAgyCapabilities,
  runAgy,
  type Effort,
  type RunMode,
} from './cli.js';
import { withAgyProjectLaunch } from './launch-context.js';
import {
  resolveLaunchSelection,
  type LaunchSelectionReady,
} from './launch-selection.js';
import {
  discoverAgyProjects,
  projectContainsPath,
  resolveAgyProject,
  type AgyProject,
  type AgyProjectRegistry,
} from './projects.js';
import { normalizeManagedResult } from './result-semantics.js';
import { WorkerRuntime, type RuntimeToolResult } from './runtime.js';

const VERSION = '0.4.2';
const WAIT_POLL_MS = 1_000;
const NEW_PROJECT_DISCOVERY_MS = 3_000;
const NEW_PROJECT_DISCOVERY_POLL_MS = 100;

function isRunningResult(result: RuntimeToolResult): boolean {
  return result.structuredContent.done === false || result.structuredContent.state === 'running';
}

function describeRunningResult(result: RuntimeToolResult, workerId: string): RuntimeToolResult {
  if (!isRunningResult(result)) return result;
  const name = typeof result.structuredContent.name === 'string' ? result.structuredContent.name : workerId;
  const progress = result.structuredContent.progress;
  let progressText = '';
  if (progress && typeof progress === 'object') {
    const summary = progress as Record<string, unknown>;
    const steps = typeof summary.stepUpdates === 'number' ? summary.stepUpdates : undefined;
    const tools = typeof summary.toolEvents === 'number' ? summary.toolEvents : undefined;
    if (steps !== undefined || tools !== undefined) {
      progressText = ` Progress: ${steps ?? 0} step updates, ${tools ?? 0} tool events.`;
    }
  }
  if (result.content[0]) {
    result.content[0].text = `${name} (${workerId}) is still running in the background.${progressText} Use agy_wait to wait passively for completion, or agy_status for a lifecycle snapshot.`;
  }
  return result;
}

function annotateWaitExit(
  result: RuntimeToolResult,
  workerId: string,
  reason: 'timeout' | 'canceled',
): RuntimeToolResult {
  describeRunningResult(result, workerId);
  result.structuredContent.waitTimedOut = reason === 'timeout';
  result.structuredContent.waitCanceled = reason === 'canceled';
  result.structuredContent.workerContinues = isRunningResult(result);
  if (result.content[0] && isRunningResult(result)) {
    const prefix = reason === 'timeout'
      ? 'The passive wait interval ended before the worker finished.'
      : 'The passive wait was canceled by the MCP client.';
    result.content[0].text = `${prefix} The Antigravity worker was not canceled and continues in the background. ${result.content[0].text}`;
  }
  return result;
}

async function waitDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function textError(text: string, code?: string): RuntimeToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: code ? { errorCode: code } : {},
    isError: true,
  };
}

function projectMetadata(
  selection: LaunchSelectionReady,
  project: AgyProject | undefined,
  registry: AgyProjectRegistry,
): Record<string, unknown> {
  return {
    agyProjectId: project?.id,
    agyProjectName: project?.name,
    agyProjectRoots: project?.roots,
    agyProjectResolution: selection.projectResolution,
    agyProjectRegistryDir: registry.directory,
    agyWorkspaceAttested: true,
  };
}

async function persistProjectMetadata(
  runtime: WorkerRuntime,
  workerId: string,
  metadata: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    const record = await runtime.store.read(workerId);
    if (!record) return `Worker ledger not found after start: ${workerId}`;
    await runtime.store.write({
      ...record,
      agyProjectId: typeof metadata.agyProjectId === 'string' ? metadata.agyProjectId : undefined,
      agyProjectName: typeof metadata.agyProjectName === 'string' ? metadata.agyProjectName : undefined,
      agyProjectRoots: Array.isArray(metadata.agyProjectRoots)
        ? metadata.agyProjectRoots.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      agyProjectResolution:
        metadata.agyProjectResolution === 'explicit'
        || metadata.agyProjectResolution === 'auto'
        || metadata.agyProjectResolution === 'selected'
        || metadata.agyProjectResolution === 'created'
          ? metadata.agyProjectResolution
          : undefined,
      agyProjectRegistryDir: typeof metadata.agyProjectRegistryDir === 'string' ? metadata.agyProjectRegistryDir : undefined,
      agyWorkspaceAttested: metadata.agyWorkspaceAttested === true,
      updatedAt: new Date().toISOString(),
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function decorateProjectMetadata(result: RuntimeToolResult, runtime: WorkerRuntime): Promise<RuntimeToolResult> {
  const workerId = typeof result.structuredContent.workerId === 'string' ? result.structuredContent.workerId : undefined;
  if (workerId) {
    const record = await runtime.store.read(workerId).catch(() => undefined);
    if (record) {
      result.structuredContent.agyProjectId = record.agyProjectId;
      result.structuredContent.agyProjectName = record.agyProjectName;
      result.structuredContent.agyProjectRoots = record.agyProjectRoots;
      result.structuredContent.agyProjectResolution = record.agyProjectResolution;
      result.structuredContent.agyProjectRegistryDir = record.agyProjectRegistryDir;
      result.structuredContent.agyWorkspaceAttested = record.agyWorkspaceAttested;
    }
  }

  const workers = result.structuredContent.workers;
  if (Array.isArray(workers)) {
    const records = await runtime.store.list().catch(() => []);
    const byId = new Map(records.map((record) => [record.workerId, record]));
    for (const item of workers) {
      if (!item || typeof item !== 'object') continue;
      const worker = item as Record<string, unknown>;
      const id = typeof worker.workerId === 'string' ? worker.workerId : undefined;
      const record = id ? byId.get(id) : undefined;
      if (!record) continue;
      worker.agyProjectId = record.agyProjectId;
      worker.agyProjectName = record.agyProjectName;
      worker.agyProjectRoots = record.agyProjectRoots;
      worker.agyProjectResolution = record.agyProjectResolution;
      worker.agyWorkspaceAttested = record.agyWorkspaceAttested;
    }
  }
  return result;
}

async function discoverCreatedProject(
  cwd: string,
  beforeIds: Set<string>,
): Promise<{ registry: AgyProjectRegistry; project?: AgyProject; warning?: string }> {
  const deadline = Date.now() + NEW_PROJECT_DISCOVERY_MS;
  let latest = await discoverAgyProjects();
  while (true) {
    const created = latest.projects.filter((project) =>
      !beforeIds.has(project.id) && project.roots.some((root) => projectContainsPath(root, cwd)));
    if (created.length === 1) return { registry: latest, project: created[0] };
    if (created.length > 1) {
      return {
        registry: latest,
        warning: `Antigravity created multiple new Projects containing ${cwd}; project pinning is ambiguous: ${created.map((entry) => entry.id).join(', ')}.`,
      };
    }
    if (Date.now() >= deadline) {
      return {
        registry: latest,
        warning: `Antigravity created a new Project for ${cwd}, but its project ID was not discoverable within ${NEW_PROJECT_DISCOVERY_MS}ms.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, NEW_PROJECT_DISCOVERY_POLL_MS));
    latest = await discoverAgyProjects();
  }
}

async function createServer(): Promise<McpServer> {
  const runtime = new WorkerRuntime();
  await runtime.ensureRecovered();

  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Use agy_check before first delegation. New AGY workers are resolved into an Antigravity Project from the requested cwd; when multiple equally specific Projects contain that path, let the MCP setup form ask the user which Project to use, and then pass the returned agyProjectId to subsequent plan-step starts in the same blueprint. Model/effort/project setup uses MCP input_required rather than push-style elicitation. Managed agy_start/agy_followup launches return quickly while AGY continues in the background; use agy_wait as the normal completion barrier. A RUNNING worker or passive wait timeout is not a reason to end a requested multi-step plan. A terminal AGY status=ERROR is not automatically an implementation failure: audit the workspace first, and only send agy_followup when the independent review actually fails. Pass stable idempotency keys, use agy_cancel for active turns, and agy_close only after review passes.',
    },
  );

  server.registerTool(
    'agy_check',
    {
      title: 'Check Antigravity CLI',
      description: 'Verify the Google Antigravity CLI installation and report managed-worker capabilities.',
      inputSchema: z.object({ refresh: z.boolean().default(false).describe('Bypass short-lived executable/capability/model caches') }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ refresh }) => {
      const executable = await findAgy(refresh);
      if (!executable) {
        return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Install and authenticate the official `agy` CLI first.' }], isError: true };
      }
      const report = await probeAgyCapabilities(executable, refresh);
      const requiredEntries = Object.entries(report.capabilities);
      const missing = requiredEntries.filter(([, supported]) => !supported).map(([name]) => name);
      const registry = await discoverAgyProjects();
      const lines = [
        `Antigravity CLI is available at: ${executable}`,
        report.version ? `Version: ${report.version}` : 'Version: unknown',
        `Capabilities: ${requiredEntries.map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
        `Streaming: ${Object.entries(report.streaming).map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
        `Projects: ${registry.projects.length}${registry.directory ? ` from ${registry.directory}` : ' (registry not found; new workspaces will use --new-project)'}`,
      ];
      if (report.modelCount !== undefined) lines.push(`Models: ${report.modelCount} variants across ${report.baseModelCount ?? report.modelCount} base models`);
      const warnings = [...report.warnings, ...registry.warnings, ...runtime.getRecoveryWarnings()];
      if (warnings.length > 0) lines.push(`Warnings: ${warnings.join(' | ')}`);
      if (missing.length > 0) lines.push(`Missing required capabilities: ${missing.join(', ')}`);
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
          projectCount: registry.projects.length,
          projectRegistryDir: registry.directory,
          warnings,
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
        prompt: z.string().min(1).max(100_000),
        cwd: z.string().min(1),
        projectId: z.string().min(1).max(200).optional().describe('Explicit Antigravity Project id/name; otherwise resolve from cwd'),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('plan'),
        outputFormat: z.enum(['text', 'json']).default('text'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false },
    },
    async ({ prompt, cwd, projectId, mode, outputFormat, timeoutSeconds, agent, model, effort }, ctx) => {
      const executable = await findAgy();
      if (!executable) return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check first.' }], isError: true };
      const resolvedCwd = path.resolve(cwd);
      try { await access(resolvedCwd, constants.R_OK); } catch {
        return { content: [{ type: 'text', text: `Workspace is not accessible: ${resolvedCwd}` }], isError: true };
      }
      const registry = await discoverAgyProjects();
      const resolution = resolveAgyProject(resolvedCwd, registry.projects, projectId);
      const selection = await resolveLaunchSelection(ctx, {
        executable,
        cwd: resolvedCwd,
        requestedModel: model,
        requestedEffort: effort as Effort | undefined,
        projectResolution: resolution,
      });
      if ('inputRequests' in selection) return selection;
      if (selection.kind === 'error') return textError(selection.error, selection.code);
      const execution = { cwd: resolvedCwd, mode: mode as RunMode, agent, model: selection.model, effort: selection.effort };
      try {
        const result = await withAgyProjectLaunch(selection.projectLaunch, () => runAgy(
          executable,
          buildOneShotArgs(prompt, execution, undefined, outputFormat),
          resolvedCwd,
          timeoutSeconds * 1000,
          { signal: ctx.mcpReq.signal },
        ));
        const output = result.stdout.trim() || result.stderr.trim() || '(Antigravity returned no output)';
        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            canceled: result.canceled,
            truncated: result.truncated,
            mode,
            cwd: resolvedCwd,
            model: selection.model,
            effort: selection.effort,
            agyProjectId: selection.project?.id,
            agyProjectName: selection.project?.name,
            agyProjectRoots: selection.project?.roots,
            agyProjectResolution: selection.projectResolution,
            agyWorkspaceAttested: true,
          },
          isError: result.timedOut || result.canceled || result.exitCode !== 0,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to run Antigravity: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'agy_start',
    {
      title: 'Start Antigravity Worker',
      description: 'Start a persistent/resumable managed Antigravity worker. The cwd is resolved into an Antigravity Project before launch, and stream init must attest the requested workspace before any prompt is sent.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000),
        name: z.string().min(1).max(120).optional().describe('Friendly plan-step name stored only in the local worker ledger'),
        idempotencyKey: z.string().min(1).max(200).optional().describe('Stable key for retries of the same logical plan step; prevents duplicate workers'),
        cwd: z.string().min(1),
        projectId: z.string().min(1).max(200).optional().describe('Explicit Antigravity Project id/name. Reuse the first plan step agyProjectId for later steps in the same blueprint.'),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('accept-edits'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: true },
    },
    async ({ prompt, name, idempotencyKey, cwd, projectId, mode, timeoutSeconds, agent, model, effort }, ctx) => {
      const resolvedCwd = path.resolve(cwd);
      try { await access(resolvedCwd, constants.R_OK); } catch {
        return { content: [{ type: 'text', text: `Workspace is not accessible: ${resolvedCwd}` }], isError: true };
      }

      const reused = await runtime.reuseExistingStart({ name, cwd: resolvedCwd, idempotencyKey });
      if (reused) return normalizeManagedResult(await decorateProjectMetadata(reused, runtime));

      const executable = await findAgy();
      if (!executable) return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check first.' }], isError: true };
      const registryBefore = await discoverAgyProjects();
      const resolution = resolveAgyProject(resolvedCwd, registryBefore.projects, projectId);
      const selection = await resolveLaunchSelection(ctx, {
        executable,
        cwd: resolvedCwd,
        requestedModel: model,
        requestedEffort: effort as Effort | undefined,
        projectResolution: resolution,
      });
      if ('inputRequests' in selection) return selection;
      if (selection.kind === 'error') return textError(selection.error, selection.code);

      const beforeIds = new Set(registryBefore.projects.map((entry) => entry.id));
      let result = await withAgyProjectLaunch(selection.projectLaunch, () => runtime.start({
        prompt,
        name,
        idempotencyKey,
        cwd: resolvedCwd,
        mode,
        timeoutSeconds,
        agent,
        model: selection.model,
        effort: selection.effort,
        signal: ctx.mcpReq.signal,
      }));

      const workerId = typeof result.structuredContent.workerId === 'string' ? result.structuredContent.workerId : undefined;
      if (!workerId || result.isError) return normalizeManagedResult(result);

      let selectedProject = selection.project;
      let projectRegistry = registryBefore;
      let projectWarning: string | undefined;
      if (selection.projectLaunch.kind === 'new') {
        const discovered = await discoverCreatedProject(resolvedCwd, beforeIds);
        selectedProject = discovered.project;
        projectRegistry = discovered.registry;
        projectWarning = discovered.warning;
      }

      const metadata = projectMetadata(selection, selectedProject, projectRegistry);
      const persistenceError = await persistProjectMetadata(runtime, workerId, metadata);
      Object.assign(result.structuredContent, metadata);
      if (projectWarning) {
        result.structuredContent.projectWarning = projectWarning;
        if (result.content[0]) result.content[0].text += `\n\n[Project warning: ${projectWarning}]`;
      }
      if (persistenceError) {
        result.structuredContent.projectMetadataPersisted = false;
        result.structuredContent.projectPersistenceError = persistenceError;
        if (result.content[0]) result.content[0].text += `\n\n[Project metadata warning: ${persistenceError}]`;
      } else {
        result.structuredContent.projectMetadataPersisted = true;
      }
      result = await decorateProjectMetadata(result, runtime);
      return normalizeManagedResult(result);
    },
  );

  server.registerTool(
    'agy_followup',
    {
      title: 'Follow Up Antigravity Worker',
      description: 'Launch review feedback on an existing managed worker. The resumed AGY conversation automatically keeps its associated Antigravity Project.',
      inputSchema: z.object({
        workerId: z.string().min(1),
        prompt: z.string().min(1).max(100_000),
        idempotencyKey: z.string().min(1).max(200).optional().describe('Stable key for retries of this correction turn'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: true },
    },
    async ({ workerId, prompt, idempotencyKey, timeoutSeconds }, ctx) => {
      const result = await runtime.followup({ workerId, prompt, idempotencyKey, timeoutSeconds, signal: ctx.mcpReq.signal });
      return normalizeManagedResult(await decorateProjectMetadata(result, runtime));
    },
  );

  server.registerTool(
    'agy_result',
    {
      title: 'Antigravity Worker Result',
      description: 'Read the current/final result state of the latest managed worker turn without sending a new prompt. Terminal AGY ERROR is reported separately from MCP transport failure; audit the workspace before deciding to correct.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => normalizeManagedResult(
      await decorateProjectMetadata(describeRunningResult(await runtime.result(workerId), workerId), runtime),
    ),
  );

  server.registerTool(
    'agy_wait',
    {
      title: 'Wait for Antigravity Worker',
      description: 'Passively wait for the latest managed worker turn to finish without sending a prompt or owning/canceling the worker. A terminal AGY error is not automatically an implementation failure.',
      inputSchema: z.object({
        workerId: z.string().min(1),
        timeoutSeconds: z.number().int().min(1).max(1100).default(900).describe('Maximum passive wait interval; kept below the bundled 1200-second MCP tool timeout'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId, timeoutSeconds }, ctx) => {
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (true) {
        let result = await runtime.result(workerId);
        if (!isRunningResult(result)) {
          result.structuredContent.waitTimedOut = false;
          result.structuredContent.waitCanceled = false;
          result.structuredContent.workerContinues = false;
          result = await decorateProjectMetadata(result, runtime);
          return normalizeManagedResult(result);
        }
        if (ctx.mcpReq.signal.aborted) {
          result = annotateWaitExit(result, workerId, 'canceled');
          return normalizeManagedResult(await decorateProjectMetadata(result, runtime));
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          result = annotateWaitExit(result, workerId, 'timeout');
          return normalizeManagedResult(await decorateProjectMetadata(result, runtime));
        }
        const waited = await waitDelay(Math.min(WAIT_POLL_MS, remaining), ctx.mcpReq.signal);
        if (!waited) {
          result = annotateWaitExit(result, workerId, 'canceled');
          return normalizeManagedResult(await decorateProjectMetadata(result, runtime));
        }
      }
    },
  );

  server.registerTool(
    'agy_status',
    {
      title: 'Antigravity Worker Status',
      description: 'Inspect one managed worker or list persisted active/recoverable workers, including project binding, timeout/cancel and duplicate-worker metadata.',
      inputSchema: z.object({ workerId: z.string().min(1).optional(), includeClosed: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId, includeClosed }) => decorateProjectMetadata(await runtime.status(workerId, includeClosed), runtime),
  );

  server.registerTool(
    'agy_cancel',
    {
      title: 'Cancel Antigravity Worker Turn',
      description: 'Interrupt the active background turn for a managed worker without deleting its recoverable Antigravity conversation.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => decorateProjectMetadata(await runtime.cancel(workerId), runtime),
  );

  server.registerTool(
    'agy_close',
    {
      title: 'Close Antigravity Worker',
      description: 'Close a managed worker and retain its local ledger record plus Antigravity conversation/project binding for audit.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => decorateProjectMetadata(await runtime.close(workerId), runtime),
  );

  return server;
}

async function main(): Promise<void> {
  process.stderr.write(`agy MCP server ${VERSION} running on stdio\n`);
  await serveStdio(() => createServer());
}

void main().catch((error) => {
  process.stderr.write(`agy MCP server failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

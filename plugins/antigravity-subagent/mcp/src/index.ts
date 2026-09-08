import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { findAgy, probeAgyCapabilities, type Effort } from './cli.js';
import { BlueprintStore } from './blueprint-store.js';
import { findPlan, workspaceMatches } from './blueprint.js';
import { captureLatestBlueprintFromThread } from './codex-transcript.js';
import { capturePlanBaseline } from './git-baseline.js';
import { withAgyProjectLaunch } from './launch-context.js';
import { resolveLaunchSelection, type LaunchSelectionReady } from './launch-selection.js';
import { buildCorrectionPrompt, buildInitialPlanPrompt, buildResumePrompt, type ReviewFinding } from './plan-prompt.js';
import { buildPlanReviewBundle } from './plan-review.js';
import {
  discoverAgyProjects,
  projectContainsPath,
  resolveAgyProject,
  type AgyProject,
  type AgyProjectRegistry,
} from './projects.js';
import { normalizeManagedResult } from './result-semantics.js';
import { RunStore, type ExecutionRunRecord } from './run-store.js';
import { WorkerRuntime, type RuntimeToolResult } from './runtime.js';

const packagePath = path.resolve(path.dirname(process.argv[1] ?? '.'), '..', 'package.json');
const VERSION = (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version;
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
    result.content[0].text = `${name} (${workerId}) is still running in the background.${progressText} Use agy_wait to wait passively for completion, or agy_status only when lifecycle state is uncertain.`;
  }
  return result;
}

function compactStandaloneStart(result: RuntimeToolResult): RuntimeToolResult {
  if (!isRunningResult(result) || !result.content[0]) return result;
  const workerId = typeof result.structuredContent.workerId === 'string' ? result.structuredContent.workerId : 'unknown';
  const name = typeof result.structuredContent.name === 'string' ? result.structuredContent.name : 'Antigravity worker';
  result.content[0].text = `Started ${name} (worker=${workerId}). Use agy_wait.`;
  return result;
}

function compactPlanStart(result: RuntimeToolResult, run: ExecutionRunRecord, planId: string): RuntimeToolResult {
  attachRunMetadata(result, run, planId);
  if (!isRunningResult(result) || !result.content[0]) return result;
  const workerId = typeof result.structuredContent.workerId === 'string' ? result.structuredContent.workerId : 'unknown';
  const verb = result.structuredContent.reused === true ? 'Reusing' : 'Started';
  result.content[0].text = `${verb} ${planId} (worker=${workerId}, run=${run.runId}). Use agy_wait.`;
  return result;
}

function annotatePlanTerminalRecovery(
  result: RuntimeToolResult,
  binding: { run: ExecutionRunRecord; planId: string } | undefined,
): RuntimeToolResult {
  if (!binding || isRunningResult(result) || result.structuredContent.done !== true || result.structuredContent.retryable !== true) return result;
  result.structuredContent.recommendedNextAction = 'review_plan';
  const failureKind = typeof result.structuredContent.failureKind === 'string'
    ? result.structuredContent.failureKind
    : 'retryable_error';
  if (result.content[0]) {
    result.content[0].text = `${binding.planId} turn ended with retryable ${failureKind}. The worker is not running; do not call agy_wait again. Call agy_review_plan before deciding whether to resume or send findings.`;
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
      agyWorkspaceAttested: true,
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

function getThreadId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const value = (meta as Record<string, unknown>).threadId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function attachRunMetadata(result: RuntimeToolResult, run: ExecutionRunRecord, planId: string): RuntimeToolResult {
  result.structuredContent.runId = run.runId;
  result.structuredContent.blueprintId = run.blueprintId;
  result.structuredContent.planId = planId;
  return result;
}

async function createServer(): Promise<McpServer> {
  const runtime = new WorkerRuntime();
  const blueprintStore = new BlueprintStore();
  const runStore = new RunStore();
  await runtime.ensureRecovered();

  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Codex owns repository planning and semantic review. For approved AGY_BLUEPRINT:v1 plans, use agy_start_plan so the MCP server captures the canonical blueprint from the current Codex thread, persists it locally, reconstructs the PLAN prompt server-side, and keeps large repeated handoff text out of Codex tool output. Use agy_review_plan for compact deterministic scope/validation evidence and request includeDiff only when needed. Send PLAN corrections through agy_followup findings; use agy_followup resume=true only after a retryable terminal interruption has been reviewed. Use agy_start for standalone bounded delegation. Use agy_wait as the completion barrier, agy_status only for lifecycle uncertainty, agy_cancel for active turns, and agy_close only after the supervising workflow no longer needs corrections.',
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
          serverVersion: VERSION,
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
    'agy_start',
    {
      title: 'Start Antigravity Worker',
      description: 'Start one standalone persistent/resumable Antigravity worker from a bounded prompt. Approved multi-PLAN execution should use agy_start_plan instead.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000),
        name: z.string().min(1).max(120).optional().describe('Friendly assignment name stored only in the local worker ledger'),
        idempotencyKey: z.string().min(1).max(200).optional().describe('Stable key for retries of the same logical assignment; prevents duplicate workers'),
        cwd: z.string().min(1),
        projectId: z.string().min(1).max(200).optional().describe('Explicit Antigravity Project id/name; otherwise resolve from cwd'),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('plan'),
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
        return textError(`Workspace is not accessible: ${resolvedCwd}`, 'WORKSPACE_UNAVAILABLE');
      }

      const reused = await runtime.reuseExistingStart({ name, cwd: resolvedCwd, idempotencyKey });
      if (reused) return normalizeManagedResult(compactStandaloneStart(await decorateProjectMetadata(reused, runtime)));

      const executable = await findAgy();
      if (!executable) return textError('Antigravity CLI was not found. Run agy_check first.', 'AGY_NOT_FOUND');
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
      result = compactStandaloneStart(await decorateProjectMetadata(result, runtime));
      return normalizeManagedResult(result);
    },
  );

  server.registerTool(
    'agy_start_plan',
    {
      title: 'Start Approved Blueprint PLAN',
      description: 'Start one PLAN-XX from the canonical AGY_BLUEPRINT:v1 in the current Codex thread. The server captures/persists the blueprint and builds the long AGY prompt without requiring Codex to repeat PLAN text.',
      inputSchema: z.object({
        planId: z.string().regex(/^PLAN-\d{2,}$/),
        runId: z.string().regex(/^run_[A-Za-z0-9-]{8,}$/).optional().describe('Reuse an existing execution run. Omit for the first PLAN so the server captures the current thread blueprint.'),
        cwd: z.string().min(1).optional().describe('Required only when creating the execution run; later PLANs reuse the run workspace.'),
        projectId: z.string().min(1).max(200).optional().describe('Optional first-run Project selection; later PLANs reuse the pinned Project.'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: true },
    },
    async ({ planId, runId, cwd, projectId, timeoutSeconds, agent, model, effort }, ctx) => {
      let run: ExecutionRunRecord;
      let stored;
      if (runId) {
        try {
          run = await runStore.read(runId);
          stored = await blueprintStore.read(run.blueprintId);
        } catch (error) {
          return textError(error instanceof Error ? error.message : String(error), 'EXECUTION_RUN_UNAVAILABLE');
        }
        if (cwd && path.resolve(cwd) !== path.resolve(run.cwd)) {
          return textError(`Requested cwd does not match execution run workspace: ${run.cwd}`, 'BLUEPRINT_WORKSPACE_MISMATCH');
        }
      } else {
        if (!cwd) return textError('cwd is required when starting the first PLAN of an execution run.', 'WORKSPACE_REQUIRED');
        const resolvedCwd = path.resolve(cwd);
        const threadId = getThreadId(ctx.mcpReq._meta);
        if (!threadId) {
          return textError('Codex did not provide threadId MCP metadata; blueprint capture cannot proceed without regenerating text.', 'BLUEPRINT_CAPTURE_UNAVAILABLE');
        }
        try {
          await access(resolvedCwd, constants.R_OK);
          const captured = await captureLatestBlueprintFromThread(threadId);
          stored = await blueprintStore.save(captured.canonicalText, threadId);
          if (!workspaceMatches(stored.blueprint.workspace, resolvedCwd)) {
            return textError(`Blueprint workspace ${stored.blueprint.workspace} does not match requested cwd ${resolvedCwd}.`, 'BLUEPRINT_WORKSPACE_MISMATCH');
          }
          run = await runStore.create({ blueprintId: stored.blueprintId, threadId, cwd: resolvedCwd });
        } catch (error) {
          return textError(error instanceof Error ? error.message : String(error), 'BLUEPRINT_CAPTURE_UNAVAILABLE');
        }
      }

      if (stored.blueprint.status !== 'READY') {
        return textError(`Blueprint ${stored.blueprintId} is ${stored.blueprint.status}; only READY blueprints can execute.`, 'BLUEPRINT_NOT_READY');
      }
      let plan;
      try {
        plan = findPlan(stored.blueprint, planId);
      } catch (error) {
        return textError(error instanceof Error ? error.message : String(error), 'PLAN_NOT_FOUND');
      }

      const existingState = run.plans[planId];
      if (existingState?.workerId) {
        let existing = describeRunningResult(await runtime.result(existingState.workerId), existingState.workerId);
        existing = await decorateProjectMetadata(existing, runtime);
        existing.structuredContent.reused = true;
        return normalizeManagedResult(compactPlanStart(existing, run, planId));
      }

      const idempotencyKey = existingState?.idempotencyKey ?? `${run.runId}:${planId}`;
      let baselineId = existingState?.baselineId;
      if (!baselineId) {
        try {
          const baseline = await capturePlanBaseline(run.cwd, plan, runStore.baselineDir(run.runId, planId));
          baselineId = baseline.baselineId;
          run.plans[planId] = {
            ...existingState,
            idempotencyKey,
            baselineId,
            startedAt: new Date().toISOString(),
          };
          await runStore.write(run);
        } catch (error) {
          return textError(`Failed to capture PLAN baseline: ${error instanceof Error ? error.message : String(error)}`, 'PLAN_BASELINE_FAILED');
        }
      }

      const name = `${planId}: ${plan.title}`;
      const reused = await runtime.reuseExistingStart({ name, cwd: run.cwd, idempotencyKey });
      if (reused) {
        const decorated = await decorateProjectMetadata(reused, runtime);
        const workerId = typeof decorated.structuredContent.workerId === 'string' ? decorated.structuredContent.workerId : undefined;
        if (workerId) {
          run = await runStore.attachPlanWorker({
            runId: run.runId,
            planId,
            workerId,
            conversationId: typeof decorated.structuredContent.conversationId === 'string' ? decorated.structuredContent.conversationId : undefined,
            idempotencyKey,
            baselineId,
            agyProjectId: typeof decorated.structuredContent.agyProjectId === 'string' ? decorated.structuredContent.agyProjectId : undefined,
            model: typeof decorated.structuredContent.model === 'string' ? decorated.structuredContent.model : undefined,
            effort: typeof decorated.structuredContent.effort === 'string' ? decorated.structuredContent.effort : undefined,
          });
        }
        decorated.structuredContent.reused = true;
        return normalizeManagedResult(compactPlanStart(decorated, run, planId));
      }

      const executable = await findAgy();
      if (!executable) return textError('Antigravity CLI was not found. Run agy_check first.', 'AGY_NOT_FOUND');
      const registryBefore = await discoverAgyProjects();
      const resolution = resolveAgyProject(run.cwd, registryBefore.projects, run.agyProjectId ?? projectId);
      const selection = await resolveLaunchSelection(ctx, {
        executable,
        cwd: run.cwd,
        requestedModel: run.model ?? model,
        requestedEffort: (run.effort ?? effort) as Effort | undefined,
        projectResolution: resolution,
      });
      if ('inputRequests' in selection) return selection;
      if (selection.kind === 'error') return textError(selection.error, selection.code);

      let prompt: string;
      try {
        prompt = await buildInitialPlanPrompt(run.cwd, stored.blueprint, plan);
      } catch (error) {
        return textError(`Failed to build ${planId} AGY context: ${error instanceof Error ? error.message : String(error)}`, 'PLAN_CONTEXT_FAILED');
      }

      const beforeIds = new Set(registryBefore.projects.map((entry) => entry.id));
      let result = await withAgyProjectLaunch(selection.projectLaunch, () => runtime.start({
        prompt,
        name,
        idempotencyKey,
        cwd: run.cwd,
        mode: 'accept-edits',
        timeoutSeconds,
        agent,
        model: selection.model,
        effort: selection.effort,
        signal: ctx.mcpReq.signal,
      }));
      const workerId = typeof result.structuredContent.workerId === 'string' ? result.structuredContent.workerId : undefined;
      if (!workerId || result.isError) return normalizeManagedResult(compactPlanStart(result, run, planId));

      let selectedProject = selection.project;
      let projectRegistry = registryBefore;
      let projectWarning: string | undefined;
      if (selection.projectLaunch.kind === 'new') {
        const discovered = await discoverCreatedProject(run.cwd, beforeIds);
        selectedProject = discovered.project;
        projectRegistry = discovered.registry;
        projectWarning = discovered.warning;
      }
      const metadata = projectMetadata(selection, selectedProject, projectRegistry);
      const persistenceError = await persistProjectMetadata(runtime, workerId, metadata);
      Object.assign(result.structuredContent, metadata);
      if (projectWarning) result.structuredContent.projectWarning = projectWarning;
      if (persistenceError) result.structuredContent.projectPersistenceError = persistenceError;
      result = await decorateProjectMetadata(result, runtime);
      run = await runStore.attachPlanWorker({
        runId: run.runId,
        planId,
        workerId,
        conversationId: typeof result.structuredContent.conversationId === 'string' ? result.structuredContent.conversationId : undefined,
        idempotencyKey,
        baselineId,
        agyProjectId: typeof result.structuredContent.agyProjectId === 'string' ? result.structuredContent.agyProjectId : undefined,
        model: selection.model,
        effort: selection.effort,
      });
      result.structuredContent.blueprintCaptured = !runId;
      result.structuredContent.promptBuiltServerSide = true;
      return normalizeManagedResult(compactPlanStart(result, run, planId));
    },
  );

  const findingSchema = z.object({
    file: z.string().min(1).max(500).optional(),
    symbol: z.string().min(1).max(500).optional(),
    problem: z.string().min(1).max(8_000),
    expected: z.string().min(1).max(8_000).optional(),
    rationale: z.string().min(1).max(8_000).optional(),
  });

  server.registerTool(
    'agy_followup',
    {
      title: 'Follow Up Antigravity Worker',
      description: 'Launch a correction/resume turn on an existing worker. PLAN findings and retry recovery are reconstructed server-side so Codex does not repeat the approved PLAN.',
      inputSchema: z.object({
        workerId: z.string().min(1),
        prompt: z.string().min(1).max(100_000).optional().describe('Standalone-worker follow-up prompt. Do not use this to repeat an approved PLAN.'),
        findings: z.array(findingSchema).min(1).max(50).optional().describe('Supervisor findings for a PLAN-bound worker; MCP rebuilds the correction prompt server-side.'),
        resume: z.boolean().optional().describe('Set true only to resume a terminal retryable PLAN-bound worker after reviewing its workspace delta.'),
        idempotencyKey: z.string().min(1).max(200).optional().describe('Stable retry key. PLAN findings/resume derive stable keys automatically when omitted.'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: true },
    },
    async ({ workerId, prompt, findings, resume, idempotencyKey, timeoutSeconds }, ctx) => {
      const modes = Number(Boolean(prompt)) + Number(Boolean(findings)) + Number(resume === true);
      if (modes !== 1) {
        return textError('Provide exactly one of prompt (standalone), findings (PLAN correction), or resume=true (retryable PLAN recovery).', 'FOLLOWUP_INPUT_INVALID');
      }
      let resolvedPrompt = prompt;
      let resolvedKey = idempotencyKey;
      let runBinding: { run: ExecutionRunRecord; planId: string } | undefined;

      if (findings || resume === true) {
        runBinding = await runStore.findByWorkerId(workerId);
        if (!runBinding) return textError('Structured findings/resume require a PLAN-bound worker.', 'PLAN_WORKER_NOT_FOUND');
        try {
          const stored = await blueprintStore.read(runBinding.run.blueprintId);
          const plan = findPlan(stored.blueprint, runBinding.planId);
          if (resume === true) {
            const current = normalizeManagedResult(await runtime.result(workerId));
            if (isRunningResult(current)) return textError('Cannot resume a PLAN worker while its current turn is still running.', 'PLAN_RESUME_RUNNING');
            if (current.structuredContent.done !== true || current.structuredContent.retryable !== true) {
              return textError('resume=true requires a terminal retryable PLAN worker result.', 'PLAN_RESUME_NOT_RETRYABLE');
            }
            resolvedPrompt = buildResumePrompt(plan);
            const record = await runtime.store.read(workerId);
            const turnIdentity = record?.lastTurnCompletedAt ?? record?.updatedAt ?? String(current.structuredContent.failureKind ?? 'retryable');
            resolvedKey ??= `${runBinding.run.runId}:${runBinding.planId}:resume:${createHash('sha256').update(turnIdentity).digest('hex').slice(0, 12)}`;
          } else {
            resolvedPrompt = buildCorrectionPrompt(plan, findings as ReviewFinding[]);
            resolvedKey ??= `${runBinding.run.runId}:${runBinding.planId}:fix:${createHash('sha256').update(JSON.stringify(findings)).digest('hex').slice(0, 12)}`;
          }
        } catch (error) {
          return textError(error instanceof Error ? error.message : String(error), 'PLAN_CORRECTION_CONTEXT_FAILED');
        }
      }

      const result = await runtime.followup({
        workerId,
        prompt: resolvedPrompt!,
        idempotencyKey: resolvedKey,
        timeoutSeconds,
        signal: ctx.mcpReq.signal,
      });
      let decorated = normalizeManagedResult(await decorateProjectMetadata(result, runtime));
      if (runBinding) {
        decorated.structuredContent.promptBuiltServerSide = true;
        attachRunMetadata(decorated, runBinding.run, runBinding.planId);
        if (isRunningResult(decorated) && decorated.content[0]) {
          const mode = resume === true ? 'resume' : 'correction';
          decorated.content[0].text = `Started ${mode} for ${runBinding.planId} (worker=${workerId}, run=${runBinding.run.runId}). Use agy_wait.`;
        }
        return decorated;
      }
      decorated = compactStandaloneStart(decorated);
      return decorated;
    },
  );

  server.registerTool(
    'agy_wait',
    {
      title: 'Wait for Antigravity Worker',
      description: 'Passively wait inside MCP for the latest worker turn to finish. Timeout/cancellation of the waiter never cancels the AGY worker.',
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
          const binding = await runStore.findByWorkerId(workerId);
          const normalized = normalizeManagedResult(binding ? attachRunMetadata(result, binding.run, binding.planId) : result);
          return annotatePlanTerminalRecovery(normalized, binding);
        }
        if (ctx.mcpReq.signal.aborted) {
          result = annotateWaitExit(result, workerId, 'canceled');
          result = await decorateProjectMetadata(result, runtime);
          const binding = await runStore.findByWorkerId(workerId);
          return normalizeManagedResult(binding ? attachRunMetadata(result, binding.run, binding.planId) : result);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          result = annotateWaitExit(result, workerId, 'timeout');
          result = await decorateProjectMetadata(result, runtime);
          const binding = await runStore.findByWorkerId(workerId);
          return normalizeManagedResult(binding ? attachRunMetadata(result, binding.run, binding.planId) : result);
        }
        const waited = await waitDelay(Math.min(WAIT_POLL_MS, remaining), ctx.mcpReq.signal);
        if (!waited) {
          result = annotateWaitExit(result, workerId, 'canceled');
          result = await decorateProjectMetadata(result, runtime);
          const binding = await runStore.findByWorkerId(workerId);
          return normalizeManagedResult(binding ? attachRunMetadata(result, binding.run, binding.planId) : result);
        }
      }
    },
  );

  server.registerTool(
    'agy_review_plan',
    {
      title: 'Prepare PLAN Review Evidence',
      description: 'Build compact deterministic evidence for a PLAN-bound worker: baseline delta, scope checks, preservation checks, and canonical validation. Diff text is omitted by default and included only when includeDiff=true.',
      inputSchema: z.object({
        runId: z.string().regex(/^run_[A-Za-z0-9-]{8,}$/),
        planId: z.string().regex(/^PLAN-\d{2,}$/),
        validationTimeoutSeconds: z.number().int().min(1).max(1800).default(900),
        includeDiff: z.boolean().default(false).describe('Include the bounded owned-path diff in tool text; default false to keep Codex context compact.'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ runId, planId, validationTimeoutSeconds, includeDiff }, ctx) => {
      let run: ExecutionRunRecord;
      try {
        run = await runStore.read(runId);
        const stored = await blueprintStore.read(run.blueprintId);
        const plan = findPlan(stored.blueprint, planId);
        const state = run.plans[planId];
        if (!state?.workerId || !state.baselineId) {
          return textError(`${planId} has no registered PLAN worker/baseline in ${runId}.`, 'PLAN_NOT_STARTED');
        }
        const workerState = normalizeManagedResult(await runtime.result(state.workerId));
        if (isRunningResult(workerState)) {
          return textError(`${planId} worker ${state.workerId} is still running; wait before review.`, 'PLAN_STILL_RUNNING');
        }
        const bundle = await buildPlanReviewBundle({
          cwd: run.cwd,
          plan,
          baselineDir: runStore.baselineDir(runId, planId),
          baselineId: state.baselineId,
          validationTimeoutSeconds,
          includeDiff,
          signal: ctx.mcpReq.signal,
        });
        const hasOwnedDelta = bundle.changedFiles.length > 0;
        const workerFailureKind = typeof workerState.structuredContent.failureKind === 'string'
          ? workerState.structuredContent.failureKind
          : 'unknown';
        const workerRetryable = workerState.structuredContent.retryable === true;
        const validationSummary = bundle.validation.skipped
          ? `SKIPPED (${bundle.validation.skippedReason ?? 'unspecified'})`
          : bundle.validation.exitCode === 0 && !bundle.validation.timedOut && !bundle.validation.canceled && !bundle.validation.launchError
            ? 'PASS (exit=0)'
            : `FAIL (exit=${String(bundle.validation.exitCode)}, timedOut=${bundle.validation.timedOut}, canceled=${bundle.validation.canceled})`;
        const lines = [
          `PLAN REVIEW: ${planId}`,
          `Run: ${runId}`,
          `Mechanical: ${bundle.mechanicalStatus.toUpperCase()}`,
          `Worker terminal: ${workerFailureKind}${workerRetryable ? ' (retryable)' : ''}`,
          `Owned delta: ${hasOwnedDelta ? 'yes' : 'no'}`,
          `Changed files: ${bundle.changedFiles.length ? bundle.changedFiles.join(', ') : '(none)'}`,
          `Unauthorized: ${bundle.unauthorizedChanges.length ? bundle.unauthorizedChanges.join(', ') : '(none)'}`,
          `Forbidden: ${bundle.forbiddenChanges.length ? bundle.forbiddenChanges.join(', ') : '(none)'}`,
          `Pre-existing outside-scope modified: ${bundle.preExistingOutsideScopeModified.length ? bundle.preExistingOutsideScopeModified.join(', ') : '(none)'}`,
          `Validation: ${validationSummary}`,
          `Diff included: ${bundle.diffIncluded ? 'yes' : 'no'}`,
        ];
        if (bundle.validation.output) {
          lines.push('', 'VALIDATION FAILURE TAIL', bundle.validation.output);
        }
        if (bundle.diffIncluded) {
          lines.push('', 'WORKSPACE DELTA', bundle.diff || '(No owned-path content delta detected.)');
        }
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            runId,
            blueprintId: run.blueprintId,
            planId,
            workerId: state.workerId,
            mechanicalStatus: bundle.mechanicalStatus,
            workerFailureKind,
            workerRetryable,
            hasOwnedDelta,
            changedFiles: bundle.changedFiles,
            unauthorizedChanges: bundle.unauthorizedChanges,
            forbiddenChanges: bundle.forbiddenChanges,
            preExistingOutsideScopeModified: bundle.preExistingOutsideScopeModified,
            diffIncluded: bundle.diffIncluded,
            diffTruncated: bundle.diffTruncated,
            diffIncomplete: bundle.diffIncomplete,
            validationSkipped: bundle.validation.skipped,
            validationSkippedReason: bundle.validation.skippedReason,
            validationExitCode: bundle.validation.exitCode,
            validationTimedOut: bundle.validation.timedOut,
            validationCanceled: bundle.validation.canceled,
            validationOutputTruncated: bundle.validation.outputTruncated,
            validationLaunchError: bundle.validation.launchError,
          },
          isError: false,
        };
      } catch (error) {
        return textError(error instanceof Error ? error.message : String(error), 'PLAN_REVIEW_FAILED');
      }
    },
  );

  server.registerTool(
    'agy_status',
    {
      title: 'Antigravity Worker Status',
      description: 'Inspect one managed worker or list persisted active/recoverable workers, including Project binding, timeout/cancel and duplicate-worker metadata.',
      inputSchema: z.object({ workerId: z.string().min(1).optional(), includeClosed: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId, includeClosed }) => {
      const result = await decorateProjectMetadata(await runtime.status(workerId, includeClosed), runtime);
      if (workerId) {
        const binding = await runStore.findByWorkerId(workerId);
        if (binding) return attachRunMetadata(result, binding.run, binding.planId);
      }
      return result;
    },
  );

  server.registerTool(
    'agy_cancel',
    {
      title: 'Cancel Antigravity Worker Turn',
      description: 'Interrupt the active background turn for a managed worker without deleting its recoverable Antigravity conversation.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => {
      const result = await decorateProjectMetadata(await runtime.cancel(workerId), runtime);
      const binding = await runStore.findByWorkerId(workerId);
      return binding ? attachRunMetadata(result, binding.run, binding.planId) : result;
    },
  );

  server.registerTool(
    'agy_close',
    {
      title: 'Close Antigravity Worker',
      description: 'Close a managed worker and retain its local audit metadata plus Antigravity conversation/Project binding. When all workers in a PLAN run close, temporary baseline snapshots are deleted.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => {
      const result = await decorateProjectMetadata(await runtime.close(workerId), runtime);
      const closed = await runStore.markWorkerClosed(workerId);
      if (closed) {
        attachRunMetadata(result, closed.run, (await runStore.findByWorkerId(workerId))?.planId ?? '');
        if (closed.allClosed) {
          await runStore.cleanupBaselines(closed.run.runId).catch((error) => {
            result.structuredContent.baselineCleanupError = error instanceof Error ? error.message : String(error);
          });
          result.structuredContent.baselinesCleaned = closed.allClosed && !result.structuredContent.baselineCleanupError;
        }
      }
      return result;
    },
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

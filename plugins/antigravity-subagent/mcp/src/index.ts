import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import {
  buildOneShotArgs,
  chooseModelAndEffort,
  findAgy,
  probeAgyCapabilities,
  runAgy,
  type Effort,
  type RunMode,
} from './cli.js';
import { WorkerRuntime } from './runtime.js';

const VERSION = '0.3.0';
const MAX_RESPONSE_BYTES = 64 * 1024;

function clipResponse(text: string): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= MAX_RESPONSE_BYTES) return { text, truncated: false };
  return {
    text: `${encoded.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')}\n\n[Response truncated at 64 KiB]`,
    truncated: true,
  };
}

async function resolveWorkspace(cwd: string): Promise<{ cwd: string } | { error: string }> {
  const resolved = path.resolve(cwd);
  try {
    await access(resolved, constants.R_OK);
    return { cwd: resolved };
  } catch {
    return { error: `Workspace is not accessible: ${resolved}` };
  }
}

function createServer(): McpServer {
  const runtime = new WorkerRuntime();
  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Use agy_check before first delegation. Use agy_start for resumable work, agy_followup for review corrections, agy_status to inspect managed workers, agy_cancel to stop an active turn, and agy_close after review passes. Verify delegated output and workspace changes independently.',
    },
  );

  server.registerTool(
    'agy_check',
    {
      title: 'Check Antigravity CLI',
      description: 'Verify the Google Antigravity CLI installation and report capabilities used by this plugin.',
      inputSchema: z.object({
        refresh: z.boolean().default(false).describe('Bypass short-lived CLI/model capability caches'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ refresh }) => {
      const executable = await findAgy(refresh);
      if (!executable) {
        return {
          content: [{ type: 'text', text: 'Antigravity CLI was not found. Install the official `agy` CLI and authenticate it first.' }],
          isError: true,
        };
      }
      const report = await probeAgyCapabilities(executable, refresh);
      const capabilityEntries = Object.entries(report.capabilities);
      const streamingEntries = Object.entries(report.streaming);
      const missing = capabilityEntries.filter(([, supported]) => !supported).map(([name]) => name);
      const lines = [
        `Antigravity CLI is available at: ${executable}`,
        report.version ? `Version: ${report.version}` : 'Version: unknown',
        `Capabilities: ${capabilityEntries.map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
        `Streaming: ${streamingEntries.map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
      ];
      if (report.modelCount !== undefined) lines.push(`Models: ${report.modelCount} variants across ${report.baseModelCount ?? report.modelCount} base models`);
      if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.join(' | ')}`);
      if (missing.length > 0) lines.push(`Missing capabilities: ${missing.join(', ')}`);
      const recoveryWarnings = runtime.getRecoveryWarnings();
      if (recoveryWarnings.length > 0) lines.push(`Worker recovery warnings: ${recoveryWarnings.join(' | ')}`);
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
          workerRecoveryWarnings: recoveryWarnings,
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
        mode: z.enum(['plan', 'default', 'accept-edits']).default('plan'),
        outputFormat: z.enum(['text', 'json']).default('text'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false },
    },
    async ({ prompt, cwd, mode, outputFormat, timeoutSeconds, agent, model, effort }, ctx) => {
      const executable = await findAgy();
      if (!executable) return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check first.' }], isError: true };
      const workspace = await resolveWorkspace(cwd);
      if ('error' in workspace) return { content: [{ type: 'text', text: workspace.error }], isError: true };
      const selection = await chooseModelAndEffort(ctx, executable, workspace.cwd, model, effort);
      if ('error' in selection) return { content: [{ type: 'text', text: selection.error }], isError: true };

      const result = await runAgy(
        executable,
        buildOneShotArgs(prompt, {
          cwd: workspace.cwd,
          mode: mode as RunMode,
          agent,
          model: selection.model,
          effort: selection.effort as Effort,
        }, undefined, outputFormat),
        workspace.cwd,
        timeoutSeconds * 1000,
        { signal: ctx.mcpReq.signal },
      );
      const raw = result.timedOut
        ? `Antigravity timed out after ${timeoutSeconds} seconds.`
        : result.canceled
          ? 'Antigravity request was canceled.'
          : result.stdout.trim() || result.stderr.trim() || '(Antigravity returned no output)';
      const clipped = clipResponse(raw);
      return {
        content: [{ type: 'text', text: clipped.text }],
        structuredContent: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          canceled: result.canceled,
          truncated: result.truncated || clipped.truncated,
          mode,
          cwd: workspace.cwd,
          model: selection.model,
          effort: selection.effort,
        },
        isError: result.timedOut || result.canceled || result.exitCode !== 0,
      };
    },
  );

  server.registerTool(
    'agy_start',
    {
      title: 'Start Antigravity Worker',
      description: 'Start a named resumable Antigravity worker. The worker is persisted and can be recovered after MCP/Codex restart.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000),
        name: z.string().min(1).max(120).optional().describe('Friendly plan/worker name for the local worker ledger'),
        cwd: z.string().min(1),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('accept-edits'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false },
    },
    async ({ prompt, name, cwd, mode, timeoutSeconds, agent, model, effort }, ctx) => {
      const executable = await findAgy();
      if (!executable) return { content: [{ type: 'text', text: 'Antigravity CLI was not found. Run agy_check first.' }], isError: true };
      const workspace = await resolveWorkspace(cwd);
      if ('error' in workspace) return { content: [{ type: 'text', text: workspace.error }], isError: true };
      const selection = await chooseModelAndEffort(ctx, executable, workspace.cwd, model, effort);
      if ('error' in selection) return { content: [{ type: 'text', text: selection.error }], isError: true };
      return await runtime.start({
        prompt,
        name,
        cwd: workspace.cwd,
        mode: mode as RunMode,
        timeoutSeconds,
        agent,
        model: selection.model,
        effort: selection.effort as Effort,
        signal: ctx.mcpReq.signal,
      });
    },
  );

  server.registerTool(
    'agy_followup',
    {
      title: 'Follow Up Antigravity Worker',
      description: 'Send review feedback or a correction to an existing worker. Warm workers reuse the same process; recovered workers resume the exact conversation.',
      inputSchema: z.object({
        workerId: z.string().min(1),
        prompt: z.string().min(1).max(100_000),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false },
    },
    async ({ workerId, prompt, timeoutSeconds }, ctx) => runtime.followup({
      workerId,
      prompt,
      timeoutSeconds,
      signal: ctx.mcpReq.signal,
    }),
  );

  server.registerTool(
    'agy_status',
    {
      title: 'Antigravity Worker Status',
      description: 'Inspect one managed worker or list recoverable/active workers without reading prompt or response content.',
      inputSchema: z.object({
        workerId: z.string().min(1).optional(),
        includeClosed: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId, includeClosed }) => runtime.status(workerId, includeClosed),
  );

  server.registerTool(
    'agy_cancel',
    {
      title: 'Cancel Antigravity Worker Turn',
      description: 'Cancel the active turn for a managed worker while preserving its conversation for later recovery.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => runtime.cancel(workerId),
  );

  server.registerTool(
    'agy_close',
    {
      title: 'Close Antigravity Worker',
      description: 'Close a managed worker after review passes. Its ledger history and Antigravity conversation remain available for audit.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => runtime.close(workerId),
  );

  void runtime.ensureRecovered();
  return server;
}

void serveStdio(createServer);
console.error(`agy MCP server ${VERSION} running on stdio`);

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

const VERSION = '0.4.0';

async function createServer(): Promise<McpServer> {
  const runtime = new WorkerRuntime();
  await runtime.ensureRecovered();

  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Use agy_check before first delegation. Prefer agy_start for implementation work, pass a friendly plan-step name, review delegated changes independently, use agy_status when recovery/state matters, use agy_followup for corrections, agy_cancel to interrupt an active turn without closing the conversation, and agy_close only after the worker passes review.',
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
      const lines = [
        `Antigravity CLI is available at: ${executable}`,
        report.version ? `Version: ${report.version}` : 'Version: unknown',
        `Capabilities: ${requiredEntries.map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
        `Streaming: ${Object.entries(report.streaming).map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`).join(', ')}`,
      ];
      if (report.modelCount !== undefined) lines.push(`Models: ${report.modelCount} variants across ${report.baseModelCount ?? report.modelCount} base models`);
      const warnings = [...report.warnings, ...runtime.getRecoveryWarnings()];
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
      const resolvedCwd = path.resolve(cwd);
      try { await access(resolvedCwd, constants.R_OK); } catch {
        return { content: [{ type: 'text', text: `Workspace is not accessible: ${resolvedCwd}` }], isError: true };
      }
      const selection = await chooseModelAndEffort(ctx, executable, resolvedCwd, model, effort);
      if ('error' in selection) return { content: [{ type: 'text', text: selection.error }], isError: true };
      const execution = { cwd: resolvedCwd, mode: mode as RunMode, agent, model: selection.model, effort: selection.effort as Effort };
      try {
        const result = await runAgy(
          executable,
          buildOneShotArgs(prompt, execution, undefined, outputFormat),
          resolvedCwd,
          timeoutSeconds * 1000,
          { signal: ctx.mcpReq.signal },
        );
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
      description: 'Start a persistent/resumable managed Antigravity worker.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000),
        name: z.string().min(1).max(120).optional().describe('Friendly plan-step name stored only in the local worker ledger'),
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
      const resolvedCwd = path.resolve(cwd);
      try { await access(resolvedCwd, constants.R_OK); } catch {
        return { content: [{ type: 'text', text: `Workspace is not accessible: ${resolvedCwd}` }], isError: true };
      }
      const selection = await chooseModelAndEffort(ctx, executable, resolvedCwd, model, effort);
      if ('error' in selection) return { content: [{ type: 'text', text: selection.error }], isError: true };
      return await runtime.start({
        prompt,
        name,
        cwd: resolvedCwd,
        mode,
        timeoutSeconds,
        agent,
        model: selection.model,
        effort: selection.effort,
        signal: ctx.mcpReq.signal,
      });
    },
  );

  server.registerTool(
    'agy_followup',
    {
      title: 'Follow Up Antigravity Worker',
      description: 'Send review feedback to an existing managed worker, recovering its saved conversation after restart when necessary.',
      inputSchema: z.object({
        workerId: z.string().min(1),
        prompt: z.string().min(1).max(100_000),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false },
    },
    async ({ workerId, prompt, timeoutSeconds }, ctx) => runtime.followup({ workerId, prompt, timeoutSeconds, signal: ctx.mcpReq.signal }),
  );

  server.registerTool(
    'agy_status',
    {
      title: 'Antigravity Worker Status',
      description: 'Inspect one managed worker or list persisted active/recoverable workers.',
      inputSchema: z.object({ workerId: z.string().min(1).optional(), includeClosed: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId, includeClosed }) => runtime.status(workerId, includeClosed),
  );

  server.registerTool(
    'agy_cancel',
    {
      title: 'Cancel Antigravity Worker Turn',
      description: 'Interrupt the active turn for a managed worker without deleting its recoverable Antigravity conversation.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => runtime.cancel(workerId),
  );

  server.registerTool(
    'agy_close',
    {
      title: 'Close Antigravity Worker',
      description: 'Close a managed worker and retain its local ledger record plus Antigravity conversation for audit.',
      inputSchema: z.object({ workerId: z.string().min(1) }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workerId }) => runtime.close(workerId),
  );

  return server;
}

process.stderr.write(`agy MCP server ${VERSION} running on stdio\n`);
await serveStdio(() => createServer());

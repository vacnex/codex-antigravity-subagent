import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const VERSION = '0.2.0';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

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

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Use agy_check before first delegation. Default agy_delegate to plan mode. Verify delegated output and workspace changes independently.',
    },
  );

  server.registerTool(
    'agy_check',
    {
      title: 'Check Antigravity CLI',
      description: 'Verify that Google Antigravity CLI is installed and return its executable path.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
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
      description: 'Run one bounded prompt through Google Antigravity CLI in non-interactive print mode and return the result.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000).describe('Complete bounded task prompt'),
        cwd: z.string().min(1).describe('Absolute existing workspace directory'),
        mode: z.enum(['plan', 'default', 'accept-edits']).default('plan'),
        outputFormat: z.enum(['text', 'json']).default('text'),
        timeoutSeconds: z.number().int().min(1).max(1800).default(900),
        agent: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ prompt, cwd, mode, outputFormat, timeoutSeconds, agent, model }) => {
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

      const args = ['--print', prompt, '--output-format', outputFormat, '--mode', mode];
      if (agent) args.push('--agent', agent);
      if (model) args.push('--model', model);

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

  return server;
}

void serveStdio(createServer);
console.error(`agy MCP server ${VERSION} running on stdio`);

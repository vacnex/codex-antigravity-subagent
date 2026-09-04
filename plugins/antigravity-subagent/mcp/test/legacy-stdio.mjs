import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '../..');
const config = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'));
const server = config.mcpServers?.agy;
assert.ok(server, 'Plugin .mcp.json must define the agy MCP server');
assert.equal(typeof server.command, 'string');
assert.ok(Array.isArray(server.args));

const launchCwd = path.resolve(pluginRoot, server.cwd ?? '.');
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-legacy-state-'));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
childEnv.AGY_MCP_STATE_DIR = stateDir;
childEnv.AGY_MCP_IDLE_DRIVER_MS = '600000';

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function probeLegacyInitialize(protocolVersion) {
  const child = spawn(server.command, server.args, {
    cwd: launchCwd,
    env: childEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdoutBuffer = '';
  let settled = false;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const responsePromise = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn plugin MCP server: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Plugin MCP server closed before initialize response (code=${code}, signal=${signal}). stderr:\n${stderr || '(empty)'}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          if (settled) return;
          settled = true;
          reject(new Error(`Non-JSON stdout before initialize response: ${line}\n${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (message.id === 1) {
          if (settled) return;
          settled = true;
          resolve(message);
          return;
        }
      }
    });
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'codex-legacy-handshake-smoke', version: '1.0.0' },
    },
  })}\n`);

  try {
    const response = await withTimeout(
      responsePromise,
      10_000,
      `Timed out waiting for legacy initialize response (${protocolVersion}). stderr:\n${stderr || '(empty)'}`,
    );
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(response.result, `Initialize returned an error: ${JSON.stringify(response)}`);
    assert.equal(response.result.serverInfo?.name, 'agy-mcp-server');
    assert.equal(response.result.serverInfo?.version, '0.4.0');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } finally {
    child.stdin.end();
    await withTimeout(
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('close', resolve);
      }),
      3_000,
      'Plugin MCP server did not exit after stdin closed',
    ).catch(() => child.kill());
  }
}

try {
  for (const version of ['2025-06-18', '2025-11-25']) {
    await probeLegacyInitialize(version);
  }
  console.error('Codex legacy stdio handshake test passed');
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

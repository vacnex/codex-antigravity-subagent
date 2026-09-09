import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const pluginRoot = path.resolve(mcpRoot, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-v054-hardening-'));
const bundleRoot = path.join(tempRoot, 'bundles');
await mkdir(bundleRoot, { recursive: true });

async function loadSourceModule(name) {
  const outfile = path.join(bundleRoot, `${name}.mjs`);
  await build({
    entryPoints: [path.join(mcpRoot, 'src', `${name}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}-${Math.random()}`);
}

try {
  const packageJson = JSON.parse(await readFile(path.join(mcpRoot, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(await readFile(path.join(mcpRoot, 'package-lock.json'), 'utf8'));
  const pluginJson = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcpConfig = await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8');
  const indexSource = await readFile(path.join(mcpRoot, 'src', 'index.ts'), 'utf8');
  const driverSource = await readFile(path.join(mcpRoot, 'src', 'driver.ts'), 'utf8');
  const planReviewSource = await readFile(path.join(mcpRoot, 'src', 'plan-review.ts'), 'utf8');
  const readme = await readFile(path.join(path.resolve(pluginRoot, '..', '..'), 'README.md'), 'utf8');
  const changelog = await readFile(path.join(path.resolve(pluginRoot, '..', '..'), 'CHANGELOG.md'), 'utf8');

  assert.equal(packageJson.version, '0.5.4');
  assert.equal(pluginJson.version, packageJson.version);
  assert.equal(lockJson.version, packageJson.version);
  assert.equal(lockJson.packages[''].version, packageJson.version);
  assert.deepEqual(lockJson.packages[''].dependencies, packageJson.dependencies);
  assert.deepEqual(lockJson.packages[''].devDependencies, packageJson.devDependencies);
  assert.equal(packageJson.scripts['test:plan-review'], 'node test/plan-review.mjs');
  assert.equal(packageJson.scripts['test:v054-hardening'], 'node test/v054-hardening.mjs');
  assert.match(packageJson.scripts['test:protocol'], /test:plan-review/);
  assert.match(packageJson.scripts['test:protocol'], /test:v054-hardening/);
  assert.match(mcpConfig, /"tool_timeout_sec"\s*:\s*2100/);

  assert.match(indexSource, /WAIT_DEFAULT_SECONDS\s*=\s*2_000/);
  assert.match(indexSource, /WAIT_MAX_SECONDS\s*=\s*2_000/);
  assert.match(indexSource, /notifications\/progress/);
  assert.match(indexSource, /waitTimedOut/);
  assert.match(driverSource, /DEFAULT_INACTIVITY_TIMEOUT_MS\s*=\s*10\s*\*\s*60_000/);
  assert.match(driverSource, /timeoutKind/);
  assert.match(planReviewSource, /preflightCanonicalValidation/);
  assert.match(planReviewSource, /validationEnvironment/);
  assert.doesNotMatch(indexSource, /MCP Tasks|tasks\/get|tasks\/result/i);

  const resultModule = await loadSourceModule('result-semantics');
  const cliModule = await loadSourceModule('cli');
  const partialSuccess = resultModule.normalizeManagedResult({
    content: [{ type: 'text', text: '[agy] print timeout after 5m0s with turn in progress; returning partial output' }],
    structuredContent: { done: true, transport: 'stream', status: 'SUCCESS' },
    isError: false,
  });
  assert.equal(partialSuccess.structuredContent.failureKind, 'agy_response_timeout');
  assert.equal(partialSuccess.structuredContent.retryable, true);
  assert.equal(partialSuccess.structuredContent.reportAvailable, false);
  assert.equal(partialSuccess.isError, false);

  const capabilities = cliModule.detectAgyCliCapabilities('--mode <mode>\n--print-timeout <duration>');
  assert.equal(capabilities.printTimeout, true);
  const persistentArgs = cliModule.buildPersistentArgs({
    cwd: tempRoot,
    mode: 'accept-edits',
    model: 'gemini-test',
    effort: 'medium',
  }, undefined, '30m');
  assert.deepEqual(persistentArgs.slice(persistentArgs.indexOf('--print-timeout'), persistentArgs.indexOf('--print-timeout') + 2), ['--print-timeout', '30m']);

  assert.match(readme, /0\.5\.4/);
  assert.match(readme, /2000/);
  assert.match(changelog, /^## 0\.5\.4/m);
  assert.match(changelog, /print-timeout/i);

  console.error('v0.5.4 hardening regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

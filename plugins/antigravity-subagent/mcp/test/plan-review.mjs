import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-plan-review-'));
const bundlePath = path.join(tempRoot, 'plan-review.mjs');

try {
  await build({
    entryPoints: [path.join(mcpRoot, 'src', 'plan-review.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  const review = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);

  const quoted = `"${process.execPath}" -e "if (process.platform === 'win32' && process.env.OS !== 'Windows_NT') process.exit(2)"`;
  assert.deepEqual(review.parseDirectCommand(quoted), {
    executable: process.execPath,
    args: ['-e', "if (process.platform === 'win32' && process.env.OS !== 'Windows_NT') process.exit(2)"],
  });
  assert.equal(review.validationEnvironment('win32', {}).OS, 'Windows_NT');
  assert.equal(review.validationEnvironment('win32', { OS: 'custom' }).OS, 'custom');

  const missing = path.join(tempRoot, 'missing-validation.exe');
  await assert.rejects(
    () => review.preflightCanonicalValidation(`\`\`\`text\n"${missing}"\n\`\`\``),
    /VALIDATION_EXECUTABLE_NOT_FOUND/,
  );
  await review.preflightCanonicalValidation(`\`\`\`text\n"${process.execPath}" -e "process.exit(0)"\n\`\`\``);

  console.error('PLAN-02 plan-review regression test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

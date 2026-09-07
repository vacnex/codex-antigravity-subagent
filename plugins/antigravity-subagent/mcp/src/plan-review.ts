import { spawn } from 'node:child_process';

import { extractValidationCommand, type BlueprintPlan } from './blueprint.js';
import { reviewPlanBaseline, type PlanMechanicalReview } from './git-baseline.js';

const VALIDATION_OUTPUT_LIMIT = 64 * 1024;

export type ValidationResult = {
  command?: string;
  skipped: boolean;
  exitCode?: number | null;
  timedOut: boolean;
  canceled: boolean;
  output: string;
};

export type PlanReviewBundle = PlanMechanicalReview & {
  validation: ValidationResult;
  mechanicalStatus: 'pass' | 'fail';
};

async function runValidationCommand(
  cwd: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  return await new Promise<ValidationResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let canceled = false;
    let settled = false;

    const append = (chunk: Buffer): void => {
      if (bytes >= VALIDATION_OUTPUT_LIMIT) return;
      const remaining = VALIDATION_OUTPUT_LIMIT - bytes;
      const slice = chunk.subarray(0, remaining);
      chunks.push(slice);
      bytes += slice.length;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let output = Buffer.concat(chunks).toString('utf8');
      if (bytes >= VALIDATION_OUTPUT_LIMIT) output += '\n[Validation output truncated by MCP limit.]\n';
      resolve({ command, skipped: false, exitCode, timedOut, canceled, output });
    };

    const terminate = (): void => {
      if (!child.killed) child.kill();
    };
    const onAbort = (): void => {
      canceled = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1000);

    child.once('error', (error) => {
      append(Buffer.from(`Failed to launch validation: ${error.message}\n`, 'utf8'));
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}

export async function buildPlanReviewBundle(input: {
  cwd: string;
  plan: BlueprintPlan;
  baselineDir: string;
  baselineId: string;
  validationTimeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<PlanReviewBundle> {
  const mechanical = await reviewPlanBaseline(input.cwd, input.plan, input.baselineDir, input.baselineId);
  const command = extractValidationCommand(input.plan.canonicalValidation);
  const validation = command
    ? await runValidationCommand(input.cwd, command, input.validationTimeoutSeconds, input.signal)
    : { skipped: true, timedOut: false, canceled: false, output: '' } satisfies ValidationResult;

  const validationFailed = !validation.skipped
    && (validation.exitCode !== 0 || validation.timedOut || validation.canceled);
  const scopeFailed = mechanical.unauthorizedChanges.length > 0
    || mechanical.forbiddenChanges.length > 0
    || mechanical.preExistingOutsideScopeModified.length > 0;

  return {
    ...mechanical,
    validation,
    mechanicalStatus: validationFailed || scopeFailed ? 'fail' : 'pass',
  };
}

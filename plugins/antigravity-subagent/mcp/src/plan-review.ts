import { spawn } from 'node:child_process';

import { extractValidationCommand, type BlueprintPlan } from './blueprint.js';
import { reviewPlanBaseline, type PlanMechanicalReview } from './git-baseline.js';

const VALIDATION_FAILURE_OUTPUT_LIMIT = 12 * 1024;

export type ValidationResult = {
  command?: string;
  skipped: boolean;
  skippedReason?: 'no_command' | 'no_owned_delta';
  exitCode?: number | null;
  timedOut: boolean;
  canceled: boolean;
  output: string;
  outputTruncated: boolean;
  launchError?: string;
};

export type PlanReviewBundle = PlanMechanicalReview & {
  validation: ValidationResult;
  mechanicalStatus: 'pass' | 'fail';
};

export function validationCommandIssue(command: string, platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined;
  const trimmed = command.trim();
  if (!/^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('"')) return undefined;
  const exeEnd = trimmed.toLowerCase().indexOf('.exe');
  if (exeEnd < 0) return undefined;
  const executable = trimmed.slice(0, exeEnd + 4);
  if (!/\s/.test(executable)) return undefined;
  return 'VALIDATION_COMMAND_INVALID: Windows executable paths containing spaces must be double-quoted, for example "D:\\Program Files\\tool.exe" args.';
}

function shellLaunch(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { executable: '/bin/sh', args: ['-lc', command] };
}

async function runValidationCommand(
  cwd: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  const commandIssue = validationCommandIssue(command);
  if (commandIssue) {
    return {
      command,
      skipped: false,
      exitCode: null,
      timedOut: false,
      canceled: false,
      output: commandIssue,
      outputTruncated: false,
      launchError: commandIssue,
    };
  }

  return await new Promise<ValidationResult>((resolve) => {
    const launch = shellLaunch(command);
    const child = spawn(launch.executable, launch.args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let canceled = false;
    let settled = false;

    const append = (chunk: Buffer): void => {
      const combined = Buffer.concat([tail, chunk]);
      if (combined.length <= VALIDATION_FAILURE_OUTPUT_LIMIT) {
        tail = combined;
        return;
      }
      tail = combined.subarray(combined.length - VALIDATION_FAILURE_OUTPUT_LIMIT);
      outputTruncated = true;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (exitCode: number | null, launchError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let output = exitCode === 0 && !timedOut && !canceled && !launchError
        ? ''
        : tail.toString('utf8');
      if (launchError) output = `${launchError}${output ? `\n${output}` : ''}`;
      if (outputTruncated && output) output = `[Validation output tail; earlier output truncated.]\n${output}`;
      resolve({ command, skipped: false, exitCode, timedOut, canceled, output, outputTruncated, launchError });
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
      const message = `Failed to launch validation: ${error.message}`;
      append(Buffer.from(`${message}\n`, 'utf8'));
      finish(null, message);
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
  includeDiff?: boolean;
  signal?: AbortSignal;
}): Promise<PlanReviewBundle> {
  const includeDiff = input.includeDiff === true;
  const mechanical = await reviewPlanBaseline(input.cwd, input.plan, input.baselineDir, input.baselineId, includeDiff);
  const command = extractValidationCommand(input.plan.canonicalValidation);
  const validation: ValidationResult = !command
    ? { skipped: true, skippedReason: 'no_command', timedOut: false, canceled: false, output: '', outputTruncated: false }
    : mechanical.changedFiles.length === 0
      ? { command, skipped: true, skippedReason: 'no_owned_delta', timedOut: false, canceled: false, output: '', outputTruncated: false }
      : await runValidationCommand(input.cwd, command, input.validationTimeoutSeconds, input.signal);

  const validationFailed = !validation.skipped
    && (validation.exitCode !== 0 || validation.timedOut || validation.canceled || Boolean(validation.launchError));
  const scopeFailed = mechanical.unauthorizedChanges.length > 0
    || mechanical.forbiddenChanges.length > 0
    || mechanical.preExistingOutsideScopeModified.length > 0;

  return {
    ...mechanical,
    validation,
    mechanicalStatus: validationFailed || scopeFailed ? 'fail' : 'pass',
  };
}

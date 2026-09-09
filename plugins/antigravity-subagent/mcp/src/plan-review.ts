import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { extractValidationCommand, type BlueprintPlan } from './blueprint.js';
import { reviewPlanBaseline, type PlanMechanicalReview } from './git-baseline.js';

const VALIDATION_FAILURE_OUTPUT_LIMIT = 12 * 1024;
const SHELL_OPERATOR = /[|&;<>\r\n]/;

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

export type DirectCommand = {
  executable: string;
  args: string[];
};

function isAbsoluteExecutable(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

export function validationEnvironment(
  platform = process.platform,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  if (platform === 'win32' && !environment.OS) environment.OS = 'Windows_NT';
  return environment;
}

function assertQuotedWindowsExecutable(trimmed: string): void {
  if (!/^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('"')) return;
  const exeEnd = trimmed.toLowerCase().indexOf('.exe');
  if (exeEnd < 0) return;
  const executableCandidate = trimmed.slice(0, exeEnd + 4);
  if (!/\s/.test(executableCandidate)) return;
  throw new Error('VALIDATION_COMMAND_INVALID: Windows executable paths containing spaces must be double-quoted, for example "D:\\Program Files\\tool.exe" args.');
}

/**
 * Parse the intentionally small canonical-validation command language.
 * It supports ordinary argv plus single/double quoted tokens and rejects shell
 * operators so validation can always run with shell=false on every platform.
 */
export function parseDirectCommand(command: string): DirectCommand {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('VALIDATION_COMMAND_INVALID: canonical validation command is empty.');
  assertQuotedWindowsExecutable(trimmed);

  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: '"' | "'" | undefined;

  const pushToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (quote) {
      if (ch === quote) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (ch === '\\' && trimmed[i + 1] === quote) {
        token += quote;
        tokenStarted = true;
        i += 1;
        continue;
      }
      token += ch;
      tokenStarted = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    if (SHELL_OPERATOR.test(ch)) {
      throw new Error(`VALIDATION_COMMAND_INVALID: shell operator ${JSON.stringify(ch)} is not allowed; use one direct executable command.`);
    }
    token += ch;
    tokenStarted = true;
  }

  if (quote) throw new Error('VALIDATION_COMMAND_INVALID: canonical validation contains an unterminated quote.');
  pushToken();
  if (tokens.length === 0 || !tokens[0]) throw new Error('VALIDATION_COMMAND_INVALID: canonical validation has no executable.');
  return { executable: tokens[0], args: tokens.slice(1) };
}

export function validationCommandIssue(command: string, _platform = process.platform): string | undefined {
  try {
    parseDirectCommand(command);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function preflightCanonicalValidation(section: string): Promise<void> {
  const command = extractValidationCommand(section);
  if (!command) return;
  const launch = parseDirectCommand(command);
  if (!isAbsoluteExecutable(launch.executable)) return;
  try {
    await access(launch.executable, constants.F_OK);
  } catch {
    throw new Error(`VALIDATION_EXECUTABLE_NOT_FOUND: canonical validation executable does not exist: ${launch.executable}`);
  }
}

async function runValidationCommand(
  cwd: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  let launch: DirectCommand;
  try {
    launch = parseDirectCommand(command);
  } catch (error) {
    const launchError = error instanceof Error ? error.message : String(error);
    return {
      command,
      skipped: false,
      exitCode: null,
      timedOut: false,
      canceled: false,
      output: launchError,
      outputTruncated: false,
      launchError,
    };
  }

  return await new Promise<ValidationResult>((resolve) => {
    const child = spawn(launch.executable, launch.args, {
      cwd,
      env: validationEnvironment(),
      windowsHide: true,
      shell: false,
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
  await preflightCanonicalValidation(input.plan.canonicalValidation);
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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Split a command line into argv, honoring double and single quotes. No shell operators. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error(`unterminated quote in: ${command}`);
  if (has || cur) out.push(cur);
  return out;
}

const SHELL_OPERATORS = /(^|\s)(&&|\|\||\||;|>|>>|<)(\s|$)/;

/** Resolve an executable name through PATH/PATHEXT the way a shell would. */
export function resolveExecutable(name: string): string | undefined {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()) : [''];
  const candidates = (base: string) => (isWin && !path.extname(base) ? exts.map((e) => base + e) : [base]);
  if (name.includes('/') || name.includes('\\')) return candidates(name).find((c) => existsSync(c));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const hit = candidates(path.join(dir, name)).find((c) => existsSync(c));
    if (hit) return hit;
  }
  return undefined;
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Run one validation command (no shell composition) and capture output. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  if (SHELL_OPERATORS.test(command)) {
    return Promise.resolve({ code: 1, stdout: '', stderr: `shell operators are not allowed in validate: ${command}`, timedOut: false });
  }
  const [name, ...args] = tokenize(command);
  const exe = resolveExecutable(name);
  if (!exe) return Promise.resolve({ code: 127, stdout: '', stderr: `executable not found: ${name}`, timedOut: false });
  // .cmd/.bat cannot be spawned directly on Windows; route them through cmd.exe with explicit quoting.
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  const file = viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : exe;
  const argv = viaCmd ? ['/d', '/s', '/c', `"${[exe, ...args].map(quoteForCmd).join(' ')}"`] : args;
  return new Promise((resolve) => {
    const child = spawn(file, argv, { cwd, windowsHide: true, windowsVerbatimArguments: viaCmd, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

export function tail(text: string, lines: number): string {
  const all = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}

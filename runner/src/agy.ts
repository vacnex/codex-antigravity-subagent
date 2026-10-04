import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { killTree, resolveExecutable } from './proc.js';

export type AgyUsage = { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; total_tokens?: number };

export type TurnResult = {
  conversationId?: string;
  status: string; // SUCCESS | ERROR | IDLE_TIMEOUT | DEADLINE | CRASH
  response: string;
  error?: string;
  usage?: AgyUsage;
  deniedActions: string[];
  autoResumes: number;
  durationSeconds: number;
  stderrTail: string;
};

export type TurnOptions = {
  agy: string;
  cwd: string;
  prompt: string;
  model: string;
  conversationId?: string;
  logFile: string;
  idleTimeoutMs?: number;
  deadlineMs?: number;
  maxAutoResumes?: number;
};

// Provider-side timeouts: either an ERROR envelope or a SUCCESS carrying the print-timeout marker.
export function isResponseTimeout(text: string): boolean {
  return /timeout waiting for response/i.test(text) || /print timeout after[\s\S]*?with turn in progress/i.test(text);
}

const CONTINUE_PROMPT = `Continue the same PLAN in this conversation; the provider stopped responding mid-turn.
Inspect the current files, keep what is already done, finish only what is missing, then give the final report.`;

/** Locate agy: AGY_PATH, then PATH, then the default per-user install location. */
export function findAgy(): string | undefined {
  if (process.env.AGY_PATH && existsSync(process.env.AGY_PATH)) return process.env.AGY_PATH;
  const onPath = resolveExecutable('agy');
  if (onPath) return onPath;
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  return local && existsSync(local) ? local : undefined;
}

/**
 * Claude desktop may run as an MSIX package on Windows: AppData writes from inside it are
 * virtualized into Packages\<pkg>\LocalCache. A virtual agy copy there shadows the real one.
 */
export function msixShadowCopies(): string[] {
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages');
  if (!base || !existsSync(base)) return [];
  const hits: string[] = [];
  for (const pkg of readdirSync(base)) {
    if (!/claude/i.test(pkg)) continue;
    const p = path.join(base, pkg, 'LocalCache', 'Local', 'agy', 'bin', 'agy.exe');
    if (existsSync(p)) hits.push(p);
  }
  return hits;
}

/** Global agy CLI settings; project-level settings files do not grant command permissions. */
function agySettingsPath(): string {
  return process.env.AGY_SETTINGS_PATH ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

/**
 * Headless agy denies every shell command without a `command(<prefix>)` allow rule.
 * Add one per validate command. Matching is exact for script runners (pnpm/npm/yarn:
 * extra arguments or `*` are denied), so agy runs the commands as written. Rules are
 * kept afterwards on purpose: the user's interactive agy benefits too.
 * Returns the rules that were newly added.
 */
export function allowValidateCommands(commands: string[]): string[] {
  if (commands.length === 0) return [];
  const file = agySettingsPath();
  let settings: Record<string, any> = {};
  if (existsSync(file)) settings = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const allow: string[] = (settings.permissions ??= {}).allow ??= [];
  const added = commands.map((c) => `command(${c.trim()})`).filter((rule) => !allow.includes(rule));
  if (added.length === 0) return [];
  allow.push(...added);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return added;
}

/** agy may be a script (tests use a fake agy written in JS); run those through node. */
function command(agy: string, args: string[]): [string, string[]] {
  return /\.(c?m?js)$/i.test(agy) ? [process.execPath, [agy, ...args]] : [agy, args];
}

export function agyVersion(agy: string): string | undefined {
  const r = spawnSync(...command(agy, ['--version']), { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Newest Gemini Flash slug for the requested effort, from `agy models`. */
export function newestFlash(agy: string, effort: string): { model?: string; error?: string } {
  const r = spawnSync(...command(agy, ['models']), { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // Inside a sandbox (e.g. Codex workspace-write) agy cannot reach the network, its
    // ~/.gemini state or its login; the last log line rarely says so.
    if (/forbidden by its access permissions|\.gemini[^\n]*Access is denied/i.test(out)) {
      return { error: 'agy is sandboxed: it cannot reach the network or ~/.gemini. In Codex, run with sandbox_mode = "danger-full-access".' };
    }
    return { error: (r.stderr || r.stdout || 'agy models failed').trim().split('\n').pop() };
  }
  const flash = r.stdout
    .split(/\r?\n/)
    .map((l) => l.split('\t')[0].trim())
    .map((slug) => ({ slug, m: /^gemini-(\d+)\.(\d+)-flash-([a-z]+)$/.exec(slug) }))
    .filter((x) => x.m && x.m[3] === effort)
    .sort((a, b) => Number(b.m![1]) - Number(a.m![1]) || Number(b.m![2]) - Number(a.m![2]));
  return flash[0] ? { model: flash[0].slug } : { error: `no gemini-*-flash-${effort} model in \`agy models\`` };
}

function oneTurn(opts: TurnOptions, prompt: string, conversationId: string | undefined): Promise<TurnResult> {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits', '--disable-slash-commands', '--model', opts.model];
  if (conversationId) args.push('--conversation', conversationId);
  const idleMs = opts.idleTimeoutMs ?? 10 * 60_000;
  return new Promise((resolve) => {
    const [file, argv] = command(opts.agy, args);
    const child = spawn(file, argv, { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const result: TurnResult = { conversationId, status: 'CRASH', response: '', deniedActions: [], autoResumes: 0, durationSeconds: 0, stderrTail: '' };
    const started = Date.now();
    let settled = false;
    let gotResult = false;
    let idleTimer: NodeJS.Timeout;
    const finish = (status?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      if (status) result.status = status;
      result.durationSeconds = Math.round((Date.now() - started) / 1000);
      killTree(child.pid);
      resolve(result);
    };
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('IDLE_TIMEOUT'), idleMs);
    };
    const deadline = setTimeout(() => finish('DEADLINE'), opts.deadlineMs ?? 45 * 60_000);
    touch();

    createInterface({ input: child.stdout }).on('line', (line) => {
      appendFileSync(opts.logFile, `${line}\n`);
      touch();
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.event === 'init') result.conversationId = ev.conversation_id ?? ev.init?.conversation_id ?? result.conversationId;
      if (ev.event === 'result' && ev.result) {
        const r = ev.result;
        gotResult = true;
        result.conversationId = r.conversation_id ?? result.conversationId;
        result.status = r.status ?? 'ERROR';
        result.response = r.response ?? '';
        result.error = r.error;
        result.usage = r.usage;
        result.deniedActions = (r.denied_actions ?? []).map((d: any) => d.display_name ?? d.action ?? '?');
      }
    });
    child.stderr.on('data', (d) => {
      result.stderrTail = (result.stderrTail + d).slice(-4000);
    });
    child.on('error', (err) => {
      result.error = String(err);
      finish('CRASH');
    });
    child.on('close', () => finish(gotResult ? undefined : 'CRASH'));
    child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
  });
}

/** One logical turn: retries the same conversation when the provider times out mid-turn. */
export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const max = opts.maxAutoResumes ?? 2;
  let res = await oneTurn(opts, opts.prompt, opts.conversationId);
  let resumes = 0;
  let total = res.durationSeconds;
  while (
    resumes < max &&
    res.conversationId &&
    (isResponseTimeout(`${res.response}\n${res.error ?? ''}`) || res.status === 'IDLE_TIMEOUT')
  ) {
    resumes += 1;
    appendFileSync(opts.logFile, `{"event":"agy-run","note":"auto-resume ${resumes} after ${res.status}"}\n`);
    res = await oneTurn(opts, CONTINUE_PROMPT, res.conversationId);
    total += res.durationSeconds;
  }
  res.autoResumes = resumes;
  res.durationSeconds = total;
  return res;
}

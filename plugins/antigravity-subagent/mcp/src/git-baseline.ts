import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type { BlueprintPlan } from './blueprint.js';

const SNAPSHOT_FILE_LIMIT = 1_000_000;
const DIFF_OUTPUT_LIMIT = 128 * 1024;

export type BaselineFile = {
  existed: boolean;
  hash?: string;
  size?: number;
  snapshotRelative?: string;
};

export type PlanBaseline = {
  schemaVersion: 1;
  baselineId: string;
  createdAt: string;
  cwd: string;
  writeScope: string[];
  forbiddenScope: string[];
  ownedFiles: Record<string, BaselineFile>;
  dirtyPaths: Record<string, string>;
};

export type PlanMechanicalReview = {
  changedFiles: string[];
  unauthorizedChanges: string[];
  forbiddenChanges: string[];
  preExistingOutsideScopeModified: string[];
  diff: string;
  diffIncluded: boolean;
  diffTruncated: boolean;
  diffIncomplete: boolean;
};

function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function assertWorkspacePath(cwd: string, candidate: string): { absolute: string; relative: string } {
  const absolute = path.resolve(cwd, candidate);
  const root = path.resolve(cwd);
  const relativeNative = path.relative(root, absolute);
  if (relativeNative === '' || (!relativeNative.startsWith('..') && !path.isAbsolute(relativeNative))) {
    return { absolute, relative: toPosix(relativeNative || '.') };
  }
  throw new Error(`Blueprint path escapes workspace: ${candidate}`);
}

async function pathKind(filename: string): Promise<'file' | 'directory' | 'missing' | 'other'> {
  try {
    const info = await lstat(filename);
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function fileHash(filename: string): Promise<string> {
  try {
    const data = await readFile(filename);
    return createHash('sha256').update(data).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '<missing>';
    throw error;
  }
}

async function listFilesRecursively(directory: string, cwd: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(toPosix(path.relative(cwd, full)));
    }
  }
  await walk(directory);
  return files;
}

async function runGit(cwd: string, args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
  });
}

function splitZero(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(toPosix);
}

async function gitRoot(cwd: string): Promise<string> {
  const value = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  if (!value) throw new Error(`Could not resolve Git root for workspace: ${cwd}`);
  return path.resolve(value);
}

/**
 * Run every dirty-path query from the resolved Git root so tracked, staged, and untracked paths
 * share one repository-relative coordinate system. Mechanical PLAN scopes are workspace-relative,
 * so convert that common Git coordinate system back to the execution workspace afterwards. Paths
 * outside the workspace intentionally remain `../...` so sibling changes remain reviewable.
 */
export async function gitChangedPaths(cwd: string): Promise<string[]> {
  const resolvedCwd = path.resolve(cwd);
  const root = await gitRoot(resolvedCwd);
  const groups = await Promise.all([
    runGit(root, ['diff', '--name-only', '-z']),
    runGit(root, ['diff', '--cached', '--name-only', '-z']),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const repoRelative = [...new Set(groups.flatMap(splitZero))];
  return repoRelative
    .map((entry) => toPosix(path.relative(resolvedCwd, path.resolve(root, ...entry.split('/')))) || '.')
    .sort();
}

function scopeEntryMatches(relativePath: string, scopeEntry: string): boolean {
  const rel = toPosix(relativePath);
  let scope = toPosix(scopeEntry);
  if (scope.endsWith('/**')) scope = scope.slice(0, -3).replace(/\/+$/, '');
  return rel === scope || (scope !== '.' && rel.startsWith(`${scope}/`));
}

export function pathInScopes(relativePath: string, scopes: string[]): boolean {
  return scopes.some((scope) => scopeEntryMatches(relativePath, scope));
}

async function normalizeScopes(cwd: string, scopes: string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const entry of scopes) {
    const cleaned = entry.trim().replace(/\*\*$/, '');
    const { relative } = assertWorkspacePath(cwd, cleaned || '.');
    normalized.push(relative);
  }
  return [...new Set(normalized)];
}

async function enumerateScopeFiles(cwd: string, scopes: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const scope of scopes) {
    const { absolute, relative } = assertWorkspacePath(cwd, scope);
    const kind = await pathKind(absolute);
    if (kind === 'file') files.add(relative);
    else if (kind === 'directory') {
      for (const file of await listFilesRecursively(absolute, cwd)) files.add(file);
    } else if (kind === 'missing') {
      files.add(relative);
    }
  }
  return [...files].sort();
}

function snapshotPath(snapshotRoot: string, relativePath: string): string {
  return path.join(snapshotRoot, 'files', ...toPosix(relativePath).split('/'));
}

export async function capturePlanBaseline(
  cwd: string,
  plan: BlueprintPlan,
  baselineDir: string,
): Promise<PlanBaseline> {
  const resolvedCwd = path.resolve(cwd);
  const writeScope = await normalizeScopes(resolvedCwd, plan.writeScope);
  const forbiddenScope = await normalizeScopes(resolvedCwd, plan.forbiddenScope);
  const baselineId = `base_${randomUUID()}`;
  const snapshotRoot = path.join(baselineDir, baselineId);
  await mkdir(path.join(snapshotRoot, 'files'), { recursive: true });

  const ownedFiles: Record<string, BaselineFile> = {};
  for (const relative of await enumerateScopeFiles(resolvedCwd, writeScope)) {
    const absolute = path.join(resolvedCwd, ...relative.split('/'));
    const kind = await pathKind(absolute);
    if (kind !== 'file') {
      ownedFiles[relative] = { existed: false };
      continue;
    }
    const info = await stat(absolute);
    const hash = await fileHash(absolute);
    const entry: BaselineFile = { existed: true, hash, size: info.size };
    if (info.size <= SNAPSHOT_FILE_LIMIT) {
      const destination = snapshotPath(snapshotRoot, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(absolute, destination);
      entry.snapshotRelative = toPosix(path.relative(snapshotRoot, destination));
    }
    ownedFiles[relative] = entry;
  }

  const dirtyPaths: Record<string, string> = {};
  for (const relative of await gitChangedPaths(resolvedCwd)) {
    const absolute = path.resolve(resolvedCwd, ...relative.split('/'));
    dirtyPaths[relative] = await fileHash(absolute);
  }

  const baseline: PlanBaseline = {
    schemaVersion: 1,
    baselineId,
    createdAt: new Date().toISOString(),
    cwd: resolvedCwd,
    writeScope,
    forbiddenScope,
    ownedFiles,
    dirtyPaths,
  };
  await writeFile(path.join(snapshotRoot, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

export async function loadPlanBaseline(baselineDir: string, baselineId: string): Promise<PlanBaseline> {
  if (!/^base_[A-Za-z0-9-]+$/.test(baselineId)) throw new Error(`Invalid baseline ID: ${baselineId}`);
  const raw = JSON.parse(await readFile(path.join(baselineDir, baselineId, 'baseline.json'), 'utf8')) as PlanBaseline;
  if (raw.schemaVersion !== 1 || raw.baselineId !== baselineId) throw new Error(`Invalid baseline record: ${baselineId}`);
  return raw;
}

async function currentScopeFiles(cwd: string, scopes: string[]): Promise<string[]> {
  return enumerateScopeFiles(cwd, scopes);
}

async function diffPair(snapshotRoot: string, cwd: string, relative: string, baseline: BaselineFile | undefined): Promise<{ text: string; incomplete: boolean }> {
  const current = path.join(cwd, ...relative.split('/'));
  const currentKind = await pathKind(current);
  let before: string;
  let incomplete = false;
  if (baseline?.snapshotRelative) {
    before = path.join(snapshotRoot, ...baseline.snapshotRelative.split('/'));
  } else if (baseline?.existed) {
    incomplete = true;
    return { text: `\n[Diff unavailable for ${relative}: baseline file exceeded snapshot limit.]\n`, incomplete };
  } else {
    before = path.join(snapshotRoot, '.empty-before');
    await writeFile(before, '', { encoding: 'utf8', flag: 'a' });
  }

  let after = current;
  if (currentKind !== 'file') {
    after = path.join(snapshotRoot, '.empty-after');
    await writeFile(after, '', { encoding: 'utf8', flag: 'a' });
  }

  const result = await new Promise<{ stdout: Buffer; code: number | null }>((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-index', '--no-ext-diff', '--', before, after], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout: Buffer.concat(stdout), code }));
  });
  if (result.code !== 0 && result.code !== 1) {
    return { text: `\n[Unable to generate diff for ${relative}; git diff exited ${result.code}.]\n`, incomplete: true };
  }
  let text = result.stdout.toString('utf8');
  if (text) text = `\n### ${relative}\n${text}`;
  return { text, incomplete };
}

export async function reviewPlanBaseline(
  cwd: string,
  plan: BlueprintPlan,
  baselineDir: string,
  baselineId: string,
  includeDiff = true,
): Promise<PlanMechanicalReview> {
  const baseline = await loadPlanBaseline(baselineDir, baselineId);
  const resolvedCwd = path.resolve(cwd);
  if (path.resolve(baseline.cwd) !== resolvedCwd) throw new Error('Baseline workspace does not match execution run workspace.');
  const snapshotRoot = path.join(baselineDir, baselineId);

  const currentDirty = await gitChangedPaths(resolvedCwd);
  const currentDirtySet = new Set(currentDirty);
  const unauthorized = new Set<string>();
  const forbidden = new Set<string>();
  const preExistingOutsideModified = new Set<string>();

  for (const relative of currentDirty) {
    const allowed = pathInScopes(relative, baseline.writeScope);
    const existedDirty = Object.prototype.hasOwnProperty.call(baseline.dirtyPaths, relative);
    if (!allowed && !existedDirty) unauthorized.add(relative);
    if (pathInScopes(relative, baseline.forbiddenScope) && !existedDirty) forbidden.add(relative);
  }

  for (const [relative, beforeHash] of Object.entries(baseline.dirtyPaths)) {
    if (!currentDirtySet.has(relative) && beforeHash !== '<missing>') {
      const nowHash = await fileHash(path.resolve(resolvedCwd, ...relative.split('/')));
      if (nowHash !== beforeHash && !pathInScopes(relative, baseline.writeScope)) {
        preExistingOutsideModified.add(relative);
        unauthorized.add(relative);
      }
      continue;
    }
    const nowHash = await fileHash(path.resolve(resolvedCwd, ...relative.split('/')));
    if (nowHash !== beforeHash && !pathInScopes(relative, baseline.writeScope)) {
      preExistingOutsideModified.add(relative);
      unauthorized.add(relative);
      if (pathInScopes(relative, baseline.forbiddenScope)) forbidden.add(relative);
    }
  }

  const candidates = new Set<string>([
    ...Object.keys(baseline.ownedFiles),
    ...(await currentScopeFiles(resolvedCwd, baseline.writeScope)),
  ]);
  const changedFiles: string[] = [];
  let diff = '';
  let diffIncomplete = false;
  for (const relative of [...candidates].sort()) {
    const entry = baseline.ownedFiles[relative];
    const currentHash = await fileHash(path.join(resolvedCwd, ...relative.split('/')));
    const beforeHash = entry?.existed ? entry.hash : '<missing>';
    if (currentHash === beforeHash) continue;
    changedFiles.push(relative);
    if (pathInScopes(relative, baseline.forbiddenScope)) forbidden.add(relative);
    if (includeDiff) {
      const pair = await diffPair(snapshotRoot, resolvedCwd, relative, entry);
      diff += pair.text;
      diffIncomplete ||= pair.incomplete;
    }
  }

  let diffTruncated = false;
  if (includeDiff && Buffer.byteLength(diff, 'utf8') > DIFF_OUTPUT_LIMIT) {
    diff = Buffer.from(diff, 'utf8').subarray(0, DIFF_OUTPUT_LIMIT).toString('utf8');
    diff += '\n[Diff truncated by MCP review limit; inspect listed files directly for complete semantic review.]\n';
    diffTruncated = true;
  }

  return {
    changedFiles,
    unauthorizedChanges: [...unauthorized].sort(),
    forbiddenChanges: [...forbidden].sort(),
    preExistingOutsideScopeModified: [...preExistingOutsideModified].sort(),
    diff,
    diffIncluded: includeDiff,
    diffTruncated,
    diffIncomplete,
  };
}

export async function removePlanBaseline(baselineDir: string, baselineId: string): Promise<void> {
  await rm(path.join(baselineDir, baselineId), { recursive: true, force: true });
}

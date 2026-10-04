import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Change = { status: 'A' | 'M' | 'D'; file: string };

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function repoRoot(cwd: string): string {
  return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim());
}

function headCommit(root: string): string | undefined {
  try {
    return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Snapshot the whole working tree (tracked + untracked, honoring ignore rules) into a
 * commit object via a throwaway index. The user's index, stash and branch are untouched.
 */
export function snapshot(root: string, scratchDir: string, message: string): string {
  mkdirSync(scratchDir, { recursive: true });
  const indexFile = path.join(scratchDir, `snapshot-${process.pid}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const head = headCommit(root);
    // Start from a copy of the real index so `git add` can reuse its stat cache (fast on
    // large repos). The real index itself is only read.
    const realIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
    if (existsSync(realIndex)) copyFileSync(realIndex, indexFile);
    else if (head) git(root, ['read-tree', head], env);
    git(root, ['add', '-A', '--', '.'], env);
    const tree = git(root, ['write-tree'], env).trim();
    const args = ['commit-tree', tree, '-m', message];
    if (head) args.splice(2, 0, '-p', head);
    return git(root, args, {
      ...env,
      GIT_AUTHOR_NAME: 'agy-run',
      GIT_AUTHOR_EMAIL: 'agy-run@localhost',
      GIT_COMMITTER_NAME: 'agy-run',
      GIT_COMMITTER_EMAIL: 'agy-run@localhost',
    }).trim();
  } finally {
    if (existsSync(indexFile)) rmSync(indexFile, { force: true });
  }
}

export function setRef(root: string, ref: string, commit: string): void {
  git(root, ['update-ref', ref, commit]);
}

export function deleteRefs(root: string, prefix: string): number {
  const refs = git(root, ['for-each-ref', '--format=%(refname)', prefix]).split('\n').filter(Boolean);
  for (const ref of refs) git(root, ['update-ref', '-d', ref]);
  return refs.length;
}

export function changes(root: string, from: string, to: string): Change[] {
  const out = git(root, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  const parts = out.split('\0').filter(Boolean);
  const list: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i][0];
    list.push({ status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M', file: parts[i + 1] });
  }
  return list;
}

export function diffText(root: string, from: string, to: string, files?: string[]): string {
  return git(root, ['diff', '--no-renames', from, to, ...(files?.length ? ['--', ...files] : [])]);
}

/** Restore the given files in the working tree to their state in `commit` (index untouched). */
export function restoreFiles(root: string, commit: string, list: Change[]): void {
  for (const c of list) {
    const abs = path.join(root, c.file);
    if (c.status === 'A') {
      if (existsSync(abs)) unlinkSync(abs);
      continue;
    }
    const blob = execFileSync('git', ['show', `${commit}:${c.file}`], { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, blob);
  }
}

/** Make sure `.agy/` never shows up as untracked, without editing the user's .gitignore. */
export function ensureExcluded(root: string, entry = '.agy/'): void {
  const gitDir = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim());
  const file = path.join(gitDir, 'info', 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => l.trim() === entry)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
}

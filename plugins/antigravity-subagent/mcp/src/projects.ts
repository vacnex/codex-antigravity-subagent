import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AgyProject = {
  id: string;
  name: string;
  roots: string[];
  sourceFile: string;
};

export type AgyProjectRegistry = {
  directory?: string;
  projects: AgyProject[];
  warnings: string[];
};

export type AgyProjectResolution =
  | { kind: 'explicit'; project: AgyProject }
  | { kind: 'auto'; project: AgyProject }
  | { kind: 'ambiguous'; candidates: AgyProject[] }
  | { kind: 'create' }
  | { kind: 'error'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function windowsFileUrlToPath(value: string): string {
  const decoded = decodeURIComponent(value.replace(/^file:\/\//i, ''));
  const withoutAuthority = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  return path.win32.normalize(withoutAuthority.replace(/\//g, '\\'));
}

export function folderUriToPath(value: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    if (/^file:\/\//i.test(trimmed)) {
      if (platform === 'win32') return windowsFileUrlToPath(trimmed);
      return fileURLToPath(trimmed);
    }
    return platform === 'win32' ? path.win32.resolve(trimmed) : path.resolve(trimmed);
  } catch {
    return undefined;
  }
}

export function canonicalProjectPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = platform === 'win32' ? path.win32.resolve(value) : path.resolve(value);
  const parsedRoot = platform === 'win32' ? path.win32.parse(resolved).root : path.parse(resolved).root;
  const withoutTrailing = platform === 'win32'
    ? resolved.replace(/[\\/]+$/, '')
    : resolved.replace(/\/+$/, '');
  const normalized = withoutTrailing || parsedRoot;
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function projectContainsPath(
  root: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const canonicalRoot = canonicalProjectPath(root, platform);
  const canonicalCwd = canonicalProjectPath(cwd, platform);
  if (canonicalRoot === canonicalCwd) return true;
  const relative = platform === 'win32'
    ? path.win32.relative(canonicalRoot, canonicalCwd)
    : path.relative(canonicalRoot, canonicalCwd);
  const separator = platform === 'win32' ? '\\' : path.sep;
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${separator}`)
    && !(platform === 'win32' ? path.win32.isAbsolute(relative) : path.isAbsolute(relative));
}

function rootSpecificity(root: string, platform: NodeJS.Platform = process.platform): number {
  const canonical = canonicalProjectPath(root, platform);
  return platform === 'win32'
    ? canonical.split(/[\\/]+/).filter(Boolean).length
    : canonical.split('/').filter(Boolean).length;
}

function collectFolderUris(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFolderUris(item, result);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'folderUri' && typeof child === 'string') result.push(child);
    else if (Array.isArray(child) || isRecord(child)) collectFolderUris(child, result);
  }
}

export function parseAgyProject(
  value: unknown,
  sourceFile: string,
  platform: NodeJS.Platform = process.platform,
): AgyProject | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' && value.id.trim()
    ? value.id.trim()
    : path.basename(sourceFile, path.extname(sourceFile));
  if (!id) return undefined;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
  const uris: string[] = [];
  collectFolderUris(value.projectResources ?? value, uris);
  const roots = unique(uris
    .map((uri) => folderUriToPath(uri, platform))
    .filter((entry): entry is string => Boolean(entry)));
  if (roots.length === 0) return undefined;
  return { id, name, roots, sourceFile };
}

function candidateDirectories(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const candidates: string[] = [];
  const override = env.AGY_PROJECTS_DIR?.trim();
  if (override) return [path.resolve(override)];
  const geminiHome = env.GEMINI_HOME?.trim();
  if (geminiHome) candidates.push(path.join(path.resolve(geminiHome), 'config', 'projects'));
  candidates.push(path.join(homeDir, '.gemini', 'config', 'projects'));
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) candidates.push(path.join(path.resolve(xdg), 'gemini', 'config', 'projects'));
  candidates.push(path.join(homeDir, '.config', 'gemini', 'config', 'projects'));
  if (env.APPDATA?.trim()) candidates.push(path.join(env.APPDATA, 'Antigravity', 'config', 'projects'));
  if (env.LOCALAPPDATA?.trim()) candidates.push(path.join(env.LOCALAPPDATA, 'Antigravity', 'config', 'projects'));
  if (process.platform === 'darwin') candidates.push(path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'config', 'projects'));
  return unique(candidates.map((entry) => path.resolve(entry)));
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

export async function discoverAgyProjects(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Promise<AgyProjectRegistry> {
  const warnings: string[] = [];
  for (const directory of candidateDirectories(env, homeDir)) {
    if (!await isDirectory(directory)) continue;
    let entries: string[];
    try {
      entries = (await readdir(directory)).filter((entry) => entry.toLowerCase().endsWith('.json')).sort();
    } catch (error) {
      warnings.push(`Could not read Antigravity project registry ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (entries.length === 0) continue;
    const projects: AgyProject[] = [];
    for (const entry of entries) {
      const filename = path.join(directory, entry);
      try {
        const parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown;
        const project = parseAgyProject(parsed, filename);
        if (project) projects.push(project);
        else warnings.push(`Ignored Antigravity project with no usable folder roots: ${filename}`);
      } catch (error) {
        warnings.push(`Ignored invalid Antigravity project ${filename}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { directory, projects, warnings };
  }
  return { projects: [], warnings };
}

export function resolveAgyProject(
  cwd: string,
  projects: AgyProject[],
  explicitProjectId?: string,
  platform: NodeJS.Platform = process.platform,
): AgyProjectResolution {
  if (explicitProjectId) {
    const project = projects.find((entry) => entry.id === explicitProjectId || entry.name === explicitProjectId);
    if (!project) return { kind: 'error', error: `Unknown Antigravity project: ${explicitProjectId}.` };
    if (!project.roots.some((root) => projectContainsPath(root, cwd, platform))) {
      return { kind: 'error', error: `Antigravity project ${project.name} (${project.id}) does not contain workspace ${cwd}.` };
    }
    return { kind: 'explicit', project };
  }

  const ranked = projects.flatMap((project) => {
    const matchingRoots = project.roots.filter((root) => projectContainsPath(root, cwd, platform));
    if (matchingRoots.length === 0) return [];
    const specificity = Math.max(...matchingRoots.map((root) => rootSpecificity(root, platform)));
    return [{ project, specificity }];
  });
  if (ranked.length === 0) return { kind: 'create' };
  const best = Math.max(...ranked.map((entry) => entry.specificity));
  const candidates = ranked.filter((entry) => entry.specificity === best).map((entry) => entry.project);
  if (candidates.length === 1) return { kind: 'auto', project: candidates[0] };
  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { kind: 'ambiguous', candidates };
}

export function describeProjectChoice(project: AgyProject): string {
  return `${project.name} — ${project.roots.join(', ')}`;
}

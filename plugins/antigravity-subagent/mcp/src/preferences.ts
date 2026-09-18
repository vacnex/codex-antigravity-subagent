import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Effort } from './cli.js';
import { resolvePreferencesFilePath } from './state-paths.js';

export type WorkspacePreference = {
  model?: string;
  effort?: Effort;
  projectId?: string;
  updatedAt: string;
};

export type PreferencesRecord = {
  lastModel?: string;
  lastEffort?: Effort;
  workspaces: Record<string, WorkspacePreference>;
};

export async function readPreferences(): Promise<PreferencesRecord> {
  const filePath = resolvePreferencesFilePath();
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PreferencesRecord>;
    const effort = parsed?.lastEffort;
    return {
      lastModel: typeof parsed?.lastModel === 'string' ? parsed.lastModel : undefined,
      lastEffort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined,
      workspaces: typeof parsed?.workspaces === 'object' && parsed.workspaces !== null
        ? (parsed.workspaces as Record<string, WorkspacePreference>)
        : {},
    };
  } catch {
    return { workspaces: {} };
  }
}

export async function getWorkspacePreferences(cwd: string): Promise<WorkspacePreference | undefined> {
  const prefs = await readPreferences();
  const normalized = path.resolve(cwd).toLowerCase();
  for (const [key, val] of Object.entries(prefs.workspaces)) {
    if (path.resolve(key).toLowerCase() === normalized) {
      return val;
    }
  }
  if (prefs.lastModel || prefs.lastEffort) {
    return {
      model: prefs.lastModel,
      effort: prefs.lastEffort,
      updatedAt: new Date().toISOString(),
    };
  }
  return undefined;
}

export async function saveWorkspacePreferences(
  cwd: string,
  pref: { model?: string; effort?: Effort; projectId?: string },
): Promise<void> {
  const filePath = resolvePreferencesFilePath();
  const current = await readPreferences();
  const normalizedKey = path.resolve(cwd);
  const now = new Date().toISOString();
  current.workspaces[normalizedKey] = {
    ...current.workspaces[normalizedKey],
    ...(pref.model ? { model: pref.model } : {}),
    ...(pref.effort ? { effort: pref.effort } : {}),
    ...(pref.projectId ? { projectId: pref.projectId } : {}),
    updatedAt: now,
  };
  if (pref.model) current.lastModel = pref.model;
  if (pref.effort) current.lastEffort = pref.effort;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(current, null, 2), 'utf8');
  } catch {
    // Best-effort persistence
  }
}

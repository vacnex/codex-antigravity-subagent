import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const BLUEPRINT_START_MARKER = '<!-- AGY_BLUEPRINT:v1:START -->';
export const BLUEPRINT_END_MARKER = '<!-- AGY_BLUEPRINT:v1:END -->';

export type BlueprintStatus = 'READY' | 'BLOCKED';

export type BlueprintReadRef = {
  path: string;
  note?: string;
};

export type BlueprintPlan = {
  id: string;
  title: string;
  dependsOn: string[];
  goal: string;
  writeScope: string[];
  forbiddenScope: string[];
  requiredReadSet: BlueprintReadRef[];
  requiredConventions: string;
  requiredChanges: string;
  implementationLogic: string;
  failureBoundaryBehavior: string;
  acceptanceCriteria: string;
  canonicalValidation: string;
  stopIf: string;
  rawMarkdown: string;
};

export type ExecutionBlueprint = {
  schemaVersion: 1;
  status: BlueprintStatus;
  depth: string;
  workspace: string;
  gitHead?: string;
  plans: BlueprintPlan[];
  canonicalText: string;
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function requireMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`Blueprint is missing required ${label}.`);
  return value;
}

function getSection(block: string, heading: string): string {
  const normalized = normalizeNewlines(block);
  const lines = normalized.split('\n');
  const marker = `#### ${heading}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) throw new Error(`PLAN block is missing required section: ${heading}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^####\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const value = lines.slice(start + 1, end).join('\n').trim();
  if (!value) throw new Error(`PLAN section is empty: ${heading}`);
  return value;
}

function bulletValues(section: string): string[] {
  const trimmed = section.trim();
  if (/^(none|n\/a|không)$/i.test(trimmed)) return [];
  const bullets = normalizeNewlines(section)
    .split('\n')
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (bullets.length > 0) return bullets;
  return [trimmed];
}

function stripTicks(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parsePathItem(value: string): { path: string; note?: string } {
  const backtick = value.match(/^`([^`]+)`(?:\s*(?:—|-)\s*(.+))?$/);
  if (backtick) {
    return { path: backtick[1].trim(), note: backtick[2]?.trim() || undefined };
  }
  const split = value.match(/^(.+?)\s+(?:—|-)\s+(.+)$/);
  if (split) return { path: stripTicks(split[1]), note: split[2].trim() };
  return { path: stripTicks(value) };
}

function parsePaths(section: string): string[] {
  return bulletValues(section).map((entry) => parsePathItem(entry).path).filter(Boolean);
}

function parseReadRefs(section: string): BlueprintReadRef[] {
  return bulletValues(section).map(parsePathItem).filter((entry) => Boolean(entry.path));
}

function parseDependsOn(section: string): string[] {
  return bulletValues(section)
    .flatMap((entry) => entry.match(/PLAN-\d{2,}/g) ?? [])
    .filter((value, index, values) => values.indexOf(value) === index);
}

function gitHeadsMatch(expectedHead: string, currentHead: string): boolean {
  const expected = expectedHead.trim().toLowerCase();
  const current = currentHead.trim().toLowerCase();
  if (expected === current) return true;
  return /^[0-9a-f]{7,64}$/.test(expected)
    && /^[0-9a-f]{40,64}$/.test(current)
    && current.startsWith(expected);
}

function currentGitHead(workspace: string, expectedHead: string): string {
  try {
    const head = execFileSync(
      'git',
      ['-C', workspace, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!head) throw new Error('git rev-parse returned an empty HEAD.');
    return head;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BLUEPRINT_FRESHNESS_UNAVAILABLE: Blueprint recorded Git HEAD ${expectedHead}, but the current HEAD could not be verified for workspace ${workspace}. Re-plan before execution. ${detail}`,
    );
  }
}

export function extractCanonicalBlueprint(text: string): string {
  const normalized = normalizeNewlines(text);
  const start = normalized.lastIndexOf(BLUEPRINT_START_MARKER);
  if (start < 0) throw new Error('Blueprint start marker was not found.');
  const end = normalized.indexOf(BLUEPRINT_END_MARKER, start + BLUEPRINT_START_MARKER.length);
  if (end < 0) throw new Error('Blueprint end marker was not found.');
  return normalized.slice(start, end + BLUEPRINT_END_MARKER.length).trim();
}

export function normalizeWorkspace(value: string): string {
  return path.resolve(stripTicks(value)).replace(/[\\/]+$/, '');
}

export function workspaceMatches(blueprintWorkspace: string, requestedCwd: string): boolean {
  const left = normalizeWorkspace(blueprintWorkspace);
  const right = normalizeWorkspace(requestedCwd);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function parseBlueprint(canonicalText: string): ExecutionBlueprint {
  const canonical = extractCanonicalBlueprint(canonicalText);
  const statusValue = requireMatch(canonical, /^Blueprint status:\s*(READY|BLOCKED)\s*$/m, 'Blueprint status');
  const status = statusValue as BlueprintStatus;
  const depth = requireMatch(canonical, /^Blueprint depth:\s*(.+)$/m, 'Blueprint depth');
  const workspace = requireMatch(canonical, /^-\s*Workspace:\s*(.+)$/m, 'Blueprint basis Workspace');
  const gitHead = canonical.match(/^-\s*Git HEAD:\s*(.+)$/m)?.[1]?.trim();

  const tasksMarker = '## Implementation Tasks';
  const tasksIndex = canonical.indexOf(tasksMarker);
  if (tasksIndex < 0) throw new Error('Blueprint is missing ## Implementation Tasks.');
  const tasksText = canonical.slice(tasksIndex + tasksMarker.length, canonical.indexOf(BLUEPRINT_END_MARKER));

  const planPattern = /^###\s+(PLAN-\d{2,}):\s*(.+?)\s*$/gm;
  const matches = [...tasksText.matchAll(planPattern)];
  if (matches.length === 0) throw new Error('Blueprint contains no PLAN-XX tasks.');

  const plans: BlueprintPlan[] = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? tasksText.length) : tasksText.length;
    const rawMarkdown = tasksText.slice(start, end).trim();
    const id = match[1];
    const title = match[2].trim();
    return {
      id,
      title,
      dependsOn: parseDependsOn(getSection(rawMarkdown, 'Depends on')),
      goal: getSection(rawMarkdown, 'Goal'),
      writeScope: parsePaths(getSection(rawMarkdown, 'Write scope')),
      forbiddenScope: parsePaths(getSection(rawMarkdown, 'Forbidden scope')),
      requiredReadSet: parseReadRefs(getSection(rawMarkdown, 'Required read set')),
      requiredConventions: getSection(rawMarkdown, 'Required conventions'),
      requiredChanges: getSection(rawMarkdown, 'Required changes'),
      implementationLogic: getSection(rawMarkdown, 'Implementation logic'),
      failureBoundaryBehavior: getSection(rawMarkdown, 'Failure and boundary behavior'),
      acceptanceCriteria: getSection(rawMarkdown, 'Acceptance criteria'),
      canonicalValidation: getSection(rawMarkdown, 'Canonical validation'),
      stopIf: getSection(rawMarkdown, 'Stop if'),
      rawMarkdown,
    };
  });

  const ids = plans.map((plan) => plan.id);
  if (new Set(ids).size !== ids.length) throw new Error('Blueprint contains duplicate PLAN IDs.');
  for (const plan of plans) {
    if (plan.writeScope.length === 0) throw new Error(`${plan.id} has an empty Write scope.`);
    for (const dependency of plan.dependsOn) {
      if (!ids.includes(dependency)) throw new Error(`${plan.id} depends on unknown task ${dependency}.`);
      if (dependency === plan.id) throw new Error(`${plan.id} cannot depend on itself.`);
    }
  }

  return {
    schemaVersion: 1,
    status,
    depth,
    workspace: normalizeWorkspace(workspace),
    gitHead: gitHead && !/^(none|unavailable|n\/a)$/i.test(gitHead) ? stripTicks(gitHead) : undefined,
    plans,
    canonicalText: canonical,
  };
}

export function assertBlueprintFresh(blueprint: ExecutionBlueprint): void {
  if (!blueprint.gitHead) return;
  const currentHead = currentGitHead(blueprint.workspace, blueprint.gitHead);
  if (!gitHeadsMatch(blueprint.gitHead, currentHead)) {
    throw new Error(
      `BLUEPRINT_STALE: Blueprint Git HEAD ${blueprint.gitHead} does not match current workspace HEAD ${currentHead}. Re-plan before execution.`,
    );
  }
}

export function findPlan(blueprint: ExecutionBlueprint, planId: string): BlueprintPlan {
  assertBlueprintFresh(blueprint);
  const plan = blueprint.plans.find((entry) => entry.id === planId);
  if (!plan) throw new Error(`Blueprint does not contain ${planId}.`);
  return plan;
}

export function extractValidationCommand(section: string): string | undefined {
  const fence = section.match(/```(?:bash|sh|powershell|pwsh|cmd|text)?\s*\n([\s\S]*?)```/i)?.[1]?.trim();
  if (fence) return fence;
  const single = section.match(/^Command:\s*(.+)$/im)?.[1]?.trim();
  if (single) return stripTicks(single);
  return undefined;
}

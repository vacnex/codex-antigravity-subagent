import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { BLUEPRINT_END_MARKER, BLUEPRINT_START_MARKER, extractCanonicalBlueprint } from './blueprint.js';
import { resolveCodexHome } from './state-paths.js';

export type CapturedBlueprint = {
  canonicalText: string;
  rolloutPath: string;
  threadId: string;
};

function assertThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(threadId)) {
    throw new Error('Invalid Codex threadId metadata.');
  }
}

async function findRollouts(root: string, threadId: string): Promise<string[]> {
  const matches: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        matches.push(full);
      }
    }
  }
  await walk(root);
  return matches;
}

function assistantTextFromRolloutLine(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type;
  const payloadCandidate = record.payload ?? record.item;
  if (type !== 'response_item' || !payloadCandidate || typeof payloadCandidate !== 'object') return undefined;
  const payload = payloadCandidate as Record<string, unknown>;
  if (payload.type !== 'message' || payload.role !== 'assistant' || !Array.isArray(payload.content)) return undefined;
  const parts = payload.content
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const content = item as Record<string, unknown>;
      return content.type === 'output_text' && typeof content.text === 'string' ? content.text : undefined;
    })
    .filter((item): item is string => typeof item === 'string');
  return parts.length > 0 ? parts.join('') : undefined;
}

async function latestCompleteBlueprintInRollout(filename: string): Promise<string | undefined> {
  const text = await readFile(filename, 'utf8');
  let latest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const assistantText = assistantTextFromRolloutLine(parsed);
    if (!assistantText?.includes(BLUEPRINT_START_MARKER) || !assistantText.includes(BLUEPRINT_END_MARKER)) continue;
    try {
      latest = extractCanonicalBlueprint(assistantText);
    } catch {
      // Ignore incomplete/malformed assistant records and keep searching older valid output.
    }
  }
  return latest;
}

export async function captureLatestBlueprintFromThread(
  threadId: string,
  codexHome: string = resolveCodexHome(),
): Promise<CapturedBlueprint> {
  assertThreadId(threadId);
  const candidates = [
    ...(await findRollouts(path.join(codexHome, 'sessions'), threadId)),
    ...(await findRollouts(path.join(codexHome, 'archived_sessions'), threadId)),
  ];
  if (candidates.length === 0) {
    throw new Error(`No Codex rollout was found for thread ${threadId}.`);
  }

  const ordered = await Promise.all(candidates.map(async (filename) => ({
    filename,
    mtimeMs: (await stat(filename)).mtimeMs,
  })));
  ordered.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of ordered) {
    const canonicalText = await latestCompleteBlueprintInRollout(candidate.filename);
    if (canonicalText) {
      return { canonicalText, rolloutPath: candidate.filename, threadId };
    }
  }
  throw new Error(`No complete ${BLUEPRINT_START_MARKER} blueprint was found in Codex thread ${threadId}.`);
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseBlueprint, type ExecutionBlueprint } from './blueprint.js';
import { resolveBlueprintStateDir } from './state-paths.js';

export type BlueprintMetadata = {
  schemaVersion: 1;
  blueprintId: string;
  workspace: string;
  status: string;
  depth: string;
  gitHead?: string;
  threadId: string;
  capturedAt: string;
};

export type StoredBlueprint = {
  blueprintId: string;
  blueprint: ExecutionBlueprint;
  metadata: BlueprintMetadata;
};

function assertBlueprintId(blueprintId: string): void {
  if (!/^bp_[a-f0-9]{24}$/.test(blueprintId)) throw new Error(`Invalid blueprint ID: ${blueprintId}`);
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temp, filename);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function blueprintIdFor(blueprint: ExecutionBlueprint): string {
  const hash = createHash('sha256')
    .update(blueprint.workspace)
    .update('\0')
    .update(blueprint.canonicalText)
    .digest('hex')
    .slice(0, 24);
  return `bp_${hash}`;
}

export class BlueprintStore {
  readonly rootDir: string;

  constructor(rootDir: string = resolveBlueprintStateDir()) {
    this.rootDir = path.resolve(rootDir);
  }

  markdownPath(blueprintId: string): string {
    assertBlueprintId(blueprintId);
    return path.join(this.rootDir, `${blueprintId}.md`);
  }

  metadataPath(blueprintId: string): string {
    assertBlueprintId(blueprintId);
    return path.join(this.rootDir, `${blueprintId}.json`);
  }

  async save(canonicalText: string, threadId: string): Promise<StoredBlueprint> {
    const blueprint = parseBlueprint(canonicalText);
    const blueprintId = blueprintIdFor(blueprint);
    const metadata: BlueprintMetadata = {
      schemaVersion: 1,
      blueprintId,
      workspace: blueprint.workspace,
      status: blueprint.status,
      depth: blueprint.depth,
      gitHead: blueprint.gitHead,
      threadId,
      capturedAt: new Date().toISOString(),
    };
    await atomicWrite(this.markdownPath(blueprintId), `${blueprint.canonicalText}\n`);
    await atomicWrite(this.metadataPath(blueprintId), `${JSON.stringify(metadata, null, 2)}\n`);
    return { blueprintId, blueprint, metadata };
  }

  async read(blueprintId: string): Promise<StoredBlueprint> {
    assertBlueprintId(blueprintId);
    const [markdown, rawMetadata] = await Promise.all([
      readFile(this.markdownPath(blueprintId), 'utf8'),
      readFile(this.metadataPath(blueprintId), 'utf8'),
    ]);
    const blueprint = parseBlueprint(markdown);
    if (blueprintIdFor(blueprint) !== blueprintId) {
      throw new Error(`Blueprint content hash no longer matches ${blueprintId}.`);
    }
    const metadata = JSON.parse(rawMetadata) as BlueprintMetadata;
    if (metadata.schemaVersion !== 1 || metadata.blueprintId !== blueprintId || typeof metadata.threadId !== 'string') {
      throw new Error(`Invalid blueprint metadata: ${blueprintId}`);
    }
    return { blueprintId, blueprint, metadata };
  }
}

import { parse as parseYaml } from 'yaml';

export type Executor = 'agy' | 'claude';

export type Contract = { file: string; lang: string; content: string };

export type Plan = {
  id: string;
  title: string;
  executor: Executor;
  dependsOn: string[];
  write: string[];
  wiring: string[];
  readOnly: string[];
  /** The PLAN section exactly as written, sent to agy. */
  body: string;
  contracts: Contract[];
};

export type Blueprint = {
  title: string;
  validate: string[];
  effort?: string;
  plans: Plan[];
};

export class BlueprintError extends Error {}

type Fence = { info: string; content: string; start: number; end: number };

// PLAN headings tolerate ":", "-", en/em dash — models drift between them.
const PLAN_HEADING = /^##[ \t]+(PLAN-\d+)[ \t]*(?:[:\-–—][ \t]*)?(.*)$/;
const H2 = /^##[ \t]+\S/;

function fences(text: string): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith(marker)) body.push(lines[j++]);
    out.push({ info: open[2].trim(), content: body.join('\n'), start: i, end: j });
    i = j;
  }
  return out;
}

function stringList(value: unknown, field: string, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new BlueprintError(`${where}: "${field}" must be a string or a list of strings`);
}

function relPath(p: string, where: string): string {
  const norm = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
    throw new BlueprintError(`${where}: path "${p}" must be relative to the repository root, without ".."`);
  }
  return norm;
}

function yamlBlock(content: string, where: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (err) {
    throw new BlueprintError(`${where}: invalid YAML (${(err as Error).message.split('\n')[0]})`);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new BlueprintError(`${where}: YAML block must be a mapping`);
  return data as Record<string, unknown>;
}

/** Split a markdown document into PLAN sections; a section ends at the next `## ` heading. */
function planSections(lines: string[]): Array<{ id: string; title: string; lines: string[] }> {
  const sections: Array<{ id: string; title: string; lines: string[] }> = [];
  let current: { id: string; title: string; lines: string[] } | undefined;
  let inFence: string | undefined;
  for (const line of lines) {
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) inFence = fence[1];
      else if (line.startsWith(inFence)) inFence = undefined;
    }
    if (!inFence && H2.test(line)) {
      const m = PLAN_HEADING.exec(line);
      current = m ? { id: m[1], title: m[2].trim(), lines: [] } : undefined;
      if (current) sections.push(current);
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

export function parseBlueprint(text: string): Blueprint {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const title = (lines.find((l) => /^#[ \t]+\S/.test(l)) ?? '# (untitled)').replace(/^#[ \t]+/, '').trim();

  const top = fences(normalized).find((f) => f.info === 'yaml agy-blueprint');
  if (!top) throw new BlueprintError('missing the ```yaml agy-blueprint block (validate, effort)');
  const meta = yamlBlock(top.content, 'agy-blueprint');
  const validate = stringList(meta.validate, 'validate', 'agy-blueprint');
  const effort = typeof meta.effort === 'string' ? meta.effort : undefined;

  const sections = planSections(lines);
  if (sections.length === 0) throw new BlueprintError('no "## PLAN-XX: title" sections found');

  const plans: Plan[] = sections.map((section) => {
    const where = section.id;
    const body = section.lines.join('\n').trim();
    const blocks = fences(body);
    const metaBlock = blocks.find((f) => f.info === 'yaml agy-plan');
    if (!metaBlock) throw new BlueprintError(`${where}: missing the \`\`\`yaml agy-plan block`);
    const data = yamlBlock(metaBlock.content, where);
    const executor = (data.executor ?? 'agy') as string;
    if (executor !== 'agy' && executor !== 'claude') throw new BlueprintError(`${where}: executor must be "agy" or "claude"`);
    const write = stringList(data.write, 'write', where).map((p) => relPath(p, where));
    const wiring = stringList(data.wiring, 'wiring', where).map((p) => relPath(p, where));
    const readOnly = stringList(data.read_only, 'read_only', where).map((p) => relPath(p, where));
    if (executor === 'agy' && write.length === 0) throw new BlueprintError(`${where}: "write" must list at least one path`);
    const contracts: Contract[] = blocks
      .map((f) => ({ f, m: /(?:^|\s)file=("[^"]+"|\S+)/.exec(f.info) }))
      .filter((x) => x.m)
      .map(({ f, m }) => ({
        lang: f.info.startsWith('file=') ? '' : f.info.split(/\s+/)[0],
        file: relPath(m![1].replace(/^"|"$/g, ''), `${where} contract`),
        content: f.content.endsWith('\n') ? f.content : `${f.content}\n`,
      }));
    for (const c of contracts) {
      if (!inScope(c.file, write)) throw new BlueprintError(`${where}: contract file ${c.file} is not inside "write"`);
    }
    return {
      id: section.id,
      title: section.title,
      executor,
      dependsOn: stringList(data.depends_on, 'depends_on', where),
      write,
      wiring,
      readOnly,
      body,
      contracts,
    };
  });

  const ids = new Set<string>();
  for (const p of plans) {
    if (ids.has(p.id)) throw new BlueprintError(`duplicate ${p.id}`);
    ids.add(p.id);
  }
  for (const p of plans) {
    for (const d of p.dependsOn) {
      if (!ids.has(d)) throw new BlueprintError(`${p.id}: depends_on ${d} does not exist`);
      if (d === p.id) throw new BlueprintError(`${p.id}: depends on itself`);
    }
  }
  layers(plans); // throws on cycles
  return { title, validate, effort, plans };
}

/** Topological layers: layer N holds PLANs whose dependencies are all in earlier layers. */
export function layers(plans: Plan[]): string[][] {
  const remaining = new Map(plans.map((p) => [p.id, new Set(p.dependsOn)]));
  const out: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
    if (ready.length === 0) throw new BlueprintError(`dependency cycle among ${[...remaining.keys()].join(', ')}`);
    out.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return out;
}

/** A path matches a scope entry exactly, or lies under an entry ending with "/". */
export function inScope(file: string, scope: string[]): boolean {
  const f = file.replace(/\\/g, '/');
  return scope.some((s) => (s.endsWith('/') ? f.startsWith(s) : f === s));
}

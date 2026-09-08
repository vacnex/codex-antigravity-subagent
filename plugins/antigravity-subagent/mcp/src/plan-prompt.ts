import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { BlueprintPlan, ExecutionBlueprint } from './blueprint.js';

const SOURCE_FILE_LIMIT = 160 * 1024;
const SOURCE_TOTAL_LIMIT = 800 * 1024;

export type ReviewFinding = {
  file?: string;
  symbol?: string;
  problem: string;
  expected?: string;
  rationale?: string;
};

const EXECUTION_POLICY = `AGY EXECUTION POLICY

You are an implementation worker, not the architecture owner.
The Codex supervisor already inspected the repository and fixed the material decisions in the approved PLAN.

Rules:
- Follow the approved PLAN exactly; do not redesign it.
- Do not invent a new architecture, public API contract, DTO shape, database decision, cross-module abstraction, or naming convention.
- Modify only WRITE SCOPE. FORBIDDEN SCOPE is never writable.
- Start from the supplied SOURCE CONTEXT and paths named by the PLAN.
- Do not perform repository-wide discovery or search parent directories/other drives.
- You may read one additional file only when it is a direct dependency required to implement an approved symbol or resolve a concrete compile/runtime uncertainty.
- Additional reading never expands write permission or decision authority.
- If implementation needs a material decision absent from the PLAN, stop and report BLOCKED instead of guessing.
- Preserve unrelated user changes, encoding/BOM, line endings, and established local style.
- Prefer the smallest targeted edit that satisfies the PLAN.
- Run only the PLAN's canonical validation unless a direct implementation failure requires a narrower diagnostic.
- When acceptance criteria and validation are satisfied, stop. Do not keep exploring.
`;

const CORRECTION_POLICY = `AGY CORRECTION POLICY

Continue the existing PLAN conversation. The Codex supervisor independently reviewed the workspace.
- Fix only the concrete supervisor findings below.
- Preserve every correct implementation detail and unrelated user change.
- Do not revisit architecture or broaden scope.
- Re-read only the affected region and minimum direct dependency context needed for the correction.
- If a finding requires a new material decision outside the approved PLAN, stop and report BLOCKED.
- Re-run canonical validation when the correction can affect it.
`;

const RESUME_POLICY = `AGY PLAN RECOVERY POLICY

Resume the same approved PLAN in this existing conversation after a retryable terminal interruption.
- Inspect the current workspace state before editing.
- Preserve every correct change already present; do not restart completed work.
- Continue only unfinished requirements from the original approved PLAN.
- Do not broaden scope, redesign the PLAN, or perform repository-wide rediscovery.
- Re-read only the minimum affected context needed to continue safely.
- If the remaining work needs a material decision absent from the PLAN, stop and report BLOCKED.
- Run canonical validation when implementation is complete.
`;

function normalizeRelative(cwd: string, candidate: string): { absolute: string; relative: string } {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  const relativeNative = path.relative(root, absolute);
  if (relativeNative.startsWith('..') || path.isAbsolute(relativeNative)) {
    throw new Error(`PLAN source path escapes workspace: ${candidate}`);
  }
  return { absolute, relative: relativeNative.replace(/\\/g, '/') || '.' };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

async function tryMaterialize(filename: string): Promise<{ content?: string; reason?: string; size?: number }> {
  try {
    const info = await stat(filename);
    if (!info.isFile()) return { reason: 'not a regular file' };
    if (info.size > SOURCE_FILE_LIMIT) return { reason: `file exceeds ${SOURCE_FILE_LIMIT}-byte materialization limit`, size: info.size };
    const buffer = await readFile(filename);
    if (looksBinary(buffer)) return { reason: 'binary file', size: info.size };
    return { content: buffer.toString('utf8'), size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: 'file does not exist yet' };
    throw error;
  }
}

export async function buildSourceContext(cwd: string, plan: BlueprintPlan): Promise<string> {
  const candidates = new Map<string, string | undefined>();
  for (const entry of plan.writeScope) candidates.set(entry, 'approved write target');
  for (const entry of plan.requiredReadSet) candidates.set(entry.path, entry.note);

  let total = 0;
  const sections: string[] = [];
  for (const [candidate, note] of candidates) {
    const { absolute, relative } = normalizeRelative(cwd, candidate.replace(/\/\*\*$/, ''));
    const materialized = await tryMaterialize(absolute);
    if (materialized.content !== undefined && total + Buffer.byteLength(materialized.content, 'utf8') <= SOURCE_TOTAL_LIMIT) {
      total += Buffer.byteLength(materialized.content, 'utf8');
      sections.push([
        `--- SOURCE: ${relative}${note ? ` | ${note}` : ''} ---`,
        materialized.content,
        `--- END SOURCE: ${relative} ---`,
      ].join('\n'));
    } else {
      const reason = materialized.content !== undefined
        ? `total source context would exceed ${SOURCE_TOTAL_LIMIT}-byte limit`
        : materialized.reason ?? 'not materialized';
      sections.push(`--- SOURCE REFERENCE: ${relative}${note ? ` | ${note}` : ''} | ${reason}; read this exact path only if needed. ---`);
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : '(No source files were materialized.)';
}

export async function buildInitialPlanPrompt(
  cwd: string,
  blueprint: ExecutionBlueprint,
  plan: BlueprintPlan,
): Promise<string> {
  const sourceContext = await buildSourceContext(cwd, plan);
  return [
    EXECUTION_POLICY.trim(),
    `\nEXPECTED WORKSPACE\n${path.resolve(cwd)}`,
    `\nBLUEPRINT BASIS\nStatus: ${blueprint.status}\nDepth: ${blueprint.depth}\nGit HEAD: ${blueprint.gitHead ?? 'unavailable'}`,
    `\nAPPROVED PLAN\n${plan.rawMarkdown}`,
    `\nSOURCE CONTEXT\n${sourceContext}`,
    '\nFINAL REPORT\nReport changed files, validation performed, and any BLOCKED condition. Keep the narrative concise; the supervisor reviews the workspace directly.',
  ].join('\n');
}

function renderFinding(finding: ReviewFinding, index: number): string {
  const lines = [`Finding ${index + 1}:`];
  if (finding.file) lines.push(`- File: ${finding.file}`);
  if (finding.symbol) lines.push(`- Symbol: ${finding.symbol}`);
  lines.push(`- Problem: ${finding.problem}`);
  if (finding.expected) lines.push(`- Expected: ${finding.expected}`);
  if (finding.rationale) lines.push(`- Rationale: ${finding.rationale}`);
  return lines.join('\n');
}

export function buildCorrectionPrompt(plan: BlueprintPlan, findings: ReviewFinding[]): string {
  if (findings.length === 0) throw new Error('A PLAN correction requires at least one supervisor finding.');
  return [
    CORRECTION_POLICY.trim(),
    `\nORIGINAL APPROVED PLAN\n${plan.rawMarkdown}`,
    `\nSUPERVISOR FINDINGS\n${findings.map(renderFinding).join('\n\n')}`,
    '\nAfter fixing these findings, stop and report the changed files plus validation result.',
  ].join('\n');
}

export function buildResumePrompt(plan: BlueprintPlan): string {
  return [
    RESUME_POLICY.trim(),
    `\nORIGINAL APPROVED PLAN\n${plan.rawMarkdown}`,
    '\nContinue from the current workspace state, then stop and report changed files plus validation result.',
  ].join('\n');
}

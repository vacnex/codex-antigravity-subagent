import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Blueprint, Plan } from './blueprint.js';

function workerBrief(): string {
  // dist/agy-run.mjs → ../templates/worker-brief.md inside the plugin.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', 'templates', 'worker-brief.md'), path.join(here, '..', '..', 'plugins', 'agy-orchestrator', 'templates', 'worker-brief.md')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8').replace(/^# .*\n+/, '');
  }
  throw new Error('worker-brief.md not found next to the runner');
}

function list(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)';
}

export function planPrompt(bp: Blueprint, plan: Plan): string {
  return [
    `# Task: ${plan.id} of "${bp.title}"`,
    workerBrief().trim(),
    '## Scope (enforced by the runner after you finish)',
    `Write: \n${list(plan.write)}`,
    `Wiring edits allowed in: \n${list(plan.wiring)}`,
    `Read-only: \n${list(plan.readOnly)}`,
    plan.contracts.length ? `Contract files already written for you (do not change signatures):\n${list(plan.contracts.map((c) => c.file))}` : '',
    '## Validation',
    bp.validate.length
      ? [
          `You may run only these commands, from the repository root, exactly as written (no extra arguments, no other forms):\n${list(bp.validate)}`,
          'Any other shell command is denied. Run them to check your work before the final report and fix what fails; they can be slow, so run them once you think the PLAN is complete, not after every edit. After you finish, the runner runs them again and sends you any errors.',
        ].join('\n')
      : 'You cannot run shell commands. There is no validate command for this blueprint.',
    '## The PLAN',
    plan.body,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function fixPrompt(plan: Plan, findings: string, source: 'runner' | 'reviewer'): string {
  const who = source === 'runner' ? 'The runner checked your work and found problems' : 'The reviewer found problems in your work';
  return [
    `# Fix request for ${plan.id}`,
    `${who}. Fix exactly these, keep everything else as is, stay inside the same scope, and run no shell commands other than the validate commands allowed before.`,
    findings.trim(),
    'When done, output the same "## Result: DONE | BLOCKED" final report as before.',
  ].join('\n\n');
}

/** Sent once in the same conversation when agy ends its turn without a final report. */
export function continuePrompt(plan: Plan): string {
  return [
    `# Continue ${plan.id}`,
    'You ended your turn without the final "## Result:" report. The Recon report is not a stopping point.',
    'Continue now in this conversation: implement everything the PLAN asks that is not done yet (Step 2), self-check (Step 3), and end with the final report.',
  ].join('\n\n');
}

export type AgyReport = { result: 'DONE' | 'BLOCKED' | 'UNKNOWN'; text: string };

/** Extract the final "## Result:" report from agy's response. */
export function parseReport(response: string): AgyReport {
  const idx = response.search(/^#{1,3}\s*Result:/im);
  const text = (idx >= 0 ? response.slice(idx) : response).trim();
  const m = /^#{1,3}\s*Result:\s*\**\s*(DONE|BLOCKED)/im.exec(text);
  return { result: (m?.[1] as 'DONE' | 'BLOCKED') ?? 'UNKNOWN', text };
}

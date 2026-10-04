#!/usr/bin/env node
// Hook entry for agy-orchestrator.
//   plan-prompt : UserPromptSubmit — in plan mode, steer planning to the agy blueprint format.
//   exit-plan   : PostToolUse(ExitPlanMode) — after approval, hand the blueprint to agy
//                 instead of letting Claude implement it.
// The last payloads are kept in $CLAUDE_PLUGIN_DATA/hook-payloads.jsonl for diagnostics.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    /* ignore malformed input */
  }
  record(mode, input);
  const context = mode === 'plan-prompt' ? planPrompt(input) : mode === 'exit-plan' ? exitPlan(input) : undefined;
  if (context) {
    const hookEventName = mode === 'plan-prompt' ? 'UserPromptSubmit' : 'PostToolUse';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } }));
  }
});

function record(event, input) {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hook-payloads.jsonl');
    if (existsSync(file) && statSync(file).size > 200_000) writeFileSync(file, '');
    const slim = JSON.stringify(input, (k, v) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…` : v));
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event })}\t${slim}\n`);
  } catch {
    /* diagnostics only */
  }
}

function planPrompt(input) {
  if (input.permission_mode !== 'plan') return undefined;
  return [
    'agy-orchestrator is enabled: implementation work is delegated to agy (Antigravity CLI).',
    'Unless the user asks for a normal plan or the task is tiny, plan with the agy-plan skill and write the plan file in its blueprint format.',
  ].join(' ');
}

/** Find a plan file path and whether it is an agy blueprint, from whatever the payload carries. */
function findBlueprint(input) {
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(input.tool_input);
  walk(input.tool_response);
  const inline = strings.some((s) => s.includes('```yaml agy-blueprint'));
  for (const s of strings) {
    for (const m of s.matchAll(/[A-Za-z]:[\\/][^\s"'`<>|]+?\.md|\/[^\s"'`<>|]+?\.md/g)) {
      const p = m[0];
      try {
        if (existsSync(p) && readFileSync(p, 'utf8').includes('```yaml agy-blueprint')) return { file: p, isBlueprint: true };
      } catch {
        /* keep looking */
      }
    }
  }
  return { file: undefined, isBlueprint: inline };
}

function exitPlan(input) {
  const { file, isBlueprint } = findBlueprint(input);
  const where = file ? `"${file}"` : 'the plan file you just wrote';
  if (file || isBlueprint) {
    return `The approved plan is an agy blueprint. Do not implement it yourself. Use the agy-execute skill: run \`agy-run import ${where}\`, then \`agy-run next\` with run_in_background, and review layer by layer.`;
  }
  return 'If the approved plan is an agy blueprint (it contains a ```yaml agy-blueprint block), do not implement it yourself: use the agy-execute skill (`agy-run import <plan file>`, then `agy-run next` in the background). Otherwise proceed normally.';
}

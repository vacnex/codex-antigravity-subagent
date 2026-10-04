#!/usr/bin/env node
// Fake agy for tests. Behaviour comes from the JSON file in FAKE_AGY_SCENARIO:
// { "turns": [ { "write": {"path": "content" | null}, "response": "...", "status": "SUCCESS",
//                "sleepMs": 0, "noResult": false } ] }
// Turns are consumed in order across processes (counter file next to the scenario).
// Every received prompt is appended to <scenario>.prompts.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0-fake');
  process.exit(0);
}
if (args[0] === 'models') {
  console.error('Fetching available models...');
  console.log('gemini-3.7-flash-high\tGemini 3.7 Flash (High)');
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)');
  console.log('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)');
  console.log('gemini-3.1-pro-high\tGemini 3.1 Pro (High)');
  process.exit(0);
}

const scenarioFile = process.env.FAKE_AGY_SCENARIO;
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const counterFile = `${scenarioFile}.count`;
const index = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
writeFileSync(counterFile, String(index + 1));
const turn = scenario.turns[index] ?? { response: '## Result: DONE\n- (no scripted turn)' };

const ci = args.indexOf('--conversation');
const conversationId = ci >= 0 ? args[ci + 1] : `conv-${index}`;
const mi = args.indexOf('--model');

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const msg = JSON.parse(input.trim().split('\n')[0]);
  appendFileSync(`${scenarioFile}.prompts.jsonl`, `${JSON.stringify({ args, prompt: msg.message.content })}\n`);
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  emit({ event: 'init', conversation_id: conversationId, init: { model: args[mi + 1], cwd: process.cwd() } });
  for (const [file, content] of Object.entries(turn.write ?? {})) {
    const abs = path.join(process.cwd(), file);
    if (content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    emit({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'tool', tool_name: 'write_to_file', state: 'DONE' } });
  }
  if (turn.sleepMs) await new Promise((r) => setTimeout(r, turn.sleepMs));
  if (!turn.noResult) {
    emit({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: turn.status ?? 'SUCCESS',
        response: turn.response ?? '## Result: DONE',
        usage: { input_tokens: 25000, output_tokens: 1200 },
      },
    });
  }
});

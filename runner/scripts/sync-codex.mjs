// Copies the shared runner build and templates from the Claude Code plugin into the
// Codex plugin. Codex installs only the plugin directory, so each plugin carries its own
// copy; the Claude plugin's files are the single source of truth.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const plugins = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins');
const from = path.join(plugins, 'agy-orchestrator');
const to = path.join(plugins, 'agy-orchestrator-codex');

for (const rel of ['dist/agy-run.mjs', 'templates/worker-brief.md', 'skills/agy-plan/blueprint-template.md']) {
  mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
  copyFileSync(path.join(from, rel), path.join(to, rel));
}

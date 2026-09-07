import os from 'node:os';
import path from 'node:path';

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, '.codex');
}

export function resolvePluginStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env.AGY_MCP_STATE_ROOT?.trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveCodexHome(env, homeDir), 'antigravity-subagent');
}

export function resolveBlueprintStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(resolvePluginStateRoot(env, homeDir), 'blueprints');
}

export function resolveRunStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(resolvePluginStateRoot(env, homeDir), 'runs');
}

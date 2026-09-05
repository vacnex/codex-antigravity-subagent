import { AsyncLocalStorage } from 'node:async_hooks';

export type AgyProjectLaunch =
  | { kind: 'existing'; projectId: string }
  | { kind: 'new' };

type LaunchContext = {
  project?: AgyProjectLaunch;
};

const storage = new AsyncLocalStorage<LaunchContext>();

export async function withAgyProjectLaunch<T>(
  project: AgyProjectLaunch | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  return await storage.run({ project }, callback);
}

export function appendAgyProjectArgs(args: string[], conversationId?: string): void {
  if (conversationId) return;
  const project = storage.getStore()?.project;
  if (!project) return;
  if (project.kind === 'existing') args.push('--project', project.projectId);
  else args.push('--new-project');
}

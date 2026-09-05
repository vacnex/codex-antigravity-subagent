import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';

import {
  groupModelOptions,
  inferPinnedEffort,
  listAgyModels,
  type Effort,
} from './cli.js';
import type { AgyProjectLaunch } from './launch-context.js';
import {
  describeProjectChoice,
  type AgyProject,
  type AgyProjectResolution,
} from './projects.js';

export type LaunchProjectResolution = 'explicit' | 'auto' | 'selected' | 'created';

export type LaunchSelectionReady = {
  kind: 'ready';
  model: string;
  effort: Effort;
  projectLaunch: AgyProjectLaunch;
  project?: AgyProject;
  projectResolution: LaunchProjectResolution;
};

export type LaunchSelectionError = {
  kind: 'error';
  code:
    | 'user_declined'
    | 'user_canceled'
    | 'invalid_project_selection'
    | 'invalid_model_selection'
    | 'invalid_effort_selection'
    | 'model_catalog_error';
  error: string;
};

export type LaunchSelectionResult = LaunchSelectionReady | LaunchSelectionError | InputRequiredResult;

type ModelFamily = {
  value: string;
  label: string;
  directSlug?: string;
  variants: Partial<Record<Effort, string>>;
};

type ElicitParams = Parameters<typeof inputRequired.elicit>[0];
type ElicitStringProperty = {
  type: 'string';
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  default?: string;
};

function resolveFamilyModel(
  families: ModelFamily[],
  selected: string,
  effort: Effort,
): { model: string; effort: Effort } | LaunchSelectionError {
  const family = families.find((entry) => entry.value.toLowerCase() === selected.toLowerCase());
  if (!family) {
    return { kind: 'error', code: 'invalid_model_selection', error: `Unknown Antigravity model selection: ${selected}.` };
  }
  const variant = family.variants[effort];
  if (variant) return { model: variant, effort };
  if (family.directSlug) return { model: family.directSlug, effort };
  const available = (Object.keys(family.variants) as Effort[]).join(', ');
  return {
    kind: 'error',
    code: 'invalid_effort_selection',
    error: `${family.label} does not expose ${effort} effort. Available efforts: ${available || 'none'}.`,
  };
}

function acceptedLaunchContent(ctx: ServerContext): Record<string, unknown> | undefined {
  const view = inputResponse(ctx.mcpReq.inputResponses, 'launch');
  if (view.kind === 'elicit' && view.action !== 'accept') return undefined;
  return acceptedContent<Record<string, unknown>>(ctx.mcpReq.inputResponses, 'launch');
}

function declinedLaunch(ctx: ServerContext): LaunchSelectionError | undefined {
  const view = inputResponse(ctx.mcpReq.inputResponses, 'launch');
  if (view.kind !== 'elicit' || view.action === 'accept') return undefined;
  return view.action === 'decline'
    ? { kind: 'error', code: 'user_declined', error: 'Antigravity worker setup was declined.' }
    : { kind: 'error', code: 'user_canceled', error: 'Antigravity worker setup was canceled.' };
}

function effortValue(value: unknown): Effort | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

export async function resolveLaunchSelection(
  ctx: ServerContext,
  input: {
    executable: string;
    cwd: string;
    requestedModel?: string;
    requestedEffort?: Effort;
    projectResolution: AgyProjectResolution;
  },
): Promise<LaunchSelectionResult> {
  const declined = declinedLaunch(ctx);
  if (declined) return declined;

  if (input.projectResolution.kind === 'error') {
    return {
      kind: 'error',
      code: 'invalid_project_selection',
      error: input.projectResolution.error,
    };
  }

  let families: ModelFamily[] = [];
  if (!input.requestedModel) {
    try {
      families = groupModelOptions(await listAgyModels(input.executable, input.cwd)) as ModelFamily[];
    } catch (error) {
      return {
        kind: 'error',
        code: 'model_catalog_error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const pinnedEffort = input.requestedModel ? inferPinnedEffort(input.requestedModel) : undefined;
  if (pinnedEffort && input.requestedEffort && pinnedEffort !== input.requestedEffort) {
    return {
      kind: 'error',
      code: 'invalid_effort_selection',
      error: `Antigravity model ${input.requestedModel} pins effort ${pinnedEffort}; requested ${input.requestedEffort}.`,
    };
  }

  const needsProject = input.projectResolution.kind === 'ambiguous';
  const needsModel = !input.requestedModel;
  const needsEffort = !input.requestedEffort && !pinnedEffort;
  const accepted = acceptedLaunchContent(ctx);

  if ((needsProject || needsModel || needsEffort) && !accepted) {
    const properties: Record<string, ElicitStringProperty> = {};
    const required: string[] = [];

    if (needsProject) {
      const candidates = input.projectResolution.kind === 'ambiguous' ? input.projectResolution.candidates : [];
      properties.projectId = {
        type: 'string',
        title: 'Project',
        description: `Antigravity Project containing ${input.cwd}`,
        enum: candidates.map((entry) => entry.id),
        enumNames: candidates.map(describeProjectChoice),
      };
      required.push('projectId');
    }
    if (needsModel) {
      properties.model = {
        type: 'string',
        title: 'Model',
        description: 'Antigravity base model for this worker',
        enum: families.map((entry) => entry.value),
        enumNames: families.map((entry) => entry.label),
      };
      required.push('model');
    }
    if (needsEffort) {
      properties.effort = {
        type: 'string',
        title: 'Effort',
        description: 'Reasoning effort for this worker',
        enum: ['low', 'medium', 'high'],
        enumNames: ['Low', 'Medium', 'High'],
        default: 'medium',
      };
      required.push('effort');
    }

    const requestedSchema = { type: 'object' as const, properties, required } as ElicitParams['requestedSchema'];
    return inputRequired({
      inputRequests: {
        launch: inputRequired.elicit({
          message: 'Choose the unresolved Antigravity worker settings.',
          requestedSchema,
        }),
      },
    });
  }

  let project: AgyProject | undefined;
  let projectLaunch: AgyProjectLaunch;
  let projectResolution: LaunchProjectResolution;
  if (input.projectResolution.kind === 'create') {
    projectLaunch = { kind: 'new' };
    projectResolution = 'created';
  } else if (input.projectResolution.kind === 'ambiguous') {
    const selectedId = accepted?.projectId;
    if (typeof selectedId !== 'string') {
      return { kind: 'error', code: 'invalid_project_selection', error: 'No Antigravity Project was selected.' };
    }
    project = input.projectResolution.candidates.find((entry) => entry.id === selectedId);
    if (!project) {
      return { kind: 'error', code: 'invalid_project_selection', error: `Invalid Antigravity Project selection: ${selectedId}.` };
    }
    projectLaunch = { kind: 'existing', projectId: project.id };
    projectResolution = 'selected';
  } else {
    project = input.projectResolution.project;
    projectLaunch = { kind: 'existing', projectId: project.id };
    projectResolution = input.projectResolution.kind;
  }

  const selectedEffort = input.requestedEffort ?? pinnedEffort ?? effortValue(accepted?.effort);
  if (!selectedEffort) {
    return { kind: 'error', code: 'invalid_effort_selection', error: 'No valid Antigravity effort was selected.' };
  }

  if (input.requestedModel) {
    return {
      kind: 'ready',
      model: input.requestedModel,
      effort: selectedEffort,
      projectLaunch,
      project,
      projectResolution,
    };
  }

  const selectedModel = accepted?.model;
  if (typeof selectedModel !== 'string' || !selectedModel) {
    return { kind: 'error', code: 'invalid_model_selection', error: 'No Antigravity model was selected.' };
  }
  const resolved = resolveFamilyModel(families, selectedModel, selectedEffort);
  if ('kind' in resolved) return resolved;
  return {
    kind: 'ready',
    model: resolved.model,
    effort: resolved.effort,
    projectLaunch,
    project,
    projectResolution,
  };
}

import type { OpenClawAgentApi } from './planner-trigger.js';

export type PlannerLaunchMode = 'native-api' | 'cli-fallback';

export interface PlannerAgentApiSelection {
  api: OpenClawAgentApi;
  mode: PlannerLaunchMode;
}

export function selectPlannerAgentApi(
  openclawApi: OpenClawAgentApi | undefined,
  createFallbackApi: () => OpenClawAgentApi,
): PlannerAgentApiSelection {
  if (openclawApi) {
    return {
      api: openclawApi,
      mode: 'native-api',
    };
  }

  return {
    api: createFallbackApi(),
    mode: 'cli-fallback',
  };
}

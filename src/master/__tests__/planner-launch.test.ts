import { describe, it, expect, vi } from 'vitest';

import { selectPlannerAgentApi } from '../planner-launch.js';
import type { OpenClawAgentApi } from '../planner-trigger.js';

describe('selectPlannerAgentApi', () => {
  it('prefers the injected OpenClaw agent API when present', () => {
    const nativeApi: OpenClawAgentApi = {
      triggerAgent: vi.fn(),
    };
    const fallbackFactory = vi.fn(() => ({
      triggerAgent: vi.fn(),
    }));

    const selection = selectPlannerAgentApi(nativeApi, fallbackFactory);

    expect(selection.mode).toBe('native-api');
    expect(selection.api).toBe(nativeApi);
    expect(fallbackFactory).not.toHaveBeenCalled();
  });

  it('uses the CLI fallback only when the injected API is absent', () => {
    const fallbackApi: OpenClawAgentApi = {
      triggerAgent: vi.fn(),
    };
    const fallbackFactory = vi.fn(() => fallbackApi);

    const selection = selectPlannerAgentApi(undefined, fallbackFactory);

    expect(selection.mode).toBe('cli-fallback');
    expect(selection.api).toBe(fallbackApi);
    expect(fallbackFactory).toHaveBeenCalledTimes(1);
  });
});

/**
 * ComponentRegistry Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRegistry } from '../../master/component-registry.js';

describe('ComponentRegistry', () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = new ComponentRegistry();
  });

  function seedScheduler(id = 'scheduler-1') {
    registry.registerAgent({
      agentId: id,
      agentType: 'scheduler',
      status: 'Listening',
      startedAt: new Date(),
      listeningAt: new Date(),
      lastActivityAt: new Date(),
      mcpConnections: {},
      counters: {},
      errors: { errorCount: 0 },
    });
  }

  it('registers and returns component status', () => {
    seedScheduler();
    const status = registry.getAgentStatus('scheduler-1');

    expect(status).toBeDefined();
    expect(status?.agentType).toBe('scheduler');
    expect(status?.status).toBe('Listening');
  });

  it('updates counters and MCP connection status', () => {
    seedScheduler();

    registry.updateCounters('scheduler-1', { tasksScheduled: 4, activeWorkers: 2 });
    registry.updateMCPConnection('scheduler-1', 'engine', 'connected');

    const status = registry.getAgentStatus('scheduler-1');
    expect(status?.counters.tasksScheduled).toBe(4);
    expect(status?.mcpConnections.engine).toBe('connected');
  });

  it('records errors and reports issues', () => {
    seedScheduler();

    for (let i = 0; i < 6; i++) {
      registry.recordError('scheduler-1', `error-${i}`);
    }

    const report = registry.getHealthReport();
    expect(report.totalErrors).toBe(6);
    expect(report.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(report.issues.some((issue) => issue.message.includes('has 6 errors'))).toBe(true);
  });

  it('deregisters a component', () => {
    seedScheduler();
    registry.deregisterAgent('scheduler-1');

    expect(registry.getAgentStatus('scheduler-1')).toBeUndefined();
    expect(registry.getAllAgentsStatus()).toHaveLength(0);
  });
});

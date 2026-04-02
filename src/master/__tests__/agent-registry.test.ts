/**
 * AgentRegistry Tests
 * Validates health monitoring, issue detection, and event emission
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRegistry } from '../../master/agent-registry.js';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('should register an agent', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'head',
      status: 'Listening',
      counters: {
        snapshotsCollected: 0,
        eventsDetected: 0,
      },
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    const status = registry.getAgentStatus('test-agent-1');
    expect(status).toBeDefined();
    expect(status?.agentId).toBe('test-agent-1');
    expect(status?.agentType).toBe('head');
  });

  it('should update agent status', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'scheduler',
      status: 'Starting',
      counters: { tasksScheduled: 0, activeWorkers: 0 },
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.updateAgentStatus('test-agent-1', 'Listening');

    const status = registry.getAgentStatus('test-agent-1');
    expect(status?.status).toBe('Listening');
  });

  it('should update agent action', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'head',
      status: 'Listening',
      currentAction: 'Idle',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.updateAgentAction('test-agent-1', 'Analyzing metrics');

    const status = registry.getAgentStatus('test-agent-1');
    expect(status?.currentAction).toBe('Analyzing metrics');
  });

  it('should update agent counters', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'scheduler',
      status: 'Listening',
      counters: { tasksScheduled: 0, activeWorkers: 0 },
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.updateCounters('test-agent-1', {
      tasksScheduled: 5,
      activeWorkers: 2,
    });

    const status = registry.getAgentStatus('test-agent-1');
    expect(status?.counters.tasksScheduled).toBe(5);
    expect(status?.counters.activeWorkers).toBe(2);
  });

  it('should record errors and detect high error rate', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'worker',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    // Record 6 errors (threshold)
    for (let i = 0; i < 6; i++) {
      registry.recordError('test-agent-1', `Error ${i}`);
    }

    const health = registry.getHealthReport();
    const issues = health.issues.filter((issue) =>
      issue.description.includes('high error rate')
    );

    expect(issues.length).toBeGreaterThan(0);
  });

  it('should update MCP connection status', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'head',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.updateMCPConnection('test-agent-1', 'grafana', 'connected');

    const status = registry.getAgentStatus('test-agent-1');
    expect(status?.mcpConnections['grafana']).toEqual({
      status: 'connected',
      connectedAt: expect.any(Date),
    });
  });

  it('should detect idle agents', () => {
    const startedAt = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago
    registry.registerAgent({
      agentId: 'idle-agent',
      agentType: 'worker',
      status: 'Listening',
      currentAction: 'Waiting for task',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt,
      lastActivity: new Date(Date.now() - 31 * 60 * 1000),
    });

    const health = registry.getHealthReport();
    const idleIssues = health.issues.filter((issue) =>
      issue.description.includes('idle')
    );

    expect(idleIssues.length).toBeGreaterThan(0);
  });

  it('should detect MCP connection failures', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'head',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.updateMCPConnection('test-agent-1', 'grafana', 'failed');

    const health = registry.getHealthReport();
    const connectionIssues = health.issues.filter((issue) =>
      issue.description.includes('MCP')
    );

    expect(connectionIssues.length).toBeGreaterThan(0);
  });

  it('should emit event on agent status change', (done) => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'scheduler',
      status: 'Starting',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.on('agent-status-changed', (data) => {
      expect(data.agentId).toBe('test-agent-1');
      expect(data.newStatus).toBe('Listening');
      done();
    });

    registry.updateAgentStatus('test-agent-1', 'Listening');
  });

  it('should emit event on agent action change', (done) => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'head',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.on('agent-action-changed', (data) => {
      expect(data.agentId).toBe('test-agent-1');
      expect(data.newAction).toBe('Collecting metrics');
      done();
    });

    registry.updateAgentAction('test-agent-1', 'Collecting metrics');
  });

  it('should get all agents status', () => {
    registry.registerAgent({
      agentId: 'head-1',
      agentType: 'head',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.registerAgent({
      agentId: 'scheduler-1',
      agentType: 'scheduler',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    const allAgents = registry.getAllAgentsStatus();
    expect(allAgents).toHaveLength(2);
    expect(allAgents.map((a) => a.agentId)).toContain('head-1');
    expect(allAgents.map((a) => a.agentId)).toContain('scheduler-1');
  });

  it('should filter agents by type', () => {
    registry.registerAgent({
      agentId: 'head-1',
      agentType: 'head',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.registerAgent({
      agentId: 'worker-1',
      agentType: 'worker',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    const headAgents = registry.getAgentsByType('head');
    expect(headAgents).toHaveLength(1);
    expect(headAgents[0].agentId).toBe('head-1');
  });

  it('should deregister an agent', () => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'worker',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.deregisterAgent('test-agent-1');

    const status = registry.getAgentStatus('test-agent-1');
    expect(status).toBeUndefined();
  });

  it('should emit event on agent deregistration', (done) => {
    registry.registerAgent({
      agentId: 'test-agent-1',
      agentType: 'worker',
      status: 'Listening',
      counters: {},
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    registry.on('agent-deregistered', (agentId) => {
      expect(agentId).toBe('test-agent-1');
      done();
    });

    registry.deregisterAgent('test-agent-1');
  });
});

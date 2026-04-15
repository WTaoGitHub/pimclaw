/**
 * Agent type definitions for PimClaw
 */

export type AgentType = 'head' | 'scheduler' | 'recorder' | 'worker' | 'receiver' | 'trigger';
export type AgentStatus = 'Starting' | 'Listening' | 'Stopping' | 'Stopped';
export type MCPConnectionStatus = 'connected' | 'disconnected' | 'error';

/**
 * Runtime status of an individual agent
 */
export interface AgentRuntimeStatus {
  agentId: string;
  agentType: AgentType;
  status: AgentStatus;
  startedAt: Date;
  listeningAt?: Date;
  uptime?: number; // milliseconds
  lastActivityAt: Date;
  currentAction?: string;
  mcpConnections: Record<string, MCPConnectionStatus>;
  counters: AgentCounters;
  errors: AgentErrors;
}

/**
 * Agent-type-specific operation counters
 */
export interface AgentCounters {
  // Head Agent
  snapshotsCollected?: number;
  eventsDetected?: number;
  tasksPlanned?: number;
  snapshotsSkipped?: number;

  // Recorder
  totalTasks?: number;
  readyTasks?: number;
  runningTasks?: number;
  doneTasks?: number;
  failedTasks?: number;
  expiredTasks?: number;

  // Scheduler
  activeWorkers?: number;
  maxWorkers?: number;
  tasksScheduled?: number;
  tasksExpiredByScheduler?: number;
  tasksRescheduled?: number;

  // Worker
  taskId?: string;
  taskStatus?: string;
  progress?: number;
  startedAt?: Date;
  tasksCompleted?: number;
  tasksFailed?: number;

  // Receiver (AnomalyReceiver)
  eventsReceived?: number;
  eventsValidated?: number;
  eventsRejected?: number;
  eventsDeduplicated?: number;

  // Trigger (PlannerTrigger)
  triggersAttempted?: number;
  triggersSucceeded?: number;
  triggersFailed?: number;
}

/**
 * Error tracking per agent
 */
export interface AgentErrors {
  errorCount: number;
  lastError?: string;
  lastErrorAt?: Date;
}

/**
 * Agent configuration for creation
 */
export interface AgentConfig {
  agentId: string;
  agentType: AgentType;
  mcpServices?: Record<string, MCPServiceConfig>;
  systemPrompt?: string;
  maxRetries?: number;
}

/**
 * MCP service configuration
 */
export interface MCPServiceConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

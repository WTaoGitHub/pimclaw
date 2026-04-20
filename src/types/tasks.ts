/**
 * Task type definitions for PimClaw task orchestration
 */

export type TaskStatus =
  | 'planning'
  | 'ready'
  | 'scheduling'
  | 'scheduled'
  | 'running'
  | 'done'
  | 'failed'
  | 'expired';

/**
 * A single task to be executed by a Worker Agent
 */
export interface Task {
  taskId: string;
  status: TaskStatus;
  createdAt: Date;
  statusModifiedAt: Date;
  priority: 'low' | 'medium' | 'high';
  llmDeploymentName: string;
  taskType: string; // e.g., 'scale-up', 'scale-down', 'change-parallelism'
  taskData: Record<string, unknown>;
  config?: Record<string, unknown>;
  reasoning?: string;
  perfEvidence?: string;
  simulationResults?: string;
  retryCount: number;
  maxRetries: number;
  schedulerId?: string; // which Scheduler owns this task during scheduling/scheduled
  workerId?: string; // which Worker is executing this task
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  error?: string;
  plannerTriggerError?: string;
  plannerTriggerErrorAt?: Date;
}

/**
 * Snapshot of LLM runtime metrics from Grafana
 */
export interface MetricsSnapshot {
  snapshotId: string;
  collectedAt: Date;
  window: '5m' | '15m' | '1h'; // time window for the snapshot
  metrics: Record<string, unknown>;
  analyzed: boolean;
  events?: DetectedEvent[];
  plannedTasks?: Task[];
}

/**
 * An anomaly or performance event detected by Head Agent
 */
export interface DetectedEvent {
  eventId: string;
  detectedAt: Date;
  type: 'spike' | 'drop' | 'trend' | 'anomaly';
  metricName: string;
  currentValue: number;
  previousValue: number;
  percentChange: number;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

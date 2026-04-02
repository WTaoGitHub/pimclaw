/**
 * Worker Agent - Task Executor
 * Executes a single task and reports results back to Task Status Recorder
 * - Spawned by Scheduler for each task
 * - Calls Engine MCP to execute actual deployment changes
 * - Reports status updates
 * - Disposed after completion
 */

import { BaseAgent } from './base-agent.js';
import { AgentRegistry } from './agent-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { Task, AgentRuntimeStatus } from '../types/index.js';

/**
 * Worker Agent - Executes assigned tasks
 * Ephemeral agents: one per task, disposed after completion
 */
export class WorkerAgent extends BaseAgent {
  private task: Task;
  private taskRecorder: TaskStatusRecorder;
  private executionTimeout: number = 30 * 60 * 1000; // 30 minutes

  constructor(
    registry: AgentRegistry,
    taskRecorder: TaskStatusRecorder,
    task: Task
  ) {
    super('worker', registry, {
      agentId: `worker-${task.taskId}`,
      agentType: 'worker',
      mcpServices: {
        engine: {
          command: 'node',
          args: ['path/to/engine-mcp-server.js'],
        },
      },
    });
    this.task = task;
    this.taskRecorder = taskRecorder;
  }

  /**
   * Execute the assigned task
   */
  async run(): Promise<void> {
    this.updateAction(`Executing task ${this.task.taskId}`);

    try {
      // Mark task as running
      await this.taskRecorder.updateTaskStatus(
        this.task.taskId,
        'running'
      );

      // Execute the task with timeout
      const result = await Promise.race([
        this.executeTask(),
        this.createTimeout(),
      ]);

      // Mark task as completed
      await this.taskRecorder.updateTaskResult(
        this.task.taskId,
        result as Record<string, unknown> ?? {},
        null,
      );

      // Update agent counters
      const status = this.registry.getAgentStatus(this.agentId);
      if (status) {
        const tasksCompleted = (status.counters.tasksCompleted || 0) + 1;
        this.registry.updateCounters(this.agentId, { tasksCompleted });
      }

      this.updateAction('Task execution completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle timeout
      if (errorMessage.includes('timeout')) {
        await this.taskRecorder.updateTaskResult(
          this.task.taskId,
          null,
          `Task execution timeout after ${this.executionTimeout}ms`,
        );

        // Record in agent error log
        this.registry.recordError(
          this.agentId,
          `Timeout executing task ${this.task.taskId}`
        );
      } else {
        // Handle other errors
        await this.taskRecorder.updateTaskResult(
          this.task.taskId,
          null,
          errorMessage,
        );

        this.registry.recordError(this.agentId, errorMessage);
      }

      // Handle retry logic
      if (this.task.retryCount < this.task.maxRetries) {
        // Reset task to ready for retry
        await this.taskRecorder.resetTaskForRetry(this.task.taskId);
      }

      // Update agent counters
      const status = this.registry.getAgentStatus(this.agentId);
      if (status) {
        const tasksFailed = (status.counters.tasksFailed || 0) + 1;
        this.registry.updateCounters(this.agentId, { tasksFailed });
      }

      this.updateAction('Task execution failed');
    } finally {
      // Always cleanup
      await this.shutdown();
    }
  }

  /**
   * Execute the actual task
   */
  private async executeTask(): Promise<unknown> {
    this.updateAction(
      `Calling Engine MCP for ${this.task.taskType} on ${this.task.llmDeploymentName}`
    );

    try {
      // Call Engine MCP with task details
      const result = await this.callMCPTool('engine', 'execute_deployment_change', {
        deploymentName: this.task.llmDeploymentName,
        changeType: this.task.taskType,
        params: this.task.taskData,
      });

      return result;
    } catch (error) {
      throw new Error(
        `Engine MCP call failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`timeout: Task exceeded ${this.executionTimeout}ms limit`)),
        this.executionTimeout
      );
    });
  }

  /**
   * Get worker-specific runtime status
   */
  getRuntimeStatus(): AgentRuntimeStatus | undefined {
    const baseStatus = super.getRuntimeStatus();
    if (!baseStatus) return undefined;
    return {
      ...baseStatus,
      counters: {
        ...baseStatus.counters,
        taskId: this.task.taskId,
        taskStatus: this.task.status,
      },
    };
  }
}

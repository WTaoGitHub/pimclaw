/**
 * PimClaw MCP Server — v2
 * Exposes PimClaw tools via the Model Context Protocol.
 * Updated for v2 hybrid architecture: renamed tools, new tool definitions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ComponentRegistry } from './component-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { Task } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export class PimClawMCPServer {
  private server: Server;
  private registry: ComponentRegistry;
  private taskRecorder: TaskStatusRecorder;

  constructor(registry: ComponentRegistry, taskRecorder: TaskStatusRecorder) {
    this.registry = registry;
    this.taskRecorder = taskRecorder;

    this.server = new Server(
      { name: 'pimclaw-server', version: '2.0.0' },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions(),
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        return await this.handleToolCall(request);
      }
    );
  }

  private getToolDefinitions(): Tool[] {
    return [
      {
        name: 'pimclaw_list_components',
        description: 'List all active PimClaw components and their status',
        inputSchema: {
          type: 'object' as const,
          properties: {
            componentType: {
              type: 'string',
              description:
                'Filter by component type (scheduler, recorder, worker)',
            },
          },
        },
      },
      {
        name: 'pimclaw_component_status',
        description: 'Get detailed status of a specific PimClaw component',
        inputSchema: {
          type: 'object' as const,
          properties: {
            componentId: {
              type: 'string',
              description: 'The ID of the component',
            },
          },
          required: ['componentId'],
        },
      },
      {
        name: 'pimclaw_health',
        description: 'Get overall health report for all components',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'pimclaw_list_tasks',
        description: 'List tasks by status',
        inputSchema: {
          type: 'object' as const,
          properties: {
            status: {
              type: 'string',
              description:
                'Filter by status (planning, ready, scheduling, scheduled, running, done, failed, expired)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of tasks to return',
            },
          },
        },
      },
      {
        name: 'pimclaw_task_details',
        description: 'Get detailed information about a specific task',
        inputSchema: {
          type: 'object' as const,
          properties: {
            taskId: {
              type: 'string',
              description: 'The ID of the task',
            },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'pimclaw_inject_task',
        description: 'Manually inject a new task into the system',
        inputSchema: {
          type: 'object' as const,
          properties: {
            llmDeploymentName: {
              type: 'string',
              description: 'The target LLM deployment',
            },
            taskType: {
              type: 'string',
              description: 'Type of task (scale-up, scale-down, restart, etc)',
            },
            priority: {
              type: 'string',
              description: 'Task priority (low, medium, high)',
            },
            taskData: {
              type: 'object',
              description: 'Task-specific data payload',
            },
          },
          required: ['llmDeploymentName', 'taskType'],
        },
      },
      {
        name: 'pimclaw_retry_task',
        description: 'Reset a failed task for retry',
        inputSchema: {
          type: 'object' as const,
          properties: {
            taskId: {
              type: 'string',
              description: 'The ID of the task to retry',
            },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'pimclaw_revoke_task',
        description: 'Revoke a pending task',
        inputSchema: {
          type: 'object' as const,
          properties: {
            taskId: {
              type: 'string',
              description: 'The ID of the task to revoke',
            },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'pimclaw_task_counts',
        description: 'Get counts of tasks by status',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
    ];
  }

  private async handleToolCall(request: any): Promise<{
    content: TextContent[];
  }> {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'pimclaw_list_components':
          result = this.listComponents(args);
          break;
        case 'pimclaw_component_status':
          result = this.componentStatus(args);
          break;
        case 'pimclaw_health':
          result = this.healthReport();
          break;
        case 'pimclaw_list_tasks':
          result = await this.listTasks(args);
          break;
        case 'pimclaw_task_details':
          result = await this.taskDetails(args);
          break;
        case 'pimclaw_inject_task':
          result = await this.injectTask(args);
          break;
        case 'pimclaw_retry_task':
          result = await this.retryTask(args);
          break;
        case 'pimclaw_revoke_task':
          result = await this.revokeTask(args);
          break;
        case 'pimclaw_task_counts':
          result = this.taskCounts();
          break;
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new McpError(ErrorCode.InternalError, message);
    }
  }

  private listComponents(args: any): unknown {
    const allComponents = this.registry.getAllAgentsStatus();
    if (args.componentType) {
      return allComponents.filter((a) => a.agentType === args.componentType);
    }
    return allComponents;
  }

  private componentStatus(args: any): unknown {
    return this.registry.getAgentStatus(args.componentId);
  }

  private healthReport(): unknown {
    return this.registry.getHealthReport();
  }

  private async listTasks(args: any): Promise<unknown> {
    const limit = args.limit || 10;
    if (args.status) {
      return this.taskRecorder
        .getTasksByStatus(args.status)
        .slice(0, limit);
    }
    return this.taskRecorder.getAllTasks().slice(0, limit);
  }

  private async taskDetails(args: any): Promise<unknown> {
    return this.taskRecorder.getTask(args.taskId);
  }

  private async injectTask(args: any): Promise<unknown> {
    const task: Task = {
      taskId: uuidv4(),
      status: 'ready',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: args.priority || 'medium',
      llmDeploymentName: args.llmDeploymentName,
      taskType: args.taskType,
      taskData: args.taskData || {},
      retryCount: 0,
      maxRetries: 3,
    };
    await this.taskRecorder.createTask(task);
    return { success: true, taskId: task.taskId };
  }

  private async retryTask(args: any): Promise<unknown> {
    await this.taskRecorder.resetTaskForRetry(args.taskId);
    return { success: true, taskId: args.taskId };
  }

  private async revokeTask(args: any): Promise<unknown> {
    await this.taskRecorder.updateTaskStatus(args.taskId, 'expired');
    return { success: true, taskId: args.taskId };
  }

  private taskCounts(): unknown {
    return this.taskRecorder.getTaskCounts();
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('[PimClaw MCP Server] Started and listening on stdio');
  }
}

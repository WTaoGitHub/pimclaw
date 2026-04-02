/**
 * PimClaw MCP Server
 * Exposes all PimClaw tools via the Model Context Protocol
 * Enables other frameworks to use PimClaw as an MCP service
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
import { AgentRegistry } from './agent-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { Task } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * PimClaw MCP Server
 */
export class PimClawMCPServer {
  private server: Server;
  private registry: AgentRegistry;
  private taskRecorder: TaskStatusRecorder;

  constructor(registry: AgentRegistry, taskRecorder: TaskStatusRecorder) {
    this.registry = registry;
    this.taskRecorder = taskRecorder;

    this.server = new Server(
      { name: 'pimclaw-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  /**
   * Setup request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        return await this.handleToolCall(request);
      }
    );
  }

  /**
   * Get all available tool definitions
   */
  private getToolDefinitions(): Tool[] {
    return [
      // Agent management tools
      {
        name: 'pimclaw_list_agents',
        description: 'List all active agents and their status',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agentType: {
              type: 'string',
              description:
                'Filter by agent type (head, scheduler, recorder, worker)',
            },
          },
        },
      },
      {
        name: 'pimclaw_agent_status',
        description: 'Get detailed status of a specific agent',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agentId: {
              type: 'string',
              description: 'The ID of the agent',
            },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'pimclaw_health_report',
        description: 'Get overall health report for all agents',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },

      // Task management tools
      {
        name: 'pimclaw_list_tasks',
        description: 'List tasks by status',
        inputSchema: {
          type: 'object' as const,
          properties: {
            status: {
              type: 'string',
              description:
                'Filter by status (ready, scheduling, scheduled, running, done, failed, expired)',
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

      // Task counting tool
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

  /**
   * Handle tool calls
   */
  private async handleToolCall(request: any): Promise<{
    content: TextContent[];
  }> {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        // Agent tools
        case 'pimclaw_list_agents':
          result = this.listAgents(args);
          break;
        case 'pimclaw_agent_status':
          result = this.agentStatus(args);
          break;
        case 'pimclaw_health_report':
          result = this.healthReport();
          break;

        // Task tools
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

  /**
   * List all agents
   */
  private listAgents(args: any): unknown {
    const allAgents = this.registry.getAllAgentsStatus();
    if (args.agentType) {
      return allAgents.filter((a) => a.agentType === args.agentType);
    }
    return allAgents;
  }

  /**
   * Get agent status
   */
  private agentStatus(args: any): unknown {
    return this.registry.getAgentStatus(args.agentId);
  }

  /**
   * Get health report
   */
  private healthReport(): unknown {
    return this.registry.getHealthReport();
  }

  /**
   * List tasks
   */
  private async listTasks(args: any): Promise<unknown> {
    const limit = args.limit || 10;
    if (args.status) {
      return this.taskRecorder
        .getTasksByStatus(args.status)
        .slice(0, limit);
    }
    return this.taskRecorder.getAllTasks().slice(0, limit);
  }

  /**
   * Get task details
   */
  private async taskDetails(args: any): Promise<unknown> {
    return this.taskRecorder.getTask(args.taskId);
  }

  /**
   * Inject a new task
   */
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

  /**
   * Retry a failed task
   */
  private async retryTask(args: any): Promise<unknown> {
    await this.taskRecorder.resetTaskForRetry(args.taskId);
    return { success: true, taskId: args.taskId };
  }

  /**
   * Revoke a task
   */
  private async revokeTask(args: any): Promise<unknown> {
    await this.taskRecorder.updateTaskStatus(args.taskId, 'expired');
    return { success: true, taskId: args.taskId };
  }

  /**
   * Get task counts
   */
  private taskCounts(): unknown {
    return this.taskRecorder.getTaskCounts();
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('[PimClaw MCP Server] Started and listening on stdio');
  }
}

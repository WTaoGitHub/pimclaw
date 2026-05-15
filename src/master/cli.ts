#!/usr/bin/env node

/**
 * PimClaw CLI Tool — v2
 * Shell-based interface for operators to interact with PimClaw.
 * Commands: pimclaw {components|tasks|mcp|health}
 */

import { program } from 'commander';
import { ComponentRegistry } from './component-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { Task } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

let registry: ComponentRegistry;
let taskRecorder: TaskStatusRecorder;

async function initializeCLI(): Promise<void> {
  registry = new ComponentRegistry();
  taskRecorder = new TaskStatusRecorder();
  await taskRecorder.initialize();
}

function setupCommands(): void {
  // COMPONENT COMMANDS
  program
    .command('components')
    .description('Component management commands')
    .command('list')
    .option('--type <type>', 'Filter by component type')
    .description('List all components')
    .action((options) => {
      const components = registry.getAllAgentsStatus();
      const filtered = options.type
        ? components.filter((a) => a.agentType === options.type)
        : components;
      console.log(JSON.stringify(filtered, null, 2));
    });

  program
    .command('components:status <componentId>')
    .description('Get status of specific component')
    .action((componentId) => {
      const status = registry.getAgentStatus(componentId);
      console.log(JSON.stringify(status, null, 2));
    });

  // TASKS COMMANDS
  program
    .command('tasks')
    .description('Task management commands')
    .command('list')
    .option('--status <status>', 'Filter by task status')
    .option('--limit <n>', 'Maximum tasks to show', '10')
    .description('List tasks')
    .action(async (options) => {
      const limit = parseInt(options.limit);
      console.log(JSON.stringify(taskRecorder.getRecentTasks(limit, options.status), null, 2));
    });

  program
    .command('tasks:details <taskId>')
    .description('Get task details')
    .action((taskId) => {
      const task = taskRecorder.getTask(taskId);
      console.log(JSON.stringify(task, null, 2));
    });

  program
    .command('tasks:inject')
    .requiredOption(
      '--deployment <name>',
      'LLM deployment name'
    )
    .requiredOption('--type <type>', 'Task type (scale-up, scale-down, etc)')
    .option('--priority <priority>', 'Task priority', 'medium')
    .option('--data <json>', 'Task data as JSON')
    .description('Inject a new task')
    .action(async (options) => {
      const task: Task = {
        taskId: uuidv4(),
        status: 'ready',
        createdAt: new Date(),
        statusModifiedAt: new Date(),
        priority: options.priority as any,
        llmDeploymentName: options.deployment,
        taskType: options.type,
        taskData: options.data ? JSON.parse(options.data) : {},
        retryCount: 0,
        maxRetries: 3,
      };
      await taskRecorder.createTask(task);
      console.log(JSON.stringify({ success: true, taskId: task.taskId }, null, 2));
    });

  program
    .command('tasks:retry <taskId>')
    .description('Retry a failed task')
    .action(async (taskId) => {
      await taskRecorder.resetTaskForRetry(taskId);
      console.log(JSON.stringify({ success: true, taskId }, null, 2));
    });

  program
    .command('tasks:revoke <taskId>')
    .description('Revoke a pending task')
    .action(async (taskId) => {
      await taskRecorder.updateTaskStatus(taskId, 'expired');
      console.log(JSON.stringify({ success: true, taskId }, null, 2));
    });

  program
    .command('tasks:counts')
    .description('Get task counts by status')
    .action(() => {
      const counts = taskRecorder.getTaskCounts();
      console.log(JSON.stringify(counts, null, 2));
    });

  // MCP COMMANDS
  program
    .command('mcp')
    .description('MCP service interaction')
    .command('list')
    .description('List available MCP services')
    .action(() => {
      const agents = registry.getAllAgentsStatus();
      const mcpServices = new Set<string>();
      agents.forEach((agent) => {
        Object.keys(agent.mcpConnections || {}).forEach((svc) =>
          mcpServices.add(svc)
        );
      });
      console.log(JSON.stringify(Array.from(mcpServices), null, 2));
    });

  program
    .command('mcp:tools <service>')
    .description('List tools for an MCP service')
    .action((service) => {
      // TODO: Connect to actual MCP service and list tools
      console.log(
        JSON.stringify(
          { error: `MCP service integration pending: ${service}` },
          null,
          2
        )
      );
    });

  program
    .command('mcp:call <service> <tool>')
    .option('--params <json>', 'Tool parameters as JSON')
    .description('Call an MCP tool')
    .action((service, tool, options) => {
      // TODO: Connect to actual MCP service and call tool
      console.log(
        JSON.stringify(
          {
            error: `MCP tool call pending: ${service}.${tool}`,
            params: options.params ? JSON.parse(options.params) : {},
          },
          null,
          2
        )
      );
    });

  // HEALTH COMMAND
  program
    .command('health')
    .description('Get overall system health report')
    .action(() => {
      const report = registry.getHealthReport();
      console.log(JSON.stringify(report, null, 2));
    });

  // Parse and run
  program.parse(process.argv);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    await initializeCLI();
    setupCommands();
  } catch (error) {
    console.error(
      'CLI Error:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main();

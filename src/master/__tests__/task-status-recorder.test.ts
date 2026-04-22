/**
 * TaskStatusRecorder Tests
 * Validates task persistence, state machine, and stale task cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStatusRecorder } from '../../master/task-status-recorder.js';
import type { PlannerMemoryEpisode, PlannerMemoryIndex, PlannerMemoryLesson, TaskFeedback } from '../../types/index.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('TaskStatusRecorder', () => {
  let recorder: TaskStatusRecorder;
  const testDir = path.join('./test-data', `recorder-${uuidv4()}`);

  beforeEach(async () => {
    // Create isolated test environment
    await fs.mkdir(testDir, { recursive: true });
    recorder = new TaskStatusRecorder();
    // Override storage path for testing
    (recorder as any).storagePath = testDir;
    await recorder.initialize();
  });

  afterEach(async () => {
    // Cleanup test data
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should create a new task', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: { factor: 2 },
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    const retrieved = recorder.getTask(task.taskId);

    expect(retrieved).toBeDefined();
    expect(retrieved?.taskId).toBe(task.taskId);
    expect(retrieved?.status).toBe('ready');
  });

  it('should update task status', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    await recorder.updateTaskStatus(task.taskId, 'scheduling');

    const updated = recorder.getTask(task.taskId);
    expect(updated?.status).toBe('scheduling');
    expect(updated?.statusModifiedAt.getTime()).toBeGreaterThanOrEqual(
      task.createdAt.getTime()
    );
  });

  it('should retrieve tasks by status', async () => {
    const readyTask1 = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'high' as const,
      llmDeploymentName: 'deployment-1',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    const readyTask2 = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'low' as const,
      llmDeploymentName: 'deployment-2',
      taskType: 'scale-down',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    const schedulingTask = {
      taskId: uuidv4(),
      status: 'scheduling' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'deployment-3',
      taskType: 'restart',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(readyTask1);
    await recorder.createTask(readyTask2);
    await recorder.createTask(schedulingTask);

    const readyTasks = recorder.getTasksByStatus('ready');
    expect(readyTasks).toHaveLength(2);
    expect(readyTasks.every((t) => t.status === 'ready')).toBe(true);

    const schedulingTasks = recorder.getTasksByStatus('scheduling');
    expect(schedulingTasks).toHaveLength(1);
  });

  it('should update task result', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'running' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    await recorder.updateTaskResult(
      task.taskId,
      { newScale: 4, executedAt: new Date() },
      null,
    );

    const updated = recorder.getTask(task.taskId);
    expect(updated?.status).toBe('done');
    expect(updated?.result).toBeDefined();
    expect((updated?.result as any).newScale).toBe(4);
  });

  it('should persist tasks to file', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    await recorder.persist();

    const tasksFile = path.join(testDir, 'tasks.json');
    const content = await fs.readFile(tasksFile, 'utf-8');
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed[task.taskId]).toBeDefined();
    expect(parsed[task.taskId].taskId).toBe(task.taskId);
  });

  it('should persist and reload task feedback', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'done' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };
    const feedback: TaskFeedback = {
      version: 1,
      statusSummary: 'completed-successfully',
      outcome: 'helped',
      source: 'system',
      generatedAt: new Date(),
      summary: 'Scale-up completed successfully and should be considered for similar follow-ups.',
      details: {
        resultSignals: ['engine-change-applied'],
        recommendedCaution: 'Recheck perf evidence before repeating automatically.',
      },
    };

    await recorder.createTask(task);
    await recorder.updateTaskFeedback(task.taskId, feedback);

    const reloadedRecorder = new TaskStatusRecorder();
    (reloadedRecorder as any).storagePath = testDir;
    await reloadedRecorder.initialize();

    const reloadedTask = reloadedRecorder.getTask(task.taskId);
    expect(reloadedTask?.feedback).toBeDefined();
    expect(reloadedTask?.feedback?.outcome).toBe('helped');
    expect(reloadedTask?.feedback?.statusSummary).toBe('completed-successfully');
    expect(reloadedTask?.feedback?.summary).toContain('Scale-up completed successfully');
  });

  it('should expose planner memory types through the shared type barrel', () => {
    const feedback: TaskFeedback = {
      version: 1,
      statusSummary: 'unknown',
      outcome: 'unknown',
      source: 'system',
      generatedAt: new Date(),
      summary: 'No validated outcome yet.',
    };
    const episode: PlannerMemoryEpisode = {
      version: 1,
      episodeId: 'episode-1',
      taskId: 'task-1',
      deploymentName: 'deployment-1',
      taskType: 'scale-up',
      taskStatus: 'done',
      taskCreatedAt: new Date(),
      taskConfigSummary: 'replicas=2',
      anomalySummary: {
        metrics: ['ttft'],
        severities: ['high'],
        synopsis: 'TTFT spike',
      },
      feedback,
      outcomeClass: 'inconclusive',
      memoryTags: ['needs-review'],
    };
    const lesson: PlannerMemoryLesson = {
      version: 1,
      lessonId: 'lesson-1',
      deploymentScope: { deploymentName: 'deployment-1' },
      pattern: 'recent scale-up had inconclusive outcome',
      advice: 'Avoid repeating without stronger evidence.',
      confidence: 'low',
      supportingTaskIds: ['task-1'],
      supportingEpisodeIds: ['episode-1'],
      contradictedBy: [],
      lastValidatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      status: 'active',
    };
    const index: PlannerMemoryIndex = {
      version: 1,
      byDeployment: {
        'deployment-1': {
          deploymentName: 'deployment-1',
          recentEpisodeIds: ['episode-1'],
          activeLessonIds: ['lesson-1'],
          updatedAt: new Date(),
        },
      },
      recentEpisodeIds: ['episode-1'],
      activeLessonIds: ['lesson-1'],
      globalLessonIds: [],
      updatedAt: new Date(),
    };

    expect(episode.feedback?.summary).toBe('No validated outcome yet.');
    expect(lesson.supportingEpisodeIds).toContain('episode-1');
    expect(index.byDeployment['deployment-1'].activeLessonIds).toContain('lesson-1');
  });

  it('should get task counts', async () => {
    // Create tasks with different statuses
    const statusTasks: Record<string, any[]> = {
      ready: [],
      scheduling: [],
      scheduled: [],
      running: [],
    };

    for (const status of Object.keys(statusTasks)) {
      for (let i = 0; i < 2; i++) {
        const task = {
          taskId: uuidv4(),
          status: status as any,
          createdAt: new Date(),
          statusModifiedAt: new Date(),
          priority: 'medium' as const,
          llmDeploymentName: `deployment-${status}-${i}`,
          taskType: 'scale-up',
          taskData: {},
          retryCount: 0,
          maxRetries: 3,
        };
        statusTasks[status].push(task);
        await recorder.createTask(task);
      }
    }

    const counts = recorder.getTaskCounts();

    expect(counts.ready).toBe(2);
    expect(counts.scheduling).toBe(2);
    expect(counts.scheduled).toBe(2);
    expect(counts.running).toBe(2);
  });

  it('should mark stale ready tasks as expired on initialize', async () => {
    // Create an old ready task (created 2 minutes ago)
    const oldTask = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      statusModifiedAt: new Date(Date.now() - 2 * 60 * 1000),
      priority: 'medium' as const,
      llmDeploymentName: 'old-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(oldTask);
    await recorder.persist();

    // Create new recorder instance (should trigger cleanup)
    const newRecorder = new TaskStatusRecorder();
    (newRecorder as any).storagePath = testDir;
    await newRecorder.initialize();

    const task = newRecorder.getTask(oldTask.taskId);
    expect(task?.status).toBe('expired');
  });

  it('should reset task for retry', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'failed' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 1,
      maxRetries: 3,
      error: 'Previous execution failed',
    };

    await recorder.createTask(task as any);
    await recorder.resetTaskForRetry(task.taskId);

    const reset = recorder.getTask(task.taskId);
    expect(reset?.status).toBe('ready');
    expect(reset?.retryCount).toBe(2);
    expect(reset?.error).toBeUndefined();
  });
});

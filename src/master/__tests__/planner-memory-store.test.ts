import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { buildPlannerMemoryEpisodeFromTask, PlannerMemoryStore } from '../../master/planner-memory-store.js';
import type { PlannerMemoryLesson, Task } from '../../types/index.js';

describe('PlannerMemoryStore', () => {
  let tmpDir: string;
  let store: PlannerMemoryStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-planner-memory-'));
    store = new PlannerMemoryStore(tmpDir, 10, 10);
    await store.load();
  });

  it('builds an episode from a task with feedback and anomaly metadata', () => {
    const task: Task = {
      taskId: 'task-1',
      status: 'done',
      createdAt: new Date('2026-04-22T00:00:00.000Z'),
      statusModifiedAt: new Date('2026-04-22T00:10:00.000Z'),
      priority: 'high',
      llmDeploymentName: 'deployment-1',
      taskType: 'scale-up',
      taskData: {
        events: [
          {
            eventId: 'event-1',
            metricName: 'ttft',
            severity: 'high',
          },
        ],
      },
      config: { replicaDelta: 1 },
      reasoning: 'Selected the smallest conservative scale-up.',
      perfEvidence: 'Historical perf shows lower TTFT with one additional replica.',
      simulationResults: 'Simulation predicts improved TTFT under current load.',
      retryCount: 0,
      maxRetries: 3,
      completedAt: new Date('2026-04-22T00:10:00.000Z'),
      result: { success: true },
      feedback: {
        version: 1,
        statusSummary: 'completed-successfully',
        outcome: 'helped',
        source: 'system',
        generatedAt: new Date('2026-04-22T00:11:00.000Z'),
        summary: 'Operationally successful.',
      },
    };

    const episode = buildPlannerMemoryEpisodeFromTask(task);

    expect(episode.episodeId).toBe('task-1');
    expect(episode.anomalySummary.metrics).toEqual(['ttft']);
    expect(episode.feedback?.outcome).toBe('helped');
    expect(episode.outcomeClass).toBe('successful-improvement');
    expect(episode.memoryTags).toContain('recent-success');
  });

  it('persists episodes and lessons and rebuilds the deployment index', async () => {
    const episode = buildPlannerMemoryEpisodeFromTask({
      taskId: 'task-2',
      status: 'failed',
      createdAt: new Date('2026-04-22T01:00:00.000Z'),
      statusModifiedAt: new Date('2026-04-22T01:05:00.000Z'),
      priority: 'high',
      llmDeploymentName: 'deployment-2',
      taskType: 'restart',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
      error: 'engine unavailable',
      feedback: {
        version: 1,
        statusSummary: 'execution-failed',
        outcome: 'failed-operationally',
        source: 'system',
        generatedAt: new Date('2026-04-22T01:05:30.000Z'),
        summary: 'Operational failure.',
      },
    });
    const lesson: PlannerMemoryLesson = {
      version: 1,
      lessonId: 'lesson-1',
      deploymentScope: { deploymentName: 'deployment-2', taskType: 'restart' },
      pattern: 'restart failed operationally',
      advice: 'Review executor or engine availability before repeating.',
      confidence: 'medium',
      supportingTaskIds: ['task-2'],
      supportingEpisodeIds: ['task-2'],
      contradictedBy: [],
      lastValidatedAt: new Date('2026-04-22T01:06:00.000Z'),
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      status: 'active',
    };

    store.upsertEpisode(episode);
    store.upsertLesson(lesson);
    await store.flush();

    const reloadedStore = new PlannerMemoryStore(tmpDir, 10, 10);
    await reloadedStore.load();

    expect(reloadedStore.episodeCount).toBe(1);
    expect(reloadedStore.lessonCount).toBe(1);
    expect(reloadedStore.getRecentEpisodes('deployment-2', 5)[0]?.episodeId).toBe('task-2');
    expect(reloadedStore.getActiveLessons('deployment-2', 5)[0]?.lessonId).toBe('lesson-1');

    const index = reloadedStore.getIndex();
    expect(index.byDeployment['deployment-2'].recentEpisodeIds).toContain('task-2');
    expect(index.byDeployment['deployment-2'].activeLessonIds).toContain('lesson-1');
  });

  it('synthesizes an auto-lesson from repeated similar episode outcomes', () => {
    store.upsertEpisode(buildPlannerMemoryEpisodeFromTask({
      taskId: 'task-a',
      status: 'failed',
      createdAt: new Date('2026-04-22T01:00:00.000Z'),
      statusModifiedAt: new Date('2026-04-22T01:00:00.000Z'),
      priority: 'high',
      llmDeploymentName: 'deployment-3',
      taskType: 'restart',
      taskData: { events: [{ metricName: 'error_rate', severity: 'high' }] },
      retryCount: 0,
      maxRetries: 3,
      feedback: {
        version: 1,
        statusSummary: 'execution-failed',
        outcome: 'failed-operationally',
        source: 'system',
        generatedAt: new Date('2026-04-22T01:00:10.000Z'),
        summary: 'First restart failed operationally.',
      },
    }));
    store.upsertEpisode(buildPlannerMemoryEpisodeFromTask({
      taskId: 'task-b',
      status: 'failed',
      createdAt: new Date('2026-04-22T02:00:00.000Z'),
      statusModifiedAt: new Date('2026-04-22T02:00:00.000Z'),
      priority: 'high',
      llmDeploymentName: 'deployment-3',
      taskType: 'restart',
      taskData: { events: [{ metricName: 'error_rate', severity: 'high' }] },
      retryCount: 0,
      maxRetries: 3,
      feedback: {
        version: 1,
        statusSummary: 'execution-failed',
        outcome: 'failed-operationally',
        source: 'system',
        generatedAt: new Date('2026-04-22T02:00:10.000Z'),
        summary: 'Second restart failed operationally.',
      },
    }));

    const lesson = store.getActiveLessons('deployment-3', 5)[0];
    expect(lesson).toBeDefined();
    expect(lesson?.lessonId).toBe('auto:deployment-3:restart:operational-failure');
    expect(lesson?.supportingTaskIds).toEqual(['task-b', 'task-a']);
    expect(lesson?.status).toBe('active');
    expect(lesson?.confidence).toBe('low');
  });

  it('marks an auto-lesson as contradicted when opposing outcomes catch up', () => {
    for (const [taskId, outcome, createdAt] of [
      ['task-c', 'failed-operationally', '2026-04-22T01:00:00.000Z'],
      ['task-d', 'failed-operationally', '2026-04-22T02:00:00.000Z'],
      ['task-e', 'helped', '2026-04-22T03:00:00.000Z'],
      ['task-f', 'helped', '2026-04-22T04:00:00.000Z'],
    ] as const) {
      store.upsertEpisode(buildPlannerMemoryEpisodeFromTask({
        taskId,
        status: outcome === 'helped' ? 'done' : 'failed',
        createdAt: new Date(createdAt),
        statusModifiedAt: new Date(createdAt),
        priority: 'high',
        llmDeploymentName: 'deployment-4',
        taskType: 'scale-up',
        taskData: { events: [{ metricName: 'ttft', severity: 'high' }] },
        retryCount: 0,
        maxRetries: 3,
        feedback: {
          version: 1,
          statusSummary: outcome === 'helped' ? 'completed-successfully' : 'execution-failed',
          outcome,
          source: 'system',
          generatedAt: new Date(createdAt),
          summary: `Outcome ${outcome}`,
        },
      }));
    }

    const failureLesson = store
      .getIndex()
      .activeLessonIds
      .includes('auto:deployment-4:scale-up:operational-failure');
    expect(failureLesson).toBe(false);

    const contradictoryLesson = (store as any).lessons.find(
      (lesson: PlannerMemoryLesson) => lesson.lessonId === 'auto:deployment-4:scale-up:operational-failure',
    ) as PlannerMemoryLesson | undefined;
    expect(contradictoryLesson?.status).toBe('contradicted');
    expect(contradictoryLesson?.contradictedBy).toEqual(['task-f', 'task-e']);

    const successLesson = store.getActiveLessons('deployment-4', 5).find(
      (lesson) => lesson.lessonId === 'auto:deployment-4:scale-up:successful-improvement',
    );
    expect(successLesson?.status).toBe('active');
    expect(successLesson?.supportingTaskIds).toEqual(['task-f', 'task-e']);
  });

  it('enforces deployment-scoped retrieval limits for recent episodes and active lessons', () => {
    for (let index = 0; index < 6; index += 1) {
      store.upsertEpisode(buildPlannerMemoryEpisodeFromTask({
        taskId: `task-limit-${index}`,
        status: 'failed',
        createdAt: new Date(`2026-04-22T0${index}:00:00.000Z`),
        statusModifiedAt: new Date(`2026-04-22T0${index}:00:00.000Z`),
        priority: 'high',
        llmDeploymentName: 'deployment-5',
        taskType: index < 3 ? 'restart' : 'scale-up',
        taskData: { events: [{ metricName: 'ttft', severity: 'high' }] },
        retryCount: 0,
        maxRetries: 3,
        feedback: {
          version: 1,
          statusSummary: 'execution-failed',
          outcome: 'failed-operationally',
          source: 'system',
          generatedAt: new Date(`2026-04-22T0${index}:00:10.000Z`),
          summary: `Outcome ${index}`,
        },
      }));
    }

    const limitedEpisodes = store.getRecentEpisodes('deployment-5', 5);
    const limitedLessons = store.getActiveLessons('deployment-5', 3);

    expect(limitedEpisodes).toHaveLength(5);
    expect(limitedEpisodes[0]?.taskId).toBe('task-limit-5');
    expect(limitedEpisodes[4]?.taskId).toBe('task-limit-1');
    expect(limitedLessons.length).toBeLessThanOrEqual(3);
    expect(limitedLessons.every((lesson) => lesson.deploymentScope.deploymentName === 'deployment-5')).toBe(true);
  });
});
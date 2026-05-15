import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS,
  DEFAULT_HEAD_FEEDBACK_VALIDITY_MS,
  buildHeadTaskFeedbackRow,
  deriveHeadFollowupOutcome,
  getHeadTaskFeedbackReviewState,
  summarizeMetricAssessments,
} from '../head-task-feedback.js';
import type { Task } from '../../types/index.js';

function makeDoneTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task-1',
    status: 'done',
    createdAt: new Date('2026-04-22T00:00:00.000Z'),
    statusModifiedAt: new Date('2026-04-22T00:10:00.000Z'),
    priority: 'high',
    llmDeploymentName: 'minimax-m2-1-prod',
    taskType: 'scale-up',
    taskData: {},
    retryCount: 0,
    maxRetries: 3,
    completedAt: new Date('2026-04-22T00:10:00.000Z'),
    ...overrides,
  };
}

describe('head-task-feedback helpers', () => {
  it('marks tasks too early before the settling delay ends', () => {
    const task = makeDoneTask();
    const state = getHeadTaskFeedbackReviewState(
      task,
      new Date(task.completedAt!.getTime() + DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS - 1),
    );

    expect(state).toBe('too-early');
  });

  it('marks tasks eligible inside the review window', () => {
    const task = makeDoneTask();
    const state = getHeadTaskFeedbackReviewState(
      task,
      new Date(task.completedAt!.getTime() + DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS + 1),
    );

    expect(state).toBe('eligible');
  });

  it('marks tasks expired once the feedback validity window passes', () => {
    const task = makeDoneTask();
    const state = getHeadTaskFeedbackReviewState(
      task,
      new Date(task.completedAt!.getTime() + DEFAULT_HEAD_FEEDBACK_VALIDITY_MS + 1),
    );

    expect(state).toBe('expired-for-review');
  });

  it('marks tasks already reviewed once head feedback exists', () => {
    const task = makeDoneTask({
      feedback: {
        version: 1,
        statusSummary: 'completed-successfully',
        outcome: 'helped',
        source: 'head-followup',
        generatedAt: new Date('2026-04-22T00:20:00.000Z'),
        summary: 'Head already reviewed this task.',
      },
    });

    expect(getHeadTaskFeedbackReviewState(task, new Date('2026-04-22T00:30:00.000Z'))).toBe('already-reviewed');
  });

  it('builds compact metric summaries and applied rows', () => {
    const task = makeDoneTask();
    const metricAssessments = [
      { metricName: 'ttft', direction: 'improved' as const },
      { metricName: 'qps', direction: 'unchanged' as const },
    ];

    expect(summarizeMetricAssessments(metricAssessments)).toBe('ttft improved, qps unchanged');

    expect(
      buildHeadTaskFeedbackRow(
        task,
        'applied',
        'TTFT down 42% versus trigger window',
        metricAssessments,
        'helped',
      ),
    ).toEqual({
      taskId: 'task-1',
      deploymentName: 'minimax-m2-1-prod',
      taskType: 'scale-up',
      reviewState: 'applied',
      outcome: 'helped',
      keyMetrics: 'ttft improved, qps unchanged',
      observation: 'TTFT down 42% versus trigger window',
    });
  });

  it('derives helped when metrics improve without regressions', () => {
    expect(
      deriveHeadFollowupOutcome([
        { metricName: 'ttft', direction: 'improved' },
        { metricName: 'qps', direction: 'unchanged' },
      ]),
    ).toBe('helped');
  });

  it('derives worsened when a critical metric regresses', () => {
    expect(
      deriveHeadFollowupOutcome([
        { metricName: 'ttft', direction: 'regressed' },
        { metricName: 'qps', direction: 'improved' },
      ]),
    ).toBe('worsened');
  });

  it('derives no-effect for mixed non-critical signals', () => {
    expect(
      deriveHeadFollowupOutcome([
        { metricName: 'ttft', direction: 'improved' },
        { metricName: 'qps', direction: 'regressed' },
      ]),
    ).toBe('no-effect');
  });

  it('derives no-effect when all assessed metrics are unchanged', () => {
    expect(
      deriveHeadFollowupOutcome([
        { metricName: 'ttft', direction: 'unchanged' },
        { metricName: 'qps', direction: 'unknown' },
      ]),
    ).toBe('no-effect');
  });

  it('falls back to unknown when no metrics are assessable', () => {
    expect(
      deriveHeadFollowupOutcome([
        { metricName: 'ttft', direction: 'unknown' },
      ]),
    ).toBe('unknown');
  });
});
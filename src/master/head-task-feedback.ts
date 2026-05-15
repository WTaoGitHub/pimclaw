import type {
  Task,
  TaskFeedbackMetricAssessment,
  TaskFeedbackOutcome,
} from '../types/index.js';
import type {
  HeadTaskFeedbackReviewState,
  HeadTaskFeedbackRow,
} from './head-summary-store.js';

export const DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS = 15 * 60 * 1000;
export const DEFAULT_HEAD_FEEDBACK_VALIDITY_MS = 60 * 60 * 1000;

export type HeadTaskFeedbackEligibilityState =
  | 'eligible'
  | 'ineligible'
  | HeadTaskFeedbackReviewState;

export function getHeadTaskFeedbackReviewState(
  task: Task,
  now: Date,
  settlingDelayMs: number = DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS,
  feedbackValidityMs: number = DEFAULT_HEAD_FEEDBACK_VALIDITY_MS,
): HeadTaskFeedbackEligibilityState {
  if (task.status !== 'done' || !task.completedAt || !task.llmDeploymentName.trim()) {
    return 'ineligible';
  }

  if (task.feedback?.source === 'head-followup') {
    return 'already-reviewed';
  }

  const completedAtMs = new Date(task.completedAt).getTime();
  const nowMs = now.getTime();

  if (nowMs < completedAtMs + settlingDelayMs) {
    return 'too-early';
  }

  if (nowMs > completedAtMs + feedbackValidityMs) {
    return 'expired-for-review';
  }

  return 'eligible';
}

export function summarizeMetricAssessments(
  metricAssessments: TaskFeedbackMetricAssessment[] | undefined,
): string {
  if (!metricAssessments || metricAssessments.length === 0) {
    return '-';
  }

  return metricAssessments
    .map((assessment) => `${assessment.metricName} ${assessment.direction}`)
    .join(', ');
}

export function deriveHeadFollowupOutcome(
  metricAssessments: TaskFeedbackMetricAssessment[] | undefined,
  fallbackOutcome: TaskFeedbackOutcome = 'unknown',
): 'helped' | 'no-effect' | 'worsened' | 'unknown' {
  if (!metricAssessments || metricAssessments.length === 0) {
    return fallbackOutcome === 'failed-operationally' ? 'unknown' : fallbackOutcome;
  }

  const assessable = metricAssessments.filter((assessment) => assessment.direction !== 'unknown');
  if (assessable.length === 0) {
    return 'unknown';
  }

  const hasCriticalRegression = assessable.some(
    (assessment) =>
      assessment.direction === 'regressed'
      && (assessment.metricName === 'ttft' || assessment.metricName === 'error_rate'),
  );
  if (hasCriticalRegression) {
    return 'worsened';
  }

  const improvedCount = assessable.filter((assessment) => assessment.direction === 'improved').length;
  const regressedCount = assessable.filter((assessment) => assessment.direction === 'regressed').length;
  const unchangedCount = assessable.filter((assessment) => assessment.direction === 'unchanged').length;

  if (improvedCount > 0 && regressedCount === 0) {
    return 'helped';
  }

  if (regressedCount > 0 && improvedCount === 0) {
    return 'worsened';
  }

  if (improvedCount > 0 && regressedCount > 0) {
    return 'no-effect';
  }

  if (unchangedCount > 0) {
    return 'no-effect';
  }

  return 'unknown';
}

export function buildHeadTaskFeedbackRow(
  task: Task,
  reviewState: HeadTaskFeedbackReviewState,
  summary: string,
  metricAssessments: TaskFeedbackMetricAssessment[] | undefined,
  outcome: 'helped' | 'no-effect' | 'worsened' | 'unknown' | null,
): HeadTaskFeedbackRow {
  return {
    taskId: task.taskId,
    deploymentName: task.llmDeploymentName,
    taskType: task.taskType,
    reviewState,
    outcome: reviewState === 'applied' ? outcome : null,
    keyMetrics: summarizeMetricAssessments(metricAssessments),
    observation: summary.trim() || `Task ${task.taskId} review state: ${reviewState}`,
  };
}
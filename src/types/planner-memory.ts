import type { PlannerMetricName, TaskFeedback, TaskStatus } from './tasks.js';

export type PlannerMemoryEpisodeVersion = 1;

export type PlannerMemoryTag =
  | 'recent-failure'
  | 'recent-success'
  | 'needs-review'
  | 'fallback-plan'
  | 'perf-data-unavailable'
  | 'sim-data-unavailable'
  | 'repeat-pattern'
  | 'contradicted-lesson';

export type PlannerMemoryOutcomeClass =
  | 'successful-improvement'
  | 'successful-no-effect'
  | 'successful-regression'
  | 'operational-failure'
  | 'inconclusive';

export interface PlannerMemoryEvidenceSummary {
  available: boolean;
  summary: string;
  source:
    | 'planner-reasoning'
    | 'perf-evidence'
    | 'simulation-results'
    | 'task-feedback';
}

export interface PlannerMemoryAnomalySummary {
  eventIds?: string[];
  metrics: PlannerMetricName[];
  severities: Array<'low' | 'medium' | 'high'>;
  synopsis: string;
}

export interface PlannerMemoryEpisode {
  version: PlannerMemoryEpisodeVersion;
  episodeId: string;
  taskId: string;
  deploymentName: string;
  taskType: string;
  taskStatus: TaskStatus;
  taskCreatedAt: Date;
  taskCompletedAt?: Date;
  taskConfigSummary: string;
  anomalySummary: PlannerMemoryAnomalySummary;
  feedback?: TaskFeedback;
  reasoningSummary?: string;
  perfEvidenceSummary?: PlannerMemoryEvidenceSummary;
  simulationSummary?: PlannerMemoryEvidenceSummary;
  outcomeClass: PlannerMemoryOutcomeClass;
  memoryTags: PlannerMemoryTag[];
  derivedFromTaskVersion?: number;
}

export type PlannerMemoryLessonVersion = 1;

export type PlannerMemoryLessonStatus =
  | 'active'
  | 'contradicted'
  | 'expired'
  | 'superseded';

export type PlannerMemoryLessonConfidence = 'low' | 'medium' | 'high';

export interface PlannerMemoryScope {
  deploymentName?: string;
  taskType?: string;
  metricNames?: PlannerMetricName[];
}

export interface PlannerMemoryLesson {
  version: PlannerMemoryLessonVersion;
  lessonId: string;
  deploymentScope: PlannerMemoryScope;
  pattern: string;
  advice: string;
  confidence: PlannerMemoryLessonConfidence;
  supportingTaskIds: string[];
  supportingEpisodeIds: string[];
  contradictedBy: string[];
  lastValidatedAt: Date;
  expiresAt: Date;
  status: PlannerMemoryLessonStatus;
}

export type PlannerMemoryIndexVersion = 1;

export interface PlannerMemoryIndexDeploymentEntry {
  deploymentName: string;
  recentEpisodeIds: string[];
  activeLessonIds: string[];
  updatedAt: Date;
}

export interface PlannerMemoryIndex {
  version: PlannerMemoryIndexVersion;
  byDeployment: Record<string, PlannerMemoryIndexDeploymentEntry>;
  recentEpisodeIds: string[];
  activeLessonIds: string[];
  globalLessonIds: string[];
  updatedAt: Date;
}
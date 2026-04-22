import fs from 'fs/promises';
import path from 'path';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import type {
  PlannerMemoryAnomalySummary,
  PlannerMemoryEpisode,
  PlannerMemoryLessonConfidence,
  PlannerMemoryLesson,
  PlannerMemoryIndex,
  PlannerMemoryIndexDeploymentEntry,
  PlannerMemoryLessonStatus,
  PlannerMemoryOutcomeClass,
  PlannerMemoryTag,
  Task,
} from '../types/index.js';

const AUTO_LESSON_PREFIX = 'auto:';
const LESSON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sortByCreatedAtDescending<T extends { taskCreatedAt: Date }>(records: T[]): T[] {
  return [...records].sort((left, right) => right.taskCreatedAt.getTime() - left.taskCreatedAt.getTime());
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function confidenceFromSupportCount(count: number): PlannerMemoryLessonConfidence {
  if (count >= 4) {
    return 'high';
  }
  if (count >= 3) {
    return 'medium';
  }
  return 'low';
}

function isAutoLesson(lesson: PlannerMemoryLesson): boolean {
  return lesson.lessonId.startsWith(AUTO_LESSON_PREFIX);
}

function lessonAdviceForOutcome(outcomeClass: PlannerMemoryOutcomeClass, deploymentName: string, taskType: string): string {
  switch (outcomeClass) {
    case 'successful-improvement':
      return `Recent ${taskType} tasks improved outcomes for ${deploymentName}; consider this tactic first when Perf and Simulator evidence also support it.`;
    case 'successful-no-effect':
      return `Recent ${taskType} tasks showed no clear effect for ${deploymentName}; require stronger evidence before repeating the same tactic.`;
    case 'successful-regression':
      return `Recent ${taskType} tasks regressed outcomes for ${deploymentName}; avoid repeating this tactic without strong counter-evidence.`;
    case 'operational-failure':
      return `Recent ${taskType} tasks failed operationally for ${deploymentName}; review execution health before repeating the same tactic.`;
    default:
      return `Recent ${taskType} tasks for ${deploymentName} remain inconclusive; use caution and rely on fresh evidence.`;
  }
}

function lessonPatternForOutcome(outcomeClass: PlannerMemoryOutcomeClass, taskType: string): string {
  switch (outcomeClass) {
    case 'successful-improvement':
      return `${taskType} repeatedly improved outcomes`;
    case 'successful-no-effect':
      return `${taskType} repeatedly showed no clear effect`;
    case 'successful-regression':
      return `${taskType} repeatedly regressed outcomes`;
    case 'operational-failure':
      return `${taskType} repeatedly failed operationally`;
    default:
      return `${taskType} remains inconclusive`;
  }
}

function determineLessonStatus(
  supportingEpisodes: PlannerMemoryEpisode[],
  contradictingEpisodes: PlannerMemoryEpisode[],
): PlannerMemoryLessonStatus {
  if (contradictingEpisodes.length === 0) {
    return 'active';
  }
  if (contradictingEpisodes.length > supportingEpisodes.length) {
    return 'contradicted';
  }
  if (contradictingEpisodes.length < supportingEpisodes.length) {
    return 'active';
  }

  const newestSupportingAt = supportingEpisodes[0]?.taskCreatedAt.getTime() ?? 0;
  const newestContradictingAt = contradictingEpisodes[0]?.taskCreatedAt.getTime() ?? 0;
  return newestContradictingAt >= newestSupportingAt ? 'contradicted' : 'active';
}

export function buildPlannerMemoryEpisodeFromTask(task: Task): PlannerMemoryEpisode {
  const anomalySummary = extractAnomalySummary(task);
  const memoryTags = deriveMemoryTags(task);

  return {
    version: 1,
    episodeId: task.taskId,
    taskId: task.taskId,
    deploymentName: task.llmDeploymentName,
    taskType: task.taskType,
    taskStatus: task.status,
    taskCreatedAt: task.createdAt,
    taskCompletedAt: task.completedAt,
    taskConfigSummary: JSON.stringify(task.config ?? {}),
    anomalySummary,
    feedback: task.feedback,
    reasoningSummary: task.reasoning,
    perfEvidenceSummary: task.perfEvidence
      ? {
          available: !task.perfEvidence.startsWith('UNAVAILABLE:'),
          summary: task.perfEvidence,
          source: 'perf-evidence',
        }
      : undefined,
    simulationSummary: task.simulationResults
      ? {
          available: !task.simulationResults.startsWith('UNAVAILABLE:'),
          summary: task.simulationResults,
          source: 'simulation-results',
        }
      : undefined,
    outcomeClass: deriveOutcomeClass(task),
    memoryTags,
    derivedFromTaskVersion: 1,
  };
}

function deriveOutcomeClass(task: Task): PlannerMemoryOutcomeClass {
  if (task.feedback?.outcome === 'failed-operationally' || task.status === 'failed' || task.status === 'expired') {
    return 'operational-failure';
  }
  if (task.feedback?.outcome === 'helped') {
    return 'successful-improvement';
  }
  if (task.feedback?.outcome === 'no-effect') {
    return 'successful-no-effect';
  }
  if (task.feedback?.outcome === 'worsened') {
    return 'successful-regression';
  }
  return 'inconclusive';
}

function deriveMemoryTags(task: Task): PlannerMemoryTag[] {
  const tags: PlannerMemoryTag[] = [];

  if (task.status === 'failed' || task.feedback?.outcome === 'failed-operationally') {
    tags.push('recent-failure');
  }
  if (task.status === 'done') {
    tags.push('recent-success');
  }
  if (task.feedback?.statusSummary === 'pending-review' || task.feedback?.outcome === 'unknown') {
    tags.push('needs-review');
  }
  if (task.reasoning?.includes('fallback') || task.reasoning?.includes('Fallback')) {
    tags.push('fallback-plan');
  }
  if (task.perfEvidence?.startsWith('UNAVAILABLE:')) {
    tags.push('perf-data-unavailable');
  }
  if (task.simulationResults?.startsWith('UNAVAILABLE:')) {
    tags.push('sim-data-unavailable');
  }

  return unique(tags);
}

function extractAnomalySummary(task: Task): PlannerMemoryAnomalySummary {
  const events = Array.isArray(task.taskData?.events) ? task.taskData.events as Array<Record<string, unknown>> : [];

  return {
    eventIds: events
      .map((event) => event.eventId)
      .filter((eventId): eventId is string => typeof eventId === 'string'),
    metrics: unique(
      events
        .map((event) => event.metricName)
        .filter((metric): metric is PlannerMemoryAnomalySummary['metrics'][number] => typeof metric === 'string'),
    ),
    severities: unique(
      events
        .map((event) => event.severity)
        .filter((severity): severity is PlannerMemoryAnomalySummary['severities'][number] => severity === 'low' || severity === 'medium' || severity === 'high'),
    ),
    synopsis: events.length > 0
      ? `${events.length} anomaly event(s) associated with task ${task.taskId}`
      : `No anomaly event metadata persisted for task ${task.taskId}`,
  };
}

export class PlannerMemoryStore {
  private readonly memoryDir: string;
  private readonly episodesFilePath: string;
  private readonly lessonsFilePath: string;
  private readonly indexFilePath: string;
  private readonly maxEpisodes: number;
  private readonly maxLessons: number;
  private episodes: PlannerMemoryEpisode[] = [];
  private lessons: PlannerMemoryLesson[] = [];
  private readonly logger: PluginLogger | null;
  private index: PlannerMemoryIndex = {
    version: 1,
    byDeployment: {},
    recentEpisodeIds: [],
    activeLessonIds: [],
    globalLessonIds: [],
    updatedAt: new Date(0),
  };
  private dirty = false;

  constructor(workspaceDir: string, maxEpisodes: number = 100, maxLessons: number = 100, logger?: PluginLogger) {
    this.maxEpisodes = maxEpisodes;
    this.maxLessons = maxLessons;
    this.memoryDir = path.join(workspaceDir, 'memory');
    this.episodesFilePath = path.join(this.memoryDir, 'episodes.json');
    this.lessonsFilePath = path.join(this.memoryDir, 'lessons.json');
    this.indexFilePath = path.join(this.memoryDir, 'index.json');
    this.logger = logger ?? null;
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger?.debug(`[PlannerMemoryStore] ${message}`, context);
      if (!this.logger) console.debug(`[PlannerMemoryStore] ${message}`, context);
      return;
    }
    this.logger?.debug(`[PlannerMemoryStore] ${message}`);
    if (!this.logger) console.debug(`[PlannerMemoryStore] ${message}`);
  }

  async load(): Promise<void> {
    this.debug('loading planner memory from disk', {
      memoryDir: this.memoryDir,
      maxEpisodes: this.maxEpisodes,
      maxLessons: this.maxLessons,
    });
    const [episodes, lessons, index] = await Promise.all([
      this.readJsonFile<PlannerMemoryEpisode[]>(this.episodesFilePath, []),
      this.readJsonFile<PlannerMemoryLesson[]>(this.lessonsFilePath, []),
      this.readJsonFile<PlannerMemoryIndex | null>(this.indexFilePath, null),
    ]);

    this.episodes = episodes.slice(-this.maxEpisodes);
    this.lessons = lessons.slice(-this.maxLessons);
    this.index = index ?? this.rebuildIndex();
    this.dirty = false;
    this.debug('planner memory loaded', {
      episodeCount: this.episodes.length,
      lessonCount: this.lessons.length,
      rebuiltIndex: !index,
      deploymentCount: Object.keys(this.index.byDeployment).length,
    });
  }

  upsertEpisode(episode: PlannerMemoryEpisode): void {
    const existingIndex = this.episodes.findIndex((item) => item.episodeId === episode.episodeId);
    if (existingIndex >= 0) {
      this.episodes[existingIndex] = episode;
    } else {
      this.episodes.push(episode);
    }
    if (this.episodes.length > this.maxEpisodes) {
      this.episodes.splice(0, this.episodes.length - this.maxEpisodes);
    }
    this.synthesizeLessonsForDeployment(episode.deploymentName);
    this.index = this.rebuildIndex();
    this.dirty = true;
    this.debug('episode upserted', {
      episodeId: episode.episodeId,
      taskId: episode.taskId,
      deploymentName: episode.deploymentName,
      outcomeClass: episode.outcomeClass,
      operation: existingIndex >= 0 ? 'update' : 'insert',
      episodeCount: this.episodes.length,
      activeLessonCount: this.getActiveLessons(episode.deploymentName, this.maxLessons).length,
    });
  }

  upsertLesson(lesson: PlannerMemoryLesson): void {
    const existingIndex = this.lessons.findIndex((item) => item.lessonId === lesson.lessonId);
    if (existingIndex >= 0) {
      this.lessons[existingIndex] = lesson;
    } else {
      this.lessons.push(lesson);
    }
    if (this.lessons.length > this.maxLessons) {
      this.lessons.splice(0, this.lessons.length - this.maxLessons);
    }
    this.index = this.rebuildIndex();
    this.dirty = true;
    this.debug('lesson upserted', {
      lessonId: lesson.lessonId,
      deploymentName: lesson.deploymentScope.deploymentName,
      taskType: lesson.deploymentScope.taskType,
      status: lesson.status,
      confidence: lesson.confidence,
      operation: existingIndex >= 0 ? 'update' : 'insert',
      lessonCount: this.lessons.length,
    });
  }

  getRecentEpisodes(deploymentName: string, limit: number = 5): PlannerMemoryEpisode[] {
    return sortByCreatedAtDescending(
      this.episodes.filter((episode) => episode.deploymentName === deploymentName),
    ).slice(0, limit);
  }

  getActiveLessons(deploymentName?: string, limit: number = 3): PlannerMemoryLesson[] {
    const now = Date.now();
    return this.lessons
      .filter((lesson) => lesson.status === 'active' && lesson.expiresAt.getTime() > now)
      .filter((lesson) => !deploymentName || lesson.deploymentScope.deploymentName === deploymentName)
      .sort((left, right) => right.lastValidatedAt.getTime() - left.lastValidatedAt.getTime())
      .slice(0, limit);
  }

  getIndex(): PlannerMemoryIndex {
    return structuredClone(this.index);
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      this.debug('flush skipped because planner memory is unchanged');
      return;
    }

    this.debug('flushing planner memory to disk', {
      episodesFilePath: this.episodesFilePath,
      lessonsFilePath: this.lessonsFilePath,
      indexFilePath: this.indexFilePath,
      episodeCount: this.episodes.length,
      lessonCount: this.lessons.length,
    });
    await fs.mkdir(this.memoryDir, { recursive: true });
    await Promise.all([
      this.writeJsonFile(this.episodesFilePath, this.episodes),
      this.writeJsonFile(this.lessonsFilePath, this.lessons),
      this.writeJsonFile(this.indexFilePath, this.index),
    ]);
    this.dirty = false;
    this.debug('planner memory flush completed', {
      episodeCount: this.episodes.length,
      lessonCount: this.lessons.length,
      deploymentCount: Object.keys(this.index.byDeployment).length,
    });
  }

  get episodeCount(): number {
    return this.episodes.length;
  }

  get lessonCount(): number {
    return this.lessons.length;
  }

  private synthesizeLessonsForDeployment(deploymentName: string): void {
    const deploymentEpisodes = sortByCreatedAtDescending(
      this.episodes.filter((episode) => episode.deploymentName === deploymentName),
    );
    const preservedLessons = this.lessons.filter(
      (lesson) => !(isAutoLesson(lesson) && lesson.deploymentScope.deploymentName === deploymentName),
    );

    const synthesizedLessons: PlannerMemoryLesson[] = [];
    const groupedEpisodes = new Map<string, PlannerMemoryEpisode[]>();

    for (const episode of deploymentEpisodes) {
      if (episode.outcomeClass === 'inconclusive') {
        continue;
      }
      const key = `${episode.taskType}:${episode.outcomeClass}`;
      const bucket = groupedEpisodes.get(key) ?? [];
      bucket.push(episode);
      groupedEpisodes.set(key, bucket);
    }

    for (const [key, episodes] of groupedEpisodes) {
      if (episodes.length < 2) {
        continue;
      }

      const [taskType, outcomeClass] = key.split(':') as [string, PlannerMemoryOutcomeClass];
      const contradictions = deploymentEpisodes.filter(
        (episode) =>
          episode.taskType === taskType &&
          episode.outcomeClass !== outcomeClass &&
          episode.outcomeClass !== 'inconclusive',
      );
      const supportingTaskIds = unique(episodes.map((episode) => episode.taskId));
      const contradictedBy = unique(contradictions.map((episode) => episode.taskId));
      const status = determineLessonStatus(episodes, contradictions);
      const lastValidatedAt = episodes[0]!.taskCreatedAt;

      synthesizedLessons.push({
        version: 1,
        lessonId: `${AUTO_LESSON_PREFIX}${deploymentName}:${taskType}:${outcomeClass}`,
        deploymentScope: {
          deploymentName,
          taskType,
          metricNames: unique(episodes.flatMap((episode) => episode.anomalySummary.metrics)),
        },
        pattern: lessonPatternForOutcome(outcomeClass, taskType),
        advice: lessonAdviceForOutcome(outcomeClass, deploymentName, taskType),
        confidence: confidenceFromSupportCount(supportingTaskIds.length),
        supportingTaskIds,
        supportingEpisodeIds: unique(episodes.map((episode) => episode.episodeId)),
        contradictedBy,
        lastValidatedAt,
        expiresAt: new Date(lastValidatedAt.getTime() + LESSON_TTL_MS),
        status,
      });
    }

    this.lessons = [...preservedLessons, ...synthesizedLessons].slice(-this.maxLessons);
    this.debug('synthesized deployment lessons', {
      deploymentName,
      deploymentEpisodeCount: deploymentEpisodes.length,
      synthesizedLessonCount: synthesizedLessons.length,
      activeLessonIds: synthesizedLessons
        .filter((lesson) => lesson.status === 'active')
        .map((lesson) => lesson.lessonId),
    });
  }

  private rebuildIndex(): PlannerMemoryIndex {
    const byDeployment: Record<string, PlannerMemoryIndexDeploymentEntry> = {};

    for (const episode of sortByCreatedAtDescending(this.episodes)) {
      if (!byDeployment[episode.deploymentName]) {
        byDeployment[episode.deploymentName] = {
          deploymentName: episode.deploymentName,
          recentEpisodeIds: [],
          activeLessonIds: [],
          updatedAt: new Date(),
        };
      }
      const entry = byDeployment[episode.deploymentName];
      if (entry.recentEpisodeIds.length < 5) {
        entry.recentEpisodeIds.push(episode.episodeId);
      }
    }

    for (const lesson of this.getActiveLessons(undefined, this.maxLessons)) {
      const deploymentName = lesson.deploymentScope.deploymentName;
      if (deploymentName) {
        if (!byDeployment[deploymentName]) {
          byDeployment[deploymentName] = {
            deploymentName,
            recentEpisodeIds: [],
            activeLessonIds: [],
            updatedAt: new Date(),
          };
        }
        const entry = byDeployment[deploymentName];
        if (entry.activeLessonIds.length < 3) {
          entry.activeLessonIds.push(lesson.lessonId);
        }
      }
    }

    return {
      version: 1,
      byDeployment,
      recentEpisodeIds: sortByCreatedAtDescending(this.episodes).slice(0, 20).map((episode) => episode.episodeId),
      activeLessonIds: this.getActiveLessons(undefined, this.maxLessons).map((lesson) => lesson.lessonId),
      globalLessonIds: this.getActiveLessons(undefined, this.maxLessons)
        .filter((lesson) => !lesson.deploymentScope.deploymentName)
        .slice(0, 5)
        .map((lesson) => lesson.lessonId),
      updatedAt: new Date(),
    };
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return this.reviveDates(JSON.parse(raw)) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  private reviveDates(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.reviveDates(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const revived: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === 'string' && /(At)$/.test(key)) {
        revived[key] = new Date(nestedValue);
        continue;
      }
      revived[key] = this.reviveDates(nestedValue);
    }
    return revived;
  }
}
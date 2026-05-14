/**
 * PimClaw OpenClaw Plugin — v2 Minimal Hybrid Architecture
 *
 * Integrates with OpenClaw via:
 *   - definePluginEntry()   — plugin registration
 *   - api.registerService() — lifecycle-managed background service that
 *     boots the PimClaw Components (TaskStatusRecorder, Scheduler, AnomalyReceiver)
 *   - api.registerTool()    — exposes PimClaw tools to OpenClaw agents
 *
 * The LLM Head and Planner agents run externally via OpenClaw's agent runtime,
 * not inside this plugin. They interact through two integration gates:
 *   - pimclaw_submit_anomalies (Head → Plugin)
 *   - pimclaw_plan_task (Planner → Plugin)
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { execFile } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'node:util';
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import { ComponentRegistry } from './master/component-registry.js';
import { TaskStatusRecorder } from './master/task-status-recorder.js';
import { SchedulerAgent } from './master/scheduler-agent.js';
import { AnomalyReceiver } from './master/anomaly-receiver.js';
import type { AnomalyEvent } from './master/anomaly-receiver.js';
import { PlannerTrigger } from './master/planner-trigger.js';
import type { OpenClawAgentApi, PlannerDeliveryConfig } from './master/planner-trigger.js';
import { FileLogger } from './master/file-logger.js';
import {
  PrometheusClient,
  injectLabels,
  getPromQLMap,
  parseEngineConfig,
  allMetricNames,
  ALL_ENGINES,
} from './master/prometheus-client.js';
import type { InferenceEngine, PrometheusQueryMap } from './master/prometheus-client.js';
import { MetricsStore, extractMetricValue, DeploymentMetrics } from './master/metrics-store.js';
import {
  HeadSummaryStore,
  type HeadMonitoringAnomalyRow,
  type HeadMonitoringDeploymentSummary,
  type HeadMonitoringSummaryRecord,
  type SummaryMetricName,
} from './master/head-summary-store.js';
import { EngineMcpClient } from './master/engine-mcp-client.js';
import type { EngineMcpConfig } from './master/engine-mcp-client.js';
import { PerfMcpClient } from './master/perf-mcp-client.js';
import type { PerfMcpConfig } from './master/perf-mcp-client.js';
import { SimMcpClient } from './master/sim-mcp-client.js';
import type { SimMcpConfig } from './master/sim-mcp-client.js';
import { TaskExecutor, type TaskRunner } from './master/task-executor.js';
import { FakePrometheusTaskExecutor } from './master/fake-prometheus-task-executor.js';
import { buildPlannerMemoryEpisodeFromTask, PlannerMemoryStore } from './master/planner-memory-store.js';
import {
  DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS,
  DEFAULT_HEAD_FEEDBACK_VALIDITY_MS,
  buildHeadTaskFeedbackRow,
  deriveHeadFollowupOutcome,
  getHeadTaskFeedbackReviewState,
} from './master/head-task-feedback.js';
import type {
  Task,
  TaskFeedback,
  TaskFeedbackMetricAssessment,
  TaskFeedbackStatusSummary,
} from './types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { selectPlannerAgentApi } from './master/planner-launch.js';

// ─── Tool hook governance ──────────────────────────────────────────────────

/**
 * Hook interface for tool execution governance.
 * All hooks are non-fatal — errors are caught and logged, never kill tool execution.
 */
export interface ToolHook {
  preToolUse?(toolName: string, params: Record<string, unknown>): Promise<{
    updatedInput?: Record<string, unknown>;
    blockingError?: string;
  } | void>;
  postToolUse?(toolName: string, result: unknown, durationMs: number): Promise<void>;
  postToolUseFailure?(toolName: string, error: unknown, durationMs: number): Promise<void>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (sessionId: string, params: Record<string, unknown>) => Promise<{ output: string }>;
}

type OpenClawToolContext = Record<string, unknown>;

let pimclawService: OpenClawPluginService | null = null;
let pimclawServiceStartPromise: Promise<void> | null = null;

function getPimClawService(): OpenClawPluginService {
  pimclawService ??= createPimClawService();
  return pimclawService;
}

function defaultOpenClawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? '/home/node', '.openclaw');
}

function buildLazyServiceContext(
  api: OpenClawPluginApi,
  toolContext?: OpenClawToolContext,
): OpenClawPluginServiceContext {
  const stateDir =
    typeof toolContext?.stateDir === 'string' ? toolContext.stateDir : defaultOpenClawStateDir();
  const workspaceDir =
    typeof toolContext?.workspaceDir === 'string'
      ? toolContext.workspaceDir
      : path.join(stateDir, 'workspaces', 'pimclaw-main');

  return {
    ...(toolContext ?? {}),
    logger: api.logger,
    stateDir,
    workspaceDir,
    config: pluginConfig,
    runtime: api.runtime ?? pluginRuntime,
    openclawApi: (toolContext as any)?.openclawApi ?? (api as any).openclawApi,
  } as OpenClawPluginServiceContext;
}

async function ensurePimClawServiceStarted(
  api: OpenClawPluginApi,
  toolContext?: OpenClawToolContext,
): Promise<void> {
  if (registry && taskRecorder) return;

  if (!pimclawServiceStartPromise) {
    const ctx = buildLazyServiceContext(api, toolContext);
    pimclawServiceStartPromise = Promise.resolve(getPimClawService().start(ctx))
      .catch((error: unknown) => {
        pimclawServiceStartPromise = null;
        throw error;
      });
  }

  await pimclawServiceStartPromise;
}

/**
 * Wrap a tool definition with hook governance.
 * Hooks run before/after tool execution but never block the pipeline on failure.
 */
function withHooks(tool: ToolDefinition, hooks: ToolHook[]): ToolDefinition {
  if (hooks.length === 0) return tool;

  const originalExecute = tool.execute;
  tool.execute = async (sessionId: string, params: Record<string, unknown>) => {
    // Pre hooks
    let effectiveParams = params;
    for (const hook of hooks) {
      try {
        const pre = await hook.preToolUse?.(tool.name, effectiveParams);
        if (pre?.blockingError) {
          return { output: JSON.stringify({ error: pre.blockingError }) };
        }
        if (pre?.updatedInput) {
          effectiveParams = pre.updatedInput;
        }
      } catch {
        // Non-fatal: skip this hook
      }
    }

    const start = Date.now();
    try {
      const result = await originalExecute(sessionId, effectiveParams);
      const duration = Date.now() - start;

      // Post hooks (non-fatal)
      for (const hook of hooks) {
        try { await hook.postToolUse?.(tool.name, result, duration); } catch { /* non-fatal */ }
      }

      return result;
    } catch (err) {
      const duration = Date.now() - start;

      // Failure hooks (non-fatal)
      for (const hook of hooks) {
        try { await hook.postToolUseFailure?.(tool.name, err, duration); } catch { /* non-fatal */ }
      }

      throw err;
    }
  };
  return tool;
}

function withLazyServiceStart(
  tool: ToolDefinition,
  api: OpenClawPluginApi,
  toolContext?: OpenClawToolContext,
): ToolDefinition {
  const originalExecute = tool.execute;
  tool.execute = async (sessionId: string, params: Record<string, unknown>) => {
    await ensurePimClawServiceStarted(api, toolContext);
    return originalExecute(sessionId, params);
  };
  return tool;
}

// ─── Shared state across the plugin (lives for the OpenClaw process) ───────

let registry: ComponentRegistry | null = null;
let taskRecorder: TaskStatusRecorder | null = null;
let scheduler: SchedulerAgent | null = null;
let anomalyReceiver: AnomalyReceiver | null = null;
let prometheusClient: PrometheusClient | null = null;
let engineMcpClient: EngineMcpClient | null = null;
let perfMcpClient: PerfMcpClient | null = null;
let simMcpClient: SimMcpClient | null = null;
let simMcpConfig: SimMcpConfig | null = null;
let simMcpUnavailableReason = 'sim MCP not configured';
let taskExecutor: TaskRunner | null = null;
let plannerMemoryStore: PlannerMemoryStore | null = null;
let prometheusQueryOverrides: Record<string, string> = {};
let prometheusDefaultLabels: Record<string, string> = {};
let activeEngines: InferenceEngine[] = [...ALL_ENGINES];
let metricsStore: MetricsStore | null = null;
let headSummaryStore: HeadSummaryStore | null = null;
let pluginConfig: Record<string, unknown> = {};
let pluginRuntime: unknown = null;
let plannerFallbackTaskType: 'scale-up' | 'scale-down' | 'restart' | 'reconfigure' = 'scale-up';
let plannerFallbackConfig: Record<string, unknown> = { replicaDelta: 1 };
let planningTimeoutMs = 600_000;
let headFeedbackSettlingDelayMs = DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS;
let headFeedbackValidityMs = DEFAULT_HEAD_FEEDBACK_VALIDITY_MS;
let pluginLogger: OpenClawPluginServiceContext['logger'] | null = null;
let fileLogger: FileLogger | null = null;
const planningFallbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const currentHeadRunIds: Map<string, string> = new Map();
const toolHooks: ToolHook[] = [];
const execFileAsync = promisify(execFile);
const summaryMetrics: SummaryMetricName[] = [
  'ttft',
  'tpot',
  'qps',
  'throughput',
  'gpu_utilization',
  'error_rate',
];

interface RuntimeAnomalyHint {
  type: 'spike' | 'drop' | 'trend' | 'anomaly';
  metricName: string;
  currentValue: number;
  previousValue?: number;
  severity: 'high' | 'medium' | 'low';
  deploymentName: string;
  hardwareName?: string;
  gpuType?: string;
  engine: InferenceEngine;
  reason: string;
  actionRequired: 'submit_anomaly';
  source: 'pimclaw_query_metrics_guardrail';
}

interface GpuHardwareInfo {
  deploymentName: string;
  gpuType: string;
  hardware_name: string;
  sourceMetric: string;
  labels: Record<string, string>;
}

function normalizeMetricNumber(value: number | null): number | null {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function extractSummaryMetricValue(result: unknown): number | null {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  const first = result[0] as any;
  if (first?.value) {
    return normalizeMetricNumber(parseFloat(first.value[1]));
  }

  if (!Array.isArray(first?.values) || first.values.length === 0) {
    return null;
  }

  const numericValues = first.values
    .map((entry: [number, string]) => parseFloat(entry[1]))
    .filter((value: number) => Number.isFinite(value));

  if (numericValues.length === 0) {
    return null;
  }

  const total = numericValues.reduce((sum: number, value: number) => sum + value, 0);
  return total / numericValues.length;
}

function numericSeriesValues(series: unknown): number[] {
  const values = (series as any)?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((point: unknown) => {
      const raw = Array.isArray(point) ? point[1] : null;
      const num = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
      return Number.isFinite(num) ? num : null;
    })
    .filter((num: number | null): num is number => num != null);
}

function averageSeriesValues(series: unknown): number | null {
  const nums = numericSeriesValues(series);
  if (nums.length === 0) return null;
  return nums.reduce((sum, num) => sum + num, 0) / nums.length;
}

function buildRuntimeAnomalyHints(
  engine: InferenceEngine,
  metric: string,
  result: unknown,
): RuntimeAnomalyHint[] {
  if (!Array.isArray(result)) return [];
  const hints: RuntimeAnomalyHint[] = [];

  for (const series of result) {
    const deploymentName = (series as any)?.metric?.model_name;
    if (!deploymentName) continue;
    const hardwareName = typeof (series as any)?.hardware_name === 'string'
      ? (series as any).hardware_name
      : undefined;
    const gpuType = typeof (series as any)?.pimclawGpuType === 'string'
      ? (series as any).pimclawGpuType
      : undefined;
    const currentAverage = averageSeriesValues(series);
    const values = numericSeriesValues(series);
    const maxValue = values.length > 0 ? Math.max(...values) : null;
    if (currentAverage == null || maxValue == null) continue;

    if (metric === 'ttft') {
      if (currentAverage > 30 || maxValue > 30) {
        hints.push({
          type: 'anomaly',
          metricName: 'ttft',
          currentValue: currentAverage,
          severity: 'high',
          deploymentName,
          hardwareName,
          gpuType,
          engine,
          actionRequired: 'submit_anomaly',
          source: 'pimclaw_query_metrics_guardrail',
          reason:
            `TTFT current 5-minute average is ${currentAverage.toFixed(2)}s and max observed TTFT is ${maxValue.toFixed(2)}s. The high-severity threshold is avg >30s or any observed point >30s. Submit an anomaly even if the value later recovers or matches prior observations.`,
        });
      } else if (currentAverage >= 10) {
        hints.push({
          type: 'anomaly',
          metricName: 'ttft',
          currentValue: currentAverage,
          severity: 'medium',
          deploymentName,
          hardwareName,
          gpuType,
          engine,
          actionRequired: 'submit_anomaly',
          source: 'pimclaw_query_metrics_guardrail',
          reason:
            `TTFT current 5-minute average is ${currentAverage.toFixed(2)}s, above the absolute medium-severity threshold of 10s. Submit an anomaly even if the value is stable or matches prior observations.`,
        });
      }
    }
  }

  return hints;
}

function normalizeHardwareName(gpuType: string): string {
  const trimmed = gpuType.trim();
  const hardwareMappings: Array<[RegExp, string]> = [
    [/^NVIDIA\s+H800$/i, 'NVIDIA H800_SXM'],
    [/^H800$/i, 'NVIDIA H800_SXM'],
  ];
  for (const [pattern, mapped] of hardwareMappings) {
    if (pattern.test(trimmed)) {
      return mapped;
    }
  }
  const withoutVendor = trimmed.replace(/^NVIDIA\s+/i, '').trim();
  return withoutVendor || trimmed;
}

function extractGpuTypeFromLabels(labels: Record<string, string>): string | null {
  return labels.modelName
    ?? labels.gpu_type
    ?? labels.gpuType
    ?? labels.gpu_name
    ?? labels.gpuName
    ?? labels.device_name
    ?? labels.deviceName
    ?? labels.hardware_name
    ?? labels.hardwareName
    ?? null;
}

function buildGpuHardwareMap(results: unknown[], sourceMetric: string): Record<string, GpuHardwareInfo> {
  const byDeployment: Record<string, GpuHardwareInfo> = {};
  for (const result of results) {
    const labels = (result as any)?.metric;
    if (!labels || typeof labels !== 'object') {
      continue;
    }
    const deploymentName = typeof labels.model_name === 'string'
      ? labels.model_name
      : typeof labels.model === 'string'
        ? labels.model
        : undefined;
    const gpuType = extractGpuTypeFromLabels(labels as Record<string, string>);
    if (!deploymentName || !gpuType) {
      continue;
    }
    byDeployment[deploymentName] = {
      deploymentName,
      gpuType,
      hardware_name: normalizeHardwareName(gpuType),
      sourceMetric,
      labels: labels as Record<string, string>,
    };
  }
  return byDeployment;
}

function mergeGpuHardwareMaps(
  target: Record<string, GpuHardwareInfo>,
  source: Record<string, GpuHardwareInfo>,
): void {
  for (const [deploymentName, info] of Object.entries(source)) {
    if (!target[deploymentName]) {
      target[deploymentName] = info;
    }
  }
}

function annotateGpuHardware(result: unknown, gpuByDeployment: Record<string, GpuHardwareInfo>): unknown {
  if (!Array.isArray(result)) return result;
  return result.map((series) => {
    if (!series || typeof series !== 'object' || Array.isArray(series)) return series;
    const deploymentName = (series as any)?.metric?.model_name;
    const gpuInfo = typeof deploymentName === 'string' ? gpuByDeployment[deploymentName] : undefined;
    if (!gpuInfo) return series;
    return {
      ...series,
      pimclawGpuType: gpuInfo.gpuType,
      hardware_name: gpuInfo.hardware_name,
    };
  });
}

function collectDeploymentNames(
  engineResults: Record<string, unknown>,
  metrics: readonly string[],
): string[] {
  const deploymentNames = new Set<string>();
  for (const metric of metrics) {
    const results = engineResults[metric] as any[];
    if (!Array.isArray(results)) {
      continue;
    }
    for (const result of results) {
      if (typeof result?.metric?.model_name === 'string') {
        deploymentNames.add(result.metric.model_name);
      }
    }
  }
  return Array.from(deploymentNames).sort();
}

function getDeploymentMetricResult(
  engineResults: Record<string, unknown>,
  metric: string,
  deploymentName: string,
): unknown {
  const results = engineResults[metric] as any[];
  if (!Array.isArray(results)) {
    return null;
  }
  const match = results.find((result) => result?.metric?.model_name === deploymentName);
  return match ? [match] : null;
}

function createDeploymentSummary(
  deploymentName: string,
  engine: string,
  engineResults: Record<string, unknown>,
  store: HeadSummaryStore,
  runId: string,
): HeadMonitoringDeploymentSummary {
  return {
    deploymentName,
    engine,
    metricTable: summaryMetrics.map((metric) => ({
      metric,
      currentValue: extractSummaryMetricValue(getDeploymentMetricResult(engineResults, metric, deploymentName)),
      priorValue: store.findPreviousMetricValue(deploymentName, engine, metric, runId),
    })),
    anomalyTable: [],
  };
}

function buildHeadSummaryRecord(
  sessionId: string,
  grouped: Record<string, Record<string, unknown>>,
  engines: InferenceEngine[],
  runId: string,
  store: HeadSummaryStore,
): HeadMonitoringSummaryRecord {
  const deployments: HeadMonitoringDeploymentSummary[] = [];

  for (const engine of engines) {
    const engineResults = grouped[engine];
    if (!engineResults) {
      continue;
    }

    const deploymentNames = collectDeploymentNames(engineResults, summaryMetrics);
    for (const deploymentName of deploymentNames) {
      deployments.push(createDeploymentSummary(deploymentName, engine, engineResults, store, runId));
    }
  }

  return {
    ts: Date.now(),
    runId,
    sessionId,
    deployments,
    taskFeedbackTable: [],
  };
}

function mergeAnomaliesIntoSummary(
  summary: HeadMonitoringSummaryRecord,
  events: Array<AnomalyEvent & { eventId: string }>,
): HeadMonitoringSummaryRecord {
  for (const event of events) {
    let deploymentSummary = summary.deployments.find(
      (deployment) => deployment.deploymentName === event.deploymentName,
    );

    if (!deploymentSummary) {
      deploymentSummary = {
        deploymentName: event.deploymentName,
        engine: 'unknown',
        metricTable: [],
        anomalyTable: [],
      };
      summary.deployments.push(deploymentSummary);
    }

    const anomalyRow: HeadMonitoringAnomalyRow = {
      anomalyIdOrName: event.eventId,
      metric: event.metricName,
      severity: event.severity,
      observation: event.reasoning?.trim() || `${event.type} detected`,
    };

    const existingIndex = deploymentSummary.anomalyTable.findIndex(
      (row) => row.anomalyIdOrName === anomalyRow.anomalyIdOrName,
    );
    if (existingIndex >= 0) {
      deploymentSummary.anomalyTable[existingIndex] = anomalyRow;
    } else {
      deploymentSummary.anomalyTable.push(anomalyRow);
    }
  }

  return summary;
}

function getPluginConfig(ctx?: OpenClawPluginServiceContext): Record<string, unknown> {
  const serviceConfig = ctx?.config && typeof ctx.config === 'object'
    ? ctx.config as Record<string, unknown>
    : {};
  return {
    ...pluginConfig,
    ...serviceConfig,
  };
}

/**
 * Extract all top-level JSON object strings from text using brace-depth tracking.
 * Handles the case where an LLM returns multiple {...} blocks separated by prose.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

interface PlannerSubmission {
  taskId: string;
  taskType: string;
  config: Record<string, unknown>;
  reasoning: string;
  perfEvidence?: string;
  simulationResults?: string;
}

function buildUnavailableEvidence(prefix: 'Perf MCP' | 'Simulator MCP'): string {
  return `UNAVAILABLE: ${prefix} not configured or unavailable.`;
}

function appendFallbackReasoning(reasoning: string, missingEvidence: string[]): string {
  const trimmedReasoning = reasoning.trim();
  if (missingEvidence.length === 0) {
    return trimmedReasoning;
  }

  const fallbackNote = `Fallback plan applied without full evidence because ${missingEvidence.join(' and ')}.`;
  if (trimmedReasoning.includes(fallbackNote)) {
    return trimmedReasoning;
  }

  return trimmedReasoning.length > 0
    ? `${trimmedReasoning} ${fallbackNote}`
    : fallbackNote;
}

function normalizePlannerSubmissionEvidence(submission: PlannerSubmission): PlannerSubmission {
  const missingEvidence: string[] = [];
  let perfEvidence = submission.perfEvidence;
  let simulationResults = submission.simulationResults;

  if (!perfMcpClient) {
    perfEvidence = buildUnavailableEvidence('Perf MCP');
    missingEvidence.push('Perf MCP is unavailable');
  }

  if (!simMcpClient) {
    simulationResults = buildUnavailableEvidence('Simulator MCP');
    missingEvidence.push('Simulator MCP is unavailable');
  }

  const normalized = {
    ...submission,
    perfEvidence,
    simulationResults,
    reasoning: appendFallbackReasoning(submission.reasoning, missingEvidence),
  };

  if (
    normalized.perfEvidence !== submission.perfEvidence
    || normalized.simulationResults !== submission.simulationResults
    || normalized.reasoning !== submission.reasoning
  ) {
    pluginLogger?.debug('[PlanTask] planner submission evidence normalized', {
      taskId: submission.taskId,
      perfEvidenceChanged: normalized.perfEvidence !== submission.perfEvidence,
      simulationResultsChanged: normalized.simulationResults !== submission.simulationResults,
      reasoningChanged: normalized.reasoning !== submission.reasoning,
      perfMcpAvailable: Boolean(perfMcpClient),
      simMcpAvailable: Boolean(simMcpClient),
    });
  }

  return normalized;
}

async function connectSimMcpClient(logger: OpenClawPluginServiceContext['logger'] | null): Promise<boolean> {
  if (!simMcpConfig?.sseUrl) {
    simMcpUnavailableReason = 'sim MCP not configured';
    return false;
  }

  try {
    const client = new SimMcpClient({
      sseUrl: simMcpConfig.sseUrl,
    });
    await client.connect();
    simMcpClient = client;
    simMcpUnavailableReason = '';
    logger?.info(`[PimClaw] Sim MCP connected → ${simMcpConfig.sseUrl}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    simMcpClient = null;
    simMcpUnavailableReason = msg;
    logger?.warn(`[PimClaw] Sim MCP unavailable: ${msg}`);
    return false;
  }
}

const PLANNER_OUTPUT_FORMAT_DEBUG_FILE_NAME = 'planner-output-format-debug.jsonl';
const PLANNER_OUTPUT_FORMAT_DEBUG_MAX_LINES = 1000;

let plannerOutputFormatDebugFilePath: string | null = null;
let plannerOutputFormatDebugWriteChain: Promise<void> = Promise.resolve();

function extractExpectedTaskId(taskInstruction: string): string | undefined {
  try {
    const bare = taskInstruction.match(/"taskId"\s*:\s*"([^"]+)"/);
    return bare?.[1];
  } catch {
    return undefined;
  }
}

async function persistPlannerOutputFormatDebugEntry(submission: { taskId?: unknown }): Promise<void> {
  if (!plannerOutputFormatDebugFilePath) {
    pluginLogger?.debug('[PlanTask] skipped planner output debug write because no file path is configured', {
      taskId: submission.taskId ?? null,
    });
    return;
  }

  const taskId = typeof submission.taskId === 'string' ? submission.taskId : null;
  plannerOutputFormatDebugWriteChain = plannerOutputFormatDebugWriteChain
    .catch(() => {})
    .then(async () => {
      const serialized = JSON.stringify(submission);
      let existingLines: string[] = [];

      try {
        const existingContent = await fs.readFile(plannerOutputFormatDebugFilePath as string, 'utf-8');
        existingLines = existingContent
          .split('\n')
          .filter((line) => line.trim().length > 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw error;
        }
      }

      const nextLines = [...existingLines, serialized].slice(-PLANNER_OUTPUT_FORMAT_DEBUG_MAX_LINES);
      await fs.mkdir(path.dirname(plannerOutputFormatDebugFilePath as string), { recursive: true });
      await fs.writeFile(
        plannerOutputFormatDebugFilePath as string,
        `${nextLines.join('\n')}\n`,
        'utf-8',
      );

      pluginLogger?.debug('[PlanTask] planner output debug payload persisted', {
        taskId,
        filePath: plannerOutputFormatDebugFilePath,
        entryCount: nextLines.length,
      });
    });

  return plannerOutputFormatDebugWriteChain;
}

async function applyPlannerSubmission(submission: PlannerSubmission): Promise<{ success: true; taskId: string; message: string } | { error: string }> {
  pluginLogger?.debug(`[PlanTask] applyPlannerSubmission called`, { taskId: submission.taskId, taskType: submission.taskType });

  if (!taskRecorder) {
    pluginLogger?.debug(`[PlanTask] service not running, rejecting submission`);
    return { error: 'PimClaw service not running' };
  }

  const task = taskRecorder.getTask(submission.taskId);
  if (!task) {
    pluginLogger?.debug(`[PlanTask] task not found`, { taskId: submission.taskId });
    return { error: `Task ${submission.taskId} not found` };
  }

  if (task.status !== 'planning') {
    pluginLogger?.debug(`[PlanTask] invalid task status`, { taskId: submission.taskId, currentStatus: task.status });
    return { error: `Task ${submission.taskId} is in '${task.status}' state, expected 'planning'` };
  }

  pluginLogger?.debug(`[PlanTask] taskType decided by planner`, {
    taskId: submission.taskId,
    taskType: submission.taskType,
    source: 'planner-agent',
    perfEvidenceChars: submission.perfEvidence?.length ?? 0,
    simulationResultsChars: submission.simulationResults?.length ?? 0,
    perfEvidenceSnippet: submission.perfEvidence?.slice(0, 200) ?? null,
    simulationResultsSnippet: submission.simulationResults?.slice(0, 200) ?? null,
    reasoningSnippet: submission.reasoning,
  });
  task.taskType = submission.taskType;
  task.config = submission.config;
  task.reasoning = submission.reasoning;
  task.perfEvidence = submission.perfEvidence;
  task.simulationResults = submission.simulationResults;

  clearPlanningFallback(submission.taskId);
  pluginLogger?.debug(`[PlanTask] fallback timer cleared`, { taskId: submission.taskId });
  await taskRecorder.updateTaskStatus(submission.taskId, 'ready');

  pluginLogger?.debug(`[PlanTask] task transitioned planning → ready`, { taskId: submission.taskId });
  return {
    success: true,
    taskId: submission.taskId,
    message: `Task ${submission.taskId} planned and ready for scheduling`,
  };
}

function createCliPlannerAgentApi(ctx: OpenClawPluginServiceContext): OpenClawAgentApi {
  return {
    async triggerAgent(agentId, options) {
      const expectedTaskId = extractExpectedTaskId(options.task);
      const plannerInstruction = [
        options.task,
        'Return only valid JSON with this exact schema:',
        JSON.stringify({
          taskId: 'string',
          taskType: 'scale-up | scale-down | restart | reconfigure',
          config: {
            replicas: 'number',
            dtype: 'string',
            quantization: 'string|null',
            maxBatchSize: 'number',
            tensorParallelism: 'number',
          },
          reasoning: 'string',
          perfEvidence: 'string',
          simulationResults: 'string',
        }),
        'Do not wrap the JSON in markdown fences.',
      ].join('\n\n');

      const { stdout, stderr } = await execFileAsync(
        'openclaw',
        [
          'agent',
          '--agent', agentId,
          // The CLI shim has to force per-run isolation itself because it is
          // emulating the one-shot planner semantics the injected API provides.
          '--session-id', uuidv4(),
          '--message', plannerInstruction,
          '--timeout', String(options.runTimeoutSeconds),
          ...(options.delivery?.enabled
            ? [
                '--deliver',
                '--reply-channel', options.delivery.channel,
                ...(options.delivery.target ? ['--reply-to', options.delivery.target] : []),
              ]
            : []),
          '--json',
        ],
        {
          cwd: options.workspaceDir ?? ctx.workspaceDir,
          timeout: options.runTimeoutSeconds * 1000,
        },
      );

      if (stderr.trim()) {
        ctx.logger.warn(`[PimClaw] Planner CLI stderr: ${stderr.trim()}`);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        ctx.logger.info(`[PimClaw] Planner CLI raw output: ${stdout.trim()}`);
        return;
      }

      if (parsed?.status && parsed.status !== 'ok') {
        throw new Error(`planner CLI run failed: ${parsed.status}`);
      }

      if (expectedTaskId) {
        const taskStatus = taskRecorder?.getTask(expectedTaskId)?.status;
        if (taskStatus && taskStatus !== 'planning') {
          pluginLogger?.debug(`[PlanTask] planner CLI run already applied via tool`, {
            taskId: expectedTaskId,
            currentStatus: taskStatus,
          });
          return;
        }
      }

      const plannerText = parsed?.result?.payloads?.map((payload: any) => payload?.text ?? '').join('\n').trim();
      if (!plannerText) {
        throw new Error('planner CLI returned no text payload');
      }

      let submission: PlannerSubmission;
      try {
        submission = JSON.parse(plannerText);
      } catch {
        // LLM may have added preamble prose, markdown fences, or returned multiple
        // JSON objects (one per anomaly). Use a brace-depth extractor to find all
        // top-level {...} blocks, then pick the one whose taskId matches.
        const candidates = extractJsonObjects(plannerText);
        if (candidates.length === 0) {
          throw new Error(
            `planner CLI returned no JSON object | raw: ${plannerText.slice(0, 300)}`,
          );
        }
        let matched: PlannerSubmission | undefined;
        const parseErrors: string[] = [];
        for (const candidate of candidates) {
          try {
            const parsed = JSON.parse(candidate) as PlannerSubmission;
            if (!matched) matched = parsed; // first valid candidate as fallback
            if (expectedTaskId && parsed.taskId === expectedTaskId) {
              matched = parsed;
              break;
            }
          } catch (e) {
            parseErrors.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (!matched) {
          throw new Error(
            `planner CLI did not return valid JSON (tried ${candidates.length} candidates): ${parseErrors.join('; ')} | raw: ${plannerText.slice(0, 300)}`,
          );
        }
        pluginLogger?.debug(`[PlanTask] extracted JSON from multi-object response`, {
          candidateCount: candidates.length,
          expectedTaskId,
          matchedTaskId: matched.taskId,
        });
        submission = matched;
      }

      const normalizedSubmission = normalizePlannerSubmissionEvidence(submission);

      try {
        await persistPlannerOutputFormatDebugEntry(normalizedSubmission);
      } catch (error) {
        pluginLogger?.warn('[PimClaw] Failed to persist planner output debug payload from CLI fallback', {
          taskId: normalizedSubmission.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const applied = await applyPlannerSubmission(normalizedSubmission);
      if ('error' in applied) {
        throw new Error(applied.error);
      }
    },
  };
}

async function syncPlannerMemoryFromTask(taskId: string): Promise<void> {
  if (!plannerMemoryStore || !taskRecorder) {
    pluginLogger?.debug(`[HeadFeedback] skipped planner memory sync`, {
      taskId,
      hasPlannerMemoryStore: Boolean(plannerMemoryStore),
      hasTaskRecorder: Boolean(taskRecorder),
    });
    return;
  }

  const task = taskRecorder.getTask(taskId);
  if (!task) {
    pluginLogger?.debug(`[HeadFeedback] skipped planner memory sync because task was not found`, { taskId });
    return;
  }

  plannerMemoryStore.upsertEpisode(buildPlannerMemoryEpisodeFromTask(task));
  await plannerMemoryStore.flush();
  pluginLogger?.debug(`[HeadFeedback] planner memory synced from reviewed task`, {
    taskId,
    deploymentName: task.llmDeploymentName,
    feedbackSource: task.feedback?.source ?? null,
    feedbackOutcome: task.feedback?.outcome ?? null,
  });
}

function upsertTaskFeedbackSummaryRow(
  sessionId: string,
  row: ReturnType<typeof buildHeadTaskFeedbackRow>,
): void {
  if (!headSummaryStore) {
    pluginLogger?.debug(`[HeadFeedback] skipped summary row upsert because HeadSummaryStore is unavailable`, {
      sessionId,
      taskId: row.taskId,
    });
    return;
  }

  const runId = currentHeadRunIds.get(sessionId);
  if (!runId) {
    pluginLogger?.debug(`[HeadFeedback] skipped summary row upsert because no Head run is active for session`, {
      sessionId,
      taskId: row.taskId,
    });
    return;
  }

  const summary = headSummaryStore.getByRunId(runId);
  if (!summary) {
    pluginLogger?.debug(`[HeadFeedback] skipped summary row upsert because run summary was not found`, {
      sessionId,
      runId,
      taskId: row.taskId,
    });
    return;
  }

  summary.taskFeedbackTable ??= [];
  const existingIndex = summary.taskFeedbackTable.findIndex((item) => item.taskId === row.taskId);
  if (existingIndex >= 0) {
    summary.taskFeedbackTable[existingIndex] = row;
  } else {
    summary.taskFeedbackTable.push(row);
  }

  headSummaryStore.upsert(summary);
  headSummaryStore.flush().catch(() => {});
  pluginLogger?.debug(`[HeadFeedback] summary row upserted`, {
    sessionId,
    runId,
    taskId: row.taskId,
    reviewState: row.reviewState,
    outcome: row.outcome,
    tableSize: summary.taskFeedbackTable.length,
  });
}

function clearPlanningFallback(taskId: string): void {
  const timer = planningFallbackTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    planningFallbackTimers.delete(taskId);
  }
}

async function applyFallbackPlan(taskId: string, reason: string): Promise<boolean> {
  if (!taskRecorder) {
    return false;
  }

  const task = taskRecorder.getTask(taskId);
  if (!task || task.status !== 'planning') {
    return false;
  }

  pluginLogger?.debug(`[PlanTask] taskType decided by fallback`, {
    taskId,
    taskType: plannerFallbackTaskType,
    source: 'fallback',
    reason,
    fallbackConfig: plannerFallbackConfig,
  });
  task.taskType = plannerFallbackTaskType;
  task.config = { ...plannerFallbackConfig };
  task.reasoning = `Fallback plan applied: ${reason}`;
  task.perfEvidence = 'Fallback mode: Planner timed out or failed before submitting plan';
  task.simulationResults = 'No simulation available in fallback mode';

  await taskRecorder.updateTaskStatus(taskId, 'ready');
  pluginLogger?.warn(`[PimClaw] Applied fallback plan to task ${taskId}: ${reason}`);

  return true;
}

function schedulePlanningFallback(taskId: string): void {
  clearPlanningFallback(taskId);
  const timer = setTimeout(() => {
    void applyFallbackPlan(taskId, `planner timeout after ${planningTimeoutMs}ms`);
  }, planningTimeoutMs);
  planningFallbackTimers.set(taskId, timer);
}

/**
 * Register a tool hook for governance.
 * Hooks are applied to all 10 PimClaw tools and are non-fatal.
 */
export function registerToolHook(hook: ToolHook): void {
  toolHooks.push(hook);
}

// ─── Service: lifecycle-managed PimClaw components ─────────────────────────

function createPimClawService(): OpenClawPluginService {
  return {
    id: 'pimclaw-components',

    async start(ctx: OpenClawPluginServiceContext) {
      if (registry && taskRecorder) {
        ctx.logger.info('[PimClaw] Components already started; skipping duplicate start');
        return;
      }

      ctx.logger.info('[PimClaw] Starting components…');

      // File-based rotating logger (wraps ctx.logger so lines go to both)
      const logDir = path.join(ctx.stateDir, 'logs');
      fileLogger = new FileLogger({ logDir, maxFiles: 10, maxFileSizeBytes: 5 * 1024 * 1024 }, ctx.logger);
      await fileLogger.initialize();
      pluginLogger = fileLogger;

      const config = getPluginConfig(ctx);
      const headFeedbackConfig = (config as any)?.headFeedback ?? {};
      headFeedbackSettlingDelayMs = headFeedbackConfig.settlingDelayMs ?? DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS;
      headFeedbackValidityMs = headFeedbackConfig.feedbackValidityMs ?? DEFAULT_HEAD_FEEDBACK_VALIDITY_MS;

      // 1. Shared infrastructure
      registry = new ComponentRegistry();
      taskRecorder = new TaskStatusRecorder(
        `${ctx.stateDir}/pimclaw-tasks`,
        registry,
        fileLogger,
      );
      await taskRecorder.initialize();

      const agentWorkspaceRoot = path.join(ctx.workspaceDir, '.pimclaw-agents');
      const headWorkspaceDir = path.join(agentWorkspaceRoot, 'head');
      const plannerConfig = (config as any)?.planner ?? {};
      const plannerWorkspaceDir = plannerConfig.workspaceDir ?? path.join(agentWorkspaceRoot, 'planner');

      await fs.mkdir(headWorkspaceDir, { recursive: true });
      await fs.mkdir(plannerWorkspaceDir, { recursive: true });
      plannerOutputFormatDebugFilePath = path.join(
        plannerWorkspaceDir,
        PLANNER_OUTPUT_FORMAT_DEBUG_FILE_NAME,
      );
      pluginLogger?.debug('[PimClaw] Planner output debug file resolved', {
        plannerWorkspaceDir,
        plannerOutputFormatDebugFilePath,
      });

      plannerMemoryStore = new PlannerMemoryStore(plannerWorkspaceDir, 100, 100, fileLogger ?? undefined);
      await plannerMemoryStore.load();
      pluginLogger?.debug('[PimClaw] PlannerMemoryStore loaded', {
        workspaceDir: plannerWorkspaceDir,
        episodeCount: plannerMemoryStore.episodeCount,
        lessonCount: plannerMemoryStore.lessonCount,
      });

      // 2. PlannerTrigger — spawns Planner agent via OpenClaw API
      plannerFallbackTaskType = plannerConfig.fallbackTaskType ?? 'scale-up';
      plannerFallbackConfig = plannerConfig.fallbackConfig ?? { replicaDelta: 1 };
      const plannerDeliveryConfig: PlannerDeliveryConfig | undefined = plannerConfig.delivery?.enabled
        ? {
            enabled: true,
            channel: plannerConfig.delivery.channel ?? 'feishu',
            target: plannerConfig.delivery.target,
          }
        : undefined;
      const plannerAgentApi = selectPlannerAgentApi(
        (ctx as any).openclawApi,
        () => createCliPlannerAgentApi(ctx),
      );
      if (plannerAgentApi.mode === 'cli-fallback') {
        ctx.logger.info('[PimClaw] Using CLI-based planner trigger fallback');
      } else {
        ctx.logger.info('[PimClaw] Using injected OpenClaw agent API for planner trigger');
      }
      const plannerTrigger = new PlannerTrigger(plannerAgentApi.api, taskRecorder, {
        agentId: plannerConfig.agentId ?? 'pimclaw-planner',
        timeoutSeconds: plannerConfig.timeoutSeconds ?? 600,
        workspaceDir: plannerWorkspaceDir,
        delivery: plannerDeliveryConfig,
      }, registry, plannerMemoryStore, fileLogger);

      ctx.logger.info(
        `[PimClaw] Dedicated agent workspaces ready: head=${headWorkspaceDir}, planner=${plannerWorkspaceDir}`,
      );
      ctx.logger.info(
        `[PimClaw] Head feedback review window configured: settle=${headFeedbackSettlingDelayMs}ms validity=${headFeedbackValidityMs}ms`,
      );

      // 3. AnomalyReceiver — validates events from LLM Head, triggers Planner
      const receiverConfig = (config as any)?.anomalyReceiver ?? {};
      planningTimeoutMs = receiverConfig.planningTimeoutMs ?? 600_000;
      anomalyReceiver = new AnomalyReceiver(
        taskRecorder,
        plannerTrigger,
        receiverConfig,
        {
          onPlanningTaskCreated: async (taskId) => {
            schedulePlanningFallback(taskId);
          },
          onPlannerTriggerFailed: async (taskId, _events, error) => {
            const message = error instanceof Error ? error.message : String(error);
            await applyFallbackPlan(taskId, `planner trigger failed: ${message}`);
          },
        },
        registry,
        fileLogger,
      );

      // 4. Scheduler — polls for ready tasks, spawns Workers
      scheduler = new SchedulerAgent(
        registry,
        taskRecorder,
        undefined,
        taskExecutor ?? undefined,
        plannerMemoryStore ?? undefined,
        fileLogger,
      );
      await scheduler.initialize();
      scheduler.run().catch((err) =>
        ctx.logger.error(`[PimClaw] Scheduler error: ${err}`),
      );

      // 5. PrometheusClient — for pimclaw_query_metrics tool
      const promCfg = (config as any)?.prometheus;
      if (promCfg?.baseUrl) {
        prometheusClient = new PrometheusClient({
          baseUrl: promCfg.baseUrl,
          timeoutMs: promCfg.timeoutMs,
          username: promCfg.username,
          password: promCfg.password,
          bearerToken: promCfg.bearerToken,
        });
        prometheusQueryOverrides = promCfg.queryOverrides ?? {};
        prometheusDefaultLabels = promCfg.defaultLabels ?? {};
        activeEngines = parseEngineConfig(promCfg.engine);
        ctx.logger.info(`[PimClaw] Prometheus client configured → ${promCfg.baseUrl} (engines: ${activeEngines.join(', ')})`);
      } else {
        ctx.logger.warn('[PimClaw] No prometheus.baseUrl configured — pimclaw_query_metrics will be unavailable');
      }

      // 5b. MetricsStore — ring-buffer for metrics history (max 1000 records, ~185 KB)
      metricsStore = new MetricsStore(`${ctx.stateDir}`, 1000);
      await metricsStore.load();
      ctx.logger.info(`[PimClaw] MetricsStore loaded (${metricsStore.size} existing records)`);

      headSummaryStore = new HeadSummaryStore(headWorkspaceDir, 10);
      await headSummaryStore.load();
      ctx.logger.info(`[PimClaw] HeadSummaryStore loaded (${headSummaryStore.size} existing records)`);

      // 6. Worker task executor — fake remediation for tests, otherwise qianjin-xuntui Engine MCP
      const fakeRemediationCfg = (config as any)?.fakePrometheusRemediation;
      if (fakeRemediationCfg?.baseUrl) {
        taskExecutor = new FakePrometheusTaskExecutor({
          baseUrl: fakeRemediationCfg.baseUrl,
          timeoutMs: fakeRemediationCfg.timeoutMs,
        });
        if (scheduler) {
          (scheduler as any).taskExecutor = taskExecutor;
        }
        ctx.logger.info(`[PimClaw] Fake Prometheus remediation enabled → ${fakeRemediationCfg.baseUrl}`);
      }

      // 6b. EngineMcpClient + TaskExecutor — for Worker execution via qianjin-xuntui MCP
      const engineCfg = (config as any)?.engineMcp;
      if (!taskExecutor && engineCfg?.sseUrl && engineCfg?.username && engineCfg?.password) {
        try {
          engineMcpClient = new EngineMcpClient({
            sseUrl: engineCfg.sseUrl,
            username: engineCfg.username,
            password: engineCfg.password,
            tenantId: engineCfg.tenantId,
            tokenRefreshMarginMs: engineCfg.tokenRefreshMarginMs,
          });
          await engineMcpClient.connect();
          taskExecutor = new TaskExecutor(engineMcpClient);
          // Hot-wire the executor into the already-created scheduler
          if (scheduler) {
            (scheduler as any).taskExecutor = taskExecutor;
          }
          ctx.logger.info(`[PimClaw] Engine MCP connected → ${engineCfg.sseUrl}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`[PimClaw] Engine MCP connection failed: ${msg}`);
          engineMcpClient = null;
          taskExecutor = null;
        }
      } else if (!taskExecutor) {
        ctx.logger.warn('[PimClaw] No engineMcp config — Worker task execution will be unavailable');
      }

      // 7. PerfMcpClient — for Planner historical performance queries
      const perfCfg = (config as any)?.perfMcp;
      if (perfCfg?.serverScriptPath) {
        try {
          perfMcpClient = new PerfMcpClient({
            pythonPath: perfCfg.pythonPath,
            serverScriptPath: perfCfg.serverScriptPath,
            env: perfCfg.env,
          });
          await perfMcpClient.connect();
          ctx.logger.info(`[PimClaw] Perf MCP connected → ${perfCfg.serverScriptPath}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`[PimClaw] Perf MCP connection failed: ${msg}`);
          perfMcpClient = null;
        }
      } else {
        ctx.logger.warn('[PimClaw] No perfMcp.serverScriptPath configured — pimclaw_query_perfllm will be unavailable');
      }

      // 8. SimMcpClient — for Planner simulation-based config validation
      const simCfg = (config as any)?.simMcp;
      simMcpConfig = simCfg?.sseUrl
        ? { sseUrl: simCfg.sseUrl }
        : null;
      if (simCfg?.sseUrl) {
        const connected = await connectSimMcpClient(ctx.logger);
        if (!connected) {
          ctx.logger.error(`[PimClaw] Sim MCP connection failed: ${simMcpUnavailableReason}`);
        }
      } else {
        simMcpUnavailableReason = 'sim MCP not configured';
        ctx.logger.warn('[PimClaw] No simMcp.sseUrl configured — pimclaw_sim_* tools will be unavailable');
      }

      ctx.logger.info(
        '[PimClaw] Components started (TaskRecorder → AnomalyReceiver → Scheduler)',
      );
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info('[PimClaw] Stopping components…');

      if (scheduler) {
        await scheduler.shutdown();
        scheduler = null;
      }
      anomalyReceiver = null;
      for (const taskId of planningFallbackTimers.keys()) {
        clearPlanningFallback(taskId);
      }
      if (taskRecorder) {
        await taskRecorder.persist();
        taskRecorder = null;
      }
      if (plannerMemoryStore) {
        await plannerMemoryStore.flush();
        plannerMemoryStore = null;
      }
      if (engineMcpClient) {
        await engineMcpClient.disconnect();
        engineMcpClient = null;
      }
      if (perfMcpClient) {
        await perfMcpClient.disconnect();
        perfMcpClient = null;
      }
      if (simMcpClient) {
        await simMcpClient.disconnect();
        simMcpClient = null;
      }
      simMcpConfig = null;
      simMcpUnavailableReason = 'sim MCP not configured';
      taskExecutor = null;
      registry = null;
      if (metricsStore) {
        await metricsStore.flush();
        metricsStore = null;
      }
      if (headSummaryStore) {
        await headSummaryStore.flush();
        headSummaryStore = null;
      }
      currentHeadRunIds.clear();
      prometheusClient = null;
      prometheusQueryOverrides = {};
      prometheusDefaultLabels = {};
      activeEngines = [...ALL_ENGINES];
      plannerOutputFormatDebugFilePath = null;
      plannerOutputFormatDebugWriteChain = Promise.resolve();
      headFeedbackSettlingDelayMs = DEFAULT_HEAD_FEEDBACK_SETTLING_DELAY_MS;
      headFeedbackValidityMs = DEFAULT_HEAD_FEEDBACK_VALIDITY_MS;
      pluginConfig = {};
      pluginRuntime = null;
      if (fileLogger) {
        await fileLogger.close();
        fileLogger = null;
      }
      pluginLogger = null;
      toolHooks.length = 0;

      ctx.logger.info('[PimClaw] All components stopped');
    },
  };
}

// ─── Tool builders ─────────────────────────────────────────────────────────

function buildPimClawTools() {
  // ── Prometheus Metrics Tool (Phase 1, Step 3) ──────────────────────────
  const queryMetricsTool = () => ({
    name: 'pimclaw_query_metrics',
    description:
      'Query Prometheus for inference metrics (TTFT, TPOT, QPS, throughput, GPU utilization, error rate) and GPU hardware metadata across all configured inference engines (vllm, sglang). Results are grouped by engine. Use rangeMinutes to get time-series data as [timestamp, value] pairs for trend analysis. TTFT and TPOT values are already in seconds; do not divide them by 1000. Called by the Head Agent every 5 minutes.',
    parameters: {
      type: 'object' as const,
      properties: {
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Which metrics to fetch. Options: ttft, tpot, qps, throughput, gpu_utilization, error_rate. Default: all.',
        },
        deploymentName: {
          type: 'string',
          description: 'model_name label to filter by',
        },
        engine: {
          oneOf: [
            { type: 'string', enum: ['vllm', 'sglang'] },
            { type: 'array', items: { type: 'string', enum: ['vllm', 'sglang'] } },
          ],
          description:
            'Filter to specific engine(s). Accepts a single engine name or an array. Default: all configured engines.',
        },
        rangeMinutes: {
          type: 'number',
          description: 'Return time-series [timestamp, value] pairs over this many minutes (step ~15s). Use 5 to match the Head Agent cron interval.',
        },
      },
    },
    async execute(sessionId: string, params: Record<string, unknown>) {
      if (!prometheusClient) {
        return {
          output: JSON.stringify({
            error: 'Prometheus not configured. Set prometheus.baseUrl in plugin config.',
          }),
        };
      }

      // Determine which engines to query: per-call param > config-level activeEngines
      const engines: InferenceEngine[] = params.engine
        ? parseEngineConfig(params.engine)
        : activeEngines;

      const requestedMetrics = (params.metrics as string[] | undefined) ?? allMetricNames();
      const deploymentName = params.deploymentName as string | undefined;
      const rangeMinutes = params.rangeMinutes as number | undefined;
      const nowSec = Math.floor(Date.now() / 1000);
      const runtimeAnomalyHints: RuntimeAnomalyHint[] = [];
      const autoSubmittedAnomalies: unknown[] = [];
      const unitHints: Record<string, { unit: string; note: string }> = {
        ttft: {
          unit: 'seconds',
          note: 'Values from vllm:time_to_first_token_seconds_bucket / sglang:time_to_first_token_seconds_bucket are already seconds. Example: 78 means 78s, not 78ms or 0.078s.',
        },
        tpot: {
          unit: 'seconds_per_token',
          note: 'Values are already seconds per output token. Do not divide by 1000 unless a future metric name explicitly says milliseconds.',
        },
        qps: {
          unit: 'requests_per_second',
          note: 'Requests per second.',
        },
        throughput: {
          unit: 'tokens_per_second',
          note: 'Generated tokens per second.',
        },
        gpu_utilization: {
          unit: 'ratio',
          note: 'Usually returned as a 0-1 ratio. Convert 0.06 to 6% only for display.',
        },
        error_rate: {
          unit: 'percent',
          note: 'Returned as percent because the PromQL multiplies by 100.',
        },
      };
      const annotateMetricResult = (metric: string, result: unknown): unknown => {
        const hint = unitHints[metric];
        if (!hint || !Array.isArray(result)) return result;
        return result.map((series) => {
          if (!series || typeof series !== 'object' || Array.isArray(series)) return series;
          return {
            ...series,
            pimclawUnit: hint.unit,
            pimclawUnitNote: hint.note,
          };
        });
      };

      const grouped: Record<string, Record<string, unknown>> = {};
      const gpuMetadataQueries: Record<string, string[]> = {
        vllm: [
          'vllm:gpu_info',
          'vllm:kv_cache_usage_perc:with_gpu',
          'vllm:num_requests_running:with_gpu',
          'vllm:num_requests_waiting:with_gpu',
        ],
      };

      for (const engine of engines) {
        const promqlMap = getPromQLMap(engine);
        const engineResults: Record<string, unknown> = {};
        const gpuByDeployment: Record<string, GpuHardwareInfo> = {};
        const gpuInfoSeries: unknown[] = [];
        const gpuQueries = gpuMetadataQueries[engine] ?? [];

        for (const gpuPromqlBase of gpuQueries) {
          const labels: Record<string, string> = { ...prometheusDefaultLabels };
          if (deploymentName) {
            labels['model_name'] = deploymentName;
          }
          const gpuPromql = injectLabels(gpuPromqlBase, labels);
          try {
            const gpuQueryResult = await prometheusClient!.query(gpuPromql);
            gpuInfoSeries.push(
              ...gpuQueryResult.map((series) => {
                const gpuType = extractGpuTypeFromLabels(series.metric);
                return {
                  ...series,
                  pimclawGpuType: gpuType ?? undefined,
                  hardware_name: gpuType ? normalizeHardwareName(gpuType) : undefined,
                  pimclawGpuInfoSource: gpuPromqlBase,
                };
              }),
            );
            mergeGpuHardwareMaps(
              gpuByDeployment,
              buildGpuHardwareMap(gpuQueryResult, gpuPromqlBase),
            );
          } catch (err) {
            gpuInfoSeries.push({
              metric: { __name__: gpuPromqlBase },
              error: err instanceof Error ? err.message : String(err),
              pimclawGpuInfoSource: gpuPromqlBase,
            });
          }
        }
        if (gpuInfoSeries.length > 0) {
          engineResults.gpu_info = gpuInfoSeries;
        }
        engineResults.pimclawHardwareByDeployment = gpuByDeployment;

        for (const metric of requestedMetrics) {
          // Resolve PromQL: config override > engine-specific map
          let promql = prometheusQueryOverrides[metric] ?? promqlMap[metric];
          if (!promql) {
            // This metric may not exist for this engine — skip silently
            continue;
          }

          // Inject labels (deploymentName + defaultLabels from config)
          const labels: Record<string, string> = { ...prometheusDefaultLabels };
          if (deploymentName) {
            labels['model_name'] = deploymentName;
          }
          promql = injectLabels(promql, labels);

          try {
            let queryResult: unknown;
            if (rangeMinutes) {
              const start = nowSec - rangeMinutes * 60;
              const step = Math.max(15, Math.floor((rangeMinutes * 60) / 20));
              queryResult = await prometheusClient!.queryRange(promql, start, nowSec, step);
            } else {
              queryResult = await prometheusClient!.query(promql);
            }
            queryResult = annotateGpuHardware(queryResult, gpuByDeployment);
            runtimeAnomalyHints.push(...buildRuntimeAnomalyHints(engine, metric, queryResult));
            engineResults[metric] = annotateMetricResult(metric, queryResult);
          } catch (err) {
            engineResults[metric] = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        grouped[engine] = engineResults;
      }

      if (runtimeAnomalyHints.length > 0 && anomalyReceiver) {
        try {
          const actionableEvents = runtimeAnomalyHints
            .filter((hint) => hint.actionRequired === 'submit_anomaly')
            .map((hint) => ({
              type: hint.type,
              metricName: hint.metricName,
              currentValue: hint.currentValue,
              previousValue: hint.previousValue,
              severity: hint.severity,
              deploymentName: hint.deploymentName,
              hardwareName: hint.hardwareName,
              gpuType: hint.gpuType,
              reasoning: `[runtime guardrail] ${hint.reason}`,
            }));
          if (actionableEvents.length > 0) {
            const validated = await anomalyReceiver.receive(actionableEvents);
            autoSubmittedAnomalies.push(
              ...validated.map((event) => ({
                eventId: event.eventId,
                taskId: event.taskId,
                metricName: event.metricName,
                deploymentName: event.deploymentName,
                severity: event.severity,
              })),
            );
          }
        } catch (err) {
          autoSubmittedAnomalies.push({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Persist a single record with per-deployment flat metrics
      if (metricsStore) {
        const allDeploymentMetrics: DeploymentMetrics[] = [];

        for (const engine of engines) {
          const engineResults = grouped[engine];
          if (!engineResults) continue;

          // Collect unique deployment names across all metrics for this engine
          const deploymentNames = collectDeploymentNames(engineResults, requestedMetrics);

          // Build a flat entry per deployment
          for (const depName of deploymentNames) {
            const hardwareInfo = (engineResults.pimclawHardwareByDeployment as Record<string, GpuHardwareInfo> | undefined)?.[depName];
            const entry: DeploymentMetrics = {
              deployments: depName,
              engine,
              hardwareName: hardwareInfo?.hardware_name,
              gpuType: hardwareInfo?.gpuType,
              ttft: 0, tpot: 0, qps: 0,
              throughput: 0, gpu_utilization: 0, error_rate: 0,
            };
            for (const metric of summaryMetrics) {
              const results = engineResults[metric] as any[];
              if (Array.isArray(results)) {
                const match = results.find((r: any) => r?.metric?.model_name === depName);
                if (match) {
                  const val = extractMetricValue([match]);
                  entry[metric] = val != null && !Number.isNaN(val) ? val : 0;
                }
              }
            }
            allDeploymentMetrics.push(entry);
          }
        }

        metricsStore.add({ ts: Date.now(), metrics: allDeploymentMetrics });
        metricsStore.flush().catch(() => {});
      }

      if (headSummaryStore && typeof rangeMinutes === 'number' && rangeMinutes > 0) {
        const runId = uuidv4();
        const summaryRecord = buildHeadSummaryRecord(
          sessionId,
          grouped,
          engines,
          runId,
          headSummaryStore,
        );
        headSummaryStore.upsert(summaryRecord);
        currentHeadRunIds.set(sessionId, runId);
        headSummaryStore.flush().catch(() => {});
      }

      return {
        output: JSON.stringify({
          pimclawRuntimeAnomalyHints: runtimeAnomalyHints,
          pimclawAutoSubmittedAnomalies: autoSubmittedAnomalies,
          ...grouped,
        }),
      };
    },
  });

  // ── Gate 1: LLM Head Agent → Plugin ──────────────────────────────────────

  const submitAnomaliesTool = () => ({
    name: 'pimclaw_submit_anomalies',
    description:
      'Submit detected anomaly events for task planning. Called by the PimClaw Head Agent after analyzing Prometheus metrics.',
    parameters: {
      type: 'object' as const,
      properties: {
        events: {
          type: 'array',
          description: 'Array of anomaly events detected by the Head Agent',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['spike', 'drop', 'trend', 'anomaly'] },
              metricName: { type: 'string' },
              currentValue: { type: 'number' },
              previousValue: { type: 'number' },
              severity: { type: 'string', enum: ['high', 'medium', 'low'] },
              deploymentName: { type: 'string' },
              hardwareName: { type: 'string', description: 'Optional normalized HiSim runtime hardware name from pimclaw_query_metrics, for example "NVIDIA H800_SXM".' },
              gpuType: { type: 'string', description: 'Optional raw GPU model label from Prometheus, for example "NVIDIA H800".' },
              reasoning: { type: 'string' },
            },
            required: ['type', 'metricName', 'currentValue', 'severity', 'deploymentName'],
          },
        },
      },
      required: ['events'],
    },
    async execute(sessionId: string, params: Record<string, unknown>) {
      if (!anomalyReceiver) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        const events = params.events as AnomalyEvent[];
        const validated = await anomalyReceiver.receive(events);

        if (headSummaryStore) {
          const runId = currentHeadRunIds.get(sessionId);
          if (runId) {
            const summary = headSummaryStore.getByRunId(runId);
            if (summary) {
              mergeAnomaliesIntoSummary(summary, validated);
              headSummaryStore.upsert(summary);
              headSummaryStore.flush().catch(() => {});
            }
          }
        }

        return {
          output: JSON.stringify({
            success: true,
            accepted: validated.length,
            tasks: validated.map((e) => ({ taskId: e.taskId, eventId: e.eventId })),
          }),
        };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  const submitTaskFeedbackTool = () => ({
    name: 'pimclaw_submit_task_feedback',
    description:
      'Submit Head follow-up feedback for a completed task after reviewing fresh runtime metrics within the valid review window.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Completed task ID to review' },
        outcome: {
          type: 'string',
          enum: ['helped', 'no-effect', 'worsened', 'unknown'],
          description: 'Final Head follow-up outcome',
        },
        statusSummary: {
          type: 'string',
          enum: ['pending-review', 'completed-successfully', 'completed-with-errors', 'execution-failed', 'timed-out', 'expired', 'unknown'],
          description: 'High-level review status summary',
        },
        summary: { type: 'string', description: 'Short factual review summary' },
        metricAssessments: {
          type: 'array',
          description: 'Per-metric follow-up assessments based on fresh runtime observations',
          items: {
            type: 'object',
            properties: {
              metricName: { type: 'string', enum: ['ttft', 'tpot', 'qps', 'throughput', 'gpu_utilization', 'error_rate'] },
              direction: { type: 'string', enum: ['improved', 'regressed', 'unchanged', 'unknown'] },
              previousValue: { type: 'number' },
              currentValue: { type: 'number' },
              delta: { type: 'number' },
              percentChange: { type: 'number' },
              note: { type: 'string' },
            },
            required: ['metricName', 'direction'],
          },
        },
        reviewerNotes: { type: 'string', description: 'Optional extra notes from the Head agent' },
      },
      required: ['taskId', 'outcome', 'statusSummary', 'summary'],
    },
    async execute(sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        pluginLogger?.debug(`[HeadFeedback] tool invoked while service is not running`, { sessionId });
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }

      const taskId = params.taskId as string;
      pluginLogger?.debug(`[HeadFeedback] tool invoked`, {
        sessionId,
        taskId,
        statusSummary: params.statusSummary,
        metricAssessmentCount: Array.isArray(params.metricAssessments) ? params.metricAssessments.length : 0,
        hasReviewerNotes: typeof params.reviewerNotes === 'string' && params.reviewerNotes.trim().length > 0,
      });

      const task = taskRecorder.getTask(taskId);
      if (!task) {
        pluginLogger?.debug(`[HeadFeedback] task not found`, { taskId, sessionId });
        return { output: JSON.stringify({ error: `Task ${taskId} not found` }) };
      }

      const now = new Date();
      const metricAssessments = (params.metricAssessments as TaskFeedbackMetricAssessment[] | undefined) ?? [];
      const rawReviewState = getHeadTaskFeedbackReviewState(
        task,
        now,
        headFeedbackSettlingDelayMs,
        headFeedbackValidityMs,
      );
      const reviewState = rawReviewState === 'ineligible' ? 'rejected' : rawReviewState;
      pluginLogger?.debug(`[HeadFeedback] review state resolved`, {
        sessionId,
        taskId,
        deploymentName: task.llmDeploymentName,
        taskStatus: task.status,
        completedAt: task.completedAt instanceof Date ? task.completedAt.toISOString() : task.completedAt ?? null,
        previousFeedbackSource: task.feedback?.source ?? null,
        previousFeedbackOutcome: task.feedback?.outcome ?? null,
        settlingDelayMs: headFeedbackSettlingDelayMs,
        feedbackValidityMs: headFeedbackValidityMs,
        rawReviewState,
        reviewState,
      });

      if (reviewState !== 'eligible') {
        upsertTaskFeedbackSummaryRow(
          sessionId,
          buildHeadTaskFeedbackRow(
            task,
            reviewState,
            params.summary as string,
            metricAssessments,
            null,
          ),
        );
        pluginLogger?.debug(`[HeadFeedback] feedback submission rejected by review window`, {
          sessionId,
          taskId,
          reviewState,
          metricAssessmentCount: metricAssessments.length,
        });
        return {
          output: JSON.stringify({
            success: false,
            taskId,
            feedbackSource: 'head-followup',
            reviewState,
            generatedAt: now.toISOString(),
          }),
        };
      }

      const details: TaskFeedback['details'] = {};
      if (metricAssessments.length > 0) {
        details.metricAssessments = metricAssessments;
      }
      if (typeof params.reviewerNotes === 'string' && params.reviewerNotes.trim()) {
        details.reviewerNotes = params.reviewerNotes;
      }

      const fallbackOutcome = params.outcome as 'helped' | 'no-effect' | 'worsened' | 'unknown';
      const outcome = deriveHeadFollowupOutcome(metricAssessments, fallbackOutcome);
      pluginLogger?.debug(`[HeadFeedback] outcome derived`, {
        sessionId,
        taskId,
        fallbackOutcome,
        derivedOutcome: outcome,
        metricAssessmentCount: metricAssessments.length,
        metricDirections: metricAssessments.map((assessment) => ({
          metricName: assessment.metricName,
          direction: assessment.direction,
        })),
      });

      const feedback: TaskFeedback = {
        version: 1,
        statusSummary: params.statusSummary as TaskFeedbackStatusSummary,
        outcome,
        source: 'head-followup',
        generatedAt: now,
        summary: params.summary as string,
        details: Object.keys(details).length > 0 ? details : undefined,
      };

      await taskRecorder.updateTaskFeedback(taskId, feedback);
      pluginLogger?.debug(`[HeadFeedback] task feedback persisted`, {
        taskId,
        sessionId,
        deploymentName: task.llmDeploymentName,
        statusSummary: feedback.statusSummary,
        outcome: feedback.outcome,
      });
      await syncPlannerMemoryFromTask(taskId);

      const latestTask = taskRecorder.getTask(taskId) ?? task;
      upsertTaskFeedbackSummaryRow(
        sessionId,
        buildHeadTaskFeedbackRow(
          latestTask,
          'applied',
          feedback.summary,
          metricAssessments,
          outcome,
        ),
      );
      pluginLogger?.debug(`[HeadFeedback] feedback flow applied`, {
        taskId,
        sessionId,
        deploymentName: latestTask.llmDeploymentName,
        reviewState: 'applied',
        outcome,
      });

      return {
        output: JSON.stringify({
          success: true,
          taskId,
          feedbackSource: 'head-followup',
          reviewState: 'applied',
          generatedAt: now.toISOString(),
        }),
      };
    },
  });

  // ── Gate 2: LLM Planner Agent → Plugin ───────────────────────────────────

  const planTaskTool = () => ({
    name: 'pimclaw_plan_task',
    description:
      'Submit a deployment configuration plan for a task in planning state. Called by the PimClaw Planner Agent after analyzing perf data and simulation results.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'The task ID to attach the plan to' },
        taskType: {
          type: 'string',
          enum: ['scale-up', 'scale-down', 'restart', 'reconfigure'],
          description: 'Type of deployment change',
        },
        config: {
          type: 'object',
          description: 'Deployment configuration to apply',
          properties: {
            replicas: { type: 'number' },
            dtype: { type: 'string' },
            quantization: { type: 'string' },
            maxBatchSize: { type: 'number' },
            tensorParallelism: { type: 'number' },
          },
        },
        reasoning: { type: 'string', description: 'Why this config was selected' },
        perfEvidence: { type: 'string', description: 'Historical perf data supporting this choice' },
        simulationResults: { type: 'string', description: 'Simulation predictions for this config' },
      },
      required: ['taskId', 'taskType', 'config', 'reasoning'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      pluginLogger?.debug(`[PlanTask] tool invoked`, { taskId: params.taskId, taskType: params.taskType });
      try {
        const submission: PlannerSubmission = {
          taskId: params.taskId as string,
          taskType: params.taskType as string,
          config: params.config as Record<string, unknown>,
          reasoning: params.reasoning as string,
          perfEvidence: params.perfEvidence as string | undefined,
          simulationResults: params.simulationResults as string | undefined,
        };
        const normalizedSubmission = normalizePlannerSubmissionEvidence(submission);

        try {
          await persistPlannerOutputFormatDebugEntry(normalizedSubmission);
        } catch (error) {
          pluginLogger?.warn('[PimClaw] Failed to persist planner output debug payload from tool submission', {
            taskId: normalizedSubmission.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const result = await applyPlannerSubmission(normalizedSubmission);

        pluginLogger?.debug(`[PlanTask] tool result`, { taskId: params.taskId, success: !('error' in result) });
        return { output: JSON.stringify(result) };
      } catch (err) {
        pluginLogger?.debug(`[PlanTask] tool error`, { taskId: params.taskId, error: err instanceof Error ? err.message : String(err) });
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  // ── Existing tools ───────────────────────────────────────────────────────

  const routeTaskTool = () => ({
    name: 'pimclaw_route_task',
    description:
      'Submit a task directly to PimClaw (bypasses Head/Planner). The Scheduler picks it up and creates a Worker.',
    parameters: {
      type: 'object' as const,
      properties: {
        llmDeploymentName: {
          type: 'string',
          description: 'Target LLM deployment name',
        },
        taskType: {
          type: 'string',
          description: 'Task type (scale-up, scale-down, restart, etc.)',
        },
        priority: {
          type: 'string',
          description: 'Priority (low, medium, high). Defaults to medium.',
        },
        taskData: {
          type: 'object',
          description: 'Arbitrary task payload',
        },
      },
      required: ['llmDeploymentName', 'taskType'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      pluginLogger?.debug(`[RouteTask] taskType decided by caller`, {
        taskType: params.taskType,
        source: 'pimclaw_route_task',
        deploymentName: params.llmDeploymentName,
        priority: params.priority ?? 'medium',
      });
      const task: Task = {
        taskId: uuidv4(),
        status: 'ready',
        createdAt: new Date(),
        statusModifiedAt: new Date(),
        priority: (params.priority as Task['priority']) || 'medium',
        llmDeploymentName: params.llmDeploymentName as string,
        taskType: params.taskType as string,
        taskData: (params.taskData as Record<string, unknown>) || {},
        retryCount: 0,
        maxRetries: 3,
      };
      await taskRecorder.createTask(task);
      return {
        output: JSON.stringify({
          success: true,
          taskId: task.taskId,
          message: `Task routed to scheduler for ${task.llmDeploymentName}`,
        }),
      };
    },
  });

  const listComponentsTool = () => ({
    name: 'pimclaw_list_components',
    description: 'List all active PimClaw components (Scheduler, Task Status Recorder, Workers) and their runtime status.',
    parameters: {
      type: 'object' as const,
      properties: {
        componentType: {
          type: 'string',
          description: 'Filter by type (scheduler, recorder, worker)',
        },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const components = registry.getAllAgentsStatus();
      const filtered = params.componentType
        ? components.filter((a) => a.agentType === params.componentType)
        : components;
      return { output: JSON.stringify(filtered) };
    },
  });

  const componentStatusTool = () => ({
    name: 'pimclaw_component_status',
    description: 'Get detailed runtime status of a specific PimClaw component.',
    parameters: {
      type: 'object' as const,
      properties: {
        componentId: { type: 'string', description: 'Component ID' },
      },
      required: ['componentId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const status = registry.getAgentStatus(params.componentId as string);
      return { output: JSON.stringify(status ?? { error: 'Component not found' }) };
    },
  });

  const healthTool = () => ({
    name: 'pimclaw_health',
    description:
      'Get the overall PimClaw health report including component status and detected issues.',
    parameters: { type: 'object' as const, properties: {} },
    async execute() {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      return { output: JSON.stringify(registry.getHealthReport()) };
    },
  });

  const taskCountsTool = () => ({
    name: 'pimclaw_task_counts',
    description: 'Get counts of PimClaw tasks grouped by status.',
    parameters: { type: 'object' as const, properties: {} },
    async execute() {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      return { output: JSON.stringify(taskRecorder.getTaskCounts()) };
    },
  });

  const listTasksTool = () => ({
    name: 'pimclaw_list_tasks',
    description: 'List PimClaw tasks, optionally filtered by status.',
    parameters: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description:
            'Filter by status (planning, ready, scheduling, scheduled, running, done, failed, expired)',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const limit = (params.limit as number) || 20;
      return {
        output: JSON.stringify(taskRecorder.getRecentTasks(limit, params.status as any)),
      };
    },
  });

  const retryTaskTool = () => ({
    name: 'pimclaw_retry_task',
    description: 'Reset a failed PimClaw task so the Scheduler retries it.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to retry' },
      },
      required: ['taskId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        await taskRecorder.resetTaskForRetry(params.taskId as string);
        return { output: JSON.stringify({ success: true, taskId: params.taskId }) };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  const revokeTaskTool = () => ({
    name: 'pimclaw_revoke_task',
    description: 'Cancel a pending PimClaw task by marking it expired.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to revoke' },
      },
      required: ['taskId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        await taskRecorder.updateTaskStatus(params.taskId as string, 'expired');
        return { output: JSON.stringify({ success: true, taskId: params.taskId }) };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  // ── Perf MCP Tools (perfllm historical data) ────────────────────────────

  function summarizePerfQueryParams(params: Record<string, unknown>): Record<string, unknown> {
    return {
      modelName: params.model_name,
      scenario: params.scenario,
      engineName: params.engine_name,
      deviceType: params.device_type,
      nodeNum: params.node_num,
      devicePerNode: params.device_per_node,
      limit: params.limit,
    };
  }

  function summarizePerfResult(result: unknown): Record<string, unknown> {
    if (Array.isArray(result)) {
      return {
        resultType: 'array',
        rowCount: result.length,
      };
    }

    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      const rows = Array.isArray(record.rows) ? record.rows : undefined;
      const columns = Array.isArray(record.columns) ? record.columns : undefined;
      return {
        resultType: 'object',
        resultKeys: Object.keys(record).slice(0, 12),
        rowCount: rows?.length,
        columnCount: columns?.length,
        text: typeof record.text === 'string' ? record.text.slice(0, 200) : undefined,
        error: typeof record.error === 'string' ? record.error : undefined,
      };
    }

    return {
      resultType: typeof result,
      resultPreview: result == null ? result : String(result).slice(0, 200),
    };
  }

  const queryPerfllmTool = () => ({
    name: 'pimclaw_query_perfllm',
    description:
      'Query the perfllm database for historical LLM performance benchmark data. ' +
      'Returns deployment configs and their measured TTFT, TPOT, QPS, throughput. ' +
      'Called by the Planner Agent to find candidate configurations.',
    parameters: {
      type: 'object' as const,
      properties: {
        model_name: { type: 'string', description: 'Filter by model name (e.g. Qwen/Qwen3-235B-A22B)' },
        scenario: { type: 'string', description: 'Filter by test scenario (e.g. vibe-coding)' },
        engine_name: { type: 'string', description: 'Filter by inference engine (e.g. vllm, sglang)' },
        device_type: { type: 'string', description: 'Filter by hardware type (e.g. nvidia/h800)' },
        node_num: { type: 'number', description: 'Filter by number of nodes' },
        device_per_node: { type: 'number', description: 'Filter by devices per node' },
        limit: { type: 'number', description: 'Max rows to return (default 10, max 100)' },
      },
    },
    async execute(sessionId: string, params: Record<string, unknown>) {
      const invocationId = uuidv4();
      const startedAt = Date.now();
      pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_query_perfllm invoked`, {
        invocationId,
        sessionId,
        connected: Boolean(perfMcpClient?.isConnected),
        params: summarizePerfQueryParams(params),
      });
      if (!perfMcpClient) {
        pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_query_perfllm unavailable`, {
          invocationId,
          sessionId,
          durationMs: Date.now() - startedAt,
          reason: 'perf MCP not configured',
        });
        return {
          output: JSON.stringify({
            error: 'Perf MCP not configured. Set perfMcp.serverScriptPath in plugin config.',
          }),
        };
      }
      try {
        const result = await perfMcpClient.queryPerfllm(params);
        pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_query_perfllm completed`, {
          invocationId,
          sessionId,
          durationMs: Date.now() - startedAt,
          result: summarizePerfResult(result),
        });
        return { output: JSON.stringify(result) };
      } catch (err) {
        pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_query_perfllm failed`, {
          invocationId,
          sessionId,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  const getPerfllmSchemaTool = () => ({
    name: 'pimclaw_get_perfllm_schema',
    description:
      'Get the schema of the perfllm database table. Shows all available columns, ' +
      'types, and nullability. Use this to understand what data is available before querying.',
    parameters: { type: 'object' as const, properties: {} },
    async execute(sessionId: string) {
      const invocationId = uuidv4();
      const startedAt = Date.now();
      pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_get_perfllm_schema invoked`, {
        invocationId,
        sessionId,
        connected: Boolean(perfMcpClient?.isConnected),
      });
      if (!perfMcpClient) {
        pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_get_perfllm_schema unavailable`, {
          invocationId,
          sessionId,
          durationMs: Date.now() - startedAt,
          reason: 'perf MCP not configured',
        });
        return {
          output: JSON.stringify({
            error: 'Perf MCP not configured. Set perfMcp.serverScriptPath in plugin config.',
          }),
        };
      }
      try {
        const result = await perfMcpClient.getSchema();
        pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_get_perfllm_schema completed`, {
          invocationId,
          sessionId,
          durationMs: Date.now() - startedAt,
          result: summarizePerfResult(result),
        });
        return { output: JSON.stringify(result) };
      } catch (err) {
        pluginLogger?.debug(`[Planner:PerfQuery] pimclaw_get_perfllm_schema failed`, {
          invocationId,
          sessionId,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  // ── Simulator MCP Tools (Hisim hardware-aware simulation) ────────────────

  function summarizeSimParams(params: Record<string, unknown>): Record<string, unknown> {
    return {
      model: (params.model_path ?? params.model) as string | undefined,
      hardware: params.hardware_name as string | undefined,
      databasePath: params.database_path as string | undefined,
      configPath: params.config_path as string | undefined,
      host: params.host as string | undefined,
      modelName: params.model_name as string | undefined,
      deviceName: params.device_name as string | undefined,
      datasetName: params.dataset_name as string | undefined,
      datasetPath: params.dataset_path as string | undefined,
      baseUrl: params.base_url as string | undefined,
      port: params.port,
      tpSize: params.tp_size,
      epSize: params.ep_size,
      dpSize: params.dp_size,
      dataType: params.data_type,
      kvCacheDataType: params.kv_cache_data_type,
      backend: params.backend,
      backendName: params.backend_name,
      backendVersion: params.backend_version,
      requestRate: params.request_rate,
      maxConcurrency: params.max_concurrency,
      numPrompts: params.num_prompts,
      randomInputLen: params.random_input_len,
      randomOutputLen: params.random_output_len,
      randomRangeRatio: params.random_range_ratio,
      warmupRequests: params.warmup_requests,
      outputFile: params.output_file as string | undefined,
      outputDetails: params.output_details,
      skipWarmup: params.skip_warmup,
      databaseMode: params.database_mode,
      numDevicePerNode: params.num_device_per_node,
      autoRegisterModel: params.auto_register_model,
    };
  }

  function packExtraRequestBody(
    params: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> {
    const extra = params.extra_request_body && typeof params.extra_request_body === 'object' && !Array.isArray(params.extra_request_body)
      ? { ...(params.extra_request_body as Record<string, unknown>) }
      : {};
    for (const key of keys) {
      if (params[key] !== undefined && extra[key] === undefined) {
        extra[key] = params[key];
      }
    }
    return extra;
  }

  function adaptSimToolParams(name: string, params: Record<string, unknown>): Record<string, unknown> {
    if (name === 'pimclaw_sim_benchmark') {
      return {
        ...params,
        backend: params.backend ?? 'sglang',
        base_url: params.base_url ?? 'http://127.0.0.1:8723',
        dataset_name: params.dataset_name ?? 'random',
        warmup_requests: params.warmup_requests ?? 0,
        extra_request_body: packExtraRequestBody(params, [
          'num_prompts',
          'dataset_path',
          'random_input_len',
          'random_output_len',
          'random_range_ratio',
          'request_rate',
          'max_concurrency',
          'seed',
          'disable_tqdm',
          'disable_stream',
          'disable_ignore_eos',
          'output_file',
          'output_details',
        ]),
      };
    }

    if (name === 'pimclaw_sim_dataset_info') {
      return {
        ...params,
        dataset_name: params.dataset_name ?? 'random',
        extra_request_body: packExtraRequestBody(params, [
          'num_prompts',
          'dataset_path',
          'random_input_len',
          'random_output_len',
          'random_range_ratio',
          'seed',
        ]),
      };
    }

    return params;
  }

  function summarizeSimResult(result: unknown): Record<string, unknown> {
    if (Array.isArray(result)) {
      return {
        resultType: 'array',
        itemCount: result.length,
      };
    }

    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      return {
        resultType: 'object',
        resultKeys: Object.keys(record).slice(0, 12),
        text: typeof record.text === 'string' ? record.text.slice(0, 200) : undefined,
        error: typeof record.error === 'string' ? record.error : undefined,
        meanTtftMs: record.mean_ttft_ms,
        meanTpotMs: record.mean_tpot_ms,
        outputThroughput: record.output_throughput,
        peakOutputThroughput: record.peak_output_throughput,
        totalThroughput: record.total_throughput,
        requestThroughput: record.request_throughput,
        inputThroughput: record.input_throughput,
        meanE2eLatencyMs: record.mean_e2e_latency_ms,
        p99E2eLatencyMs: record.p99_e2e_latency_ms,
        medianTtftMs: record.median_ttft_ms,
        p99TtftMs: record.p99_ttft_ms,
        medianTpotMs: record.median_tpot_ms,
        p99TpotMs: record.p99_tpot_ms,
        peakConcurrentRequests: record.peak_concurrent_requests,
        concurrency: record.concurrency,
        running: record.running,
        isRunning: record.is_running,
        pid: record.pid,
        port: record.port,
        registeredCount: Array.isArray(record.hardware_list)
          ? record.hardware_list.length
          : Array.isArray(record.hardware)
            ? record.hardware.length
            : undefined,
      };
    }

    return {
      resultType: typeof result,
      resultPreview: result == null ? result : String(result).slice(0, 200),
    };
  }

  /** Helper: create a sim tool that proxies to SimMcpClient.callTool() */
  function simTool(
    name: string,
    hisimToolName: string,
    description: string,
    parameters: Record<string, unknown>,
  ) {
    return () => ({
      name,
      description,
      parameters,
      async execute(sessionId: string, params: Record<string, unknown>) {
        const invocationId = uuidv4();
        const startedAt = Date.now();
        pluginLogger?.debug(`[Planner:Sim] ${name} invoked`, {
          invocationId,
          sessionId,
          hisimTool: hisimToolName,
          connected: Boolean(simMcpClient?.isConnected),
          params: summarizeSimParams(params),
        });
        if (!simMcpClient && simMcpConfig?.sseUrl) {
          await connectSimMcpClient(pluginLogger);
        }
        if (!simMcpClient) {
          const reason = simMcpConfig?.sseUrl
            ? `sim MCP unavailable: ${simMcpUnavailableReason}`
            : 'sim MCP not configured';
          pluginLogger?.debug(`[Planner:Sim] ${name} unavailable`, {
            invocationId,
            sessionId,
            hisimTool: hisimToolName,
            durationMs: Date.now() - startedAt,
            reason,
          });
          return {
            output: JSON.stringify({
              error: simMcpConfig?.sseUrl
                ? `Sim MCP unavailable: ${simMcpUnavailableReason}`
                : 'Sim MCP not configured. Set simMcp.sseUrl in plugin config.',
            }),
          };
        }
        try {
          const adaptedParams = adaptSimToolParams(name, params);
          const result = await simMcpClient.callTool(hisimToolName, adaptedParams);
          pluginLogger?.debug(`[Planner:Sim] ${name} completed`, {
            invocationId,
            sessionId,
            hisimTool: hisimToolName,
            durationMs: Date.now() - startedAt,
            result: summarizeSimResult(result),
          });
          return { output: JSON.stringify(result) };
        } catch (err) {
          pluginLogger?.debug(`[Planner:Sim] ${name} failed`, {
            invocationId,
            sessionId,
            hisimTool: hisimToolName,
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            output: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
      },
    });
  }

  const simRegisterHardwareTool = simTool(
    'pimclaw_sim_register_hardware',
    'register_hardware',
    'Register a hardware accelerator with performance specs for simulation.',
    {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Hardware name (e.g. "NVIDIA H800")' },
        vendor: { type: 'string', description: 'Hardware vendor (e.g. "NVIDIA")' },
        hbm_capacity_gb: { type: 'number', description: 'HBM capacity in GB' },
        hbm_bandwidth_gb: { type: 'number', description: 'HBM bandwidth in GB/s' },
        fp16_tflops: { type: 'number', description: 'FP16 TFLOPS' },
        fp32_tflops: { type: 'number', description: 'FP32 TFLOPS' },
        fp64_tflops: { type: 'number', description: 'FP64 TFLOPS' },
        int8_tflops: { type: 'number', description: 'INT8 TFLOPS' },
        fp8_tflops: { type: 'number', description: 'FP8 TFLOPS' },
        bf16_tflops: { type: 'number', description: 'BF16 TFLOPS' },
        fp16_tensor_tflops: { type: 'number', description: 'FP16 Tensor Core TFLOPS' },
        fp32_tensor_tflops: { type: 'number', description: 'FP32 Tensor Core TFLOPS' },
        fp8_tensor_tflops: { type: 'number', description: 'FP8 Tensor Core TFLOPS' },
        int8_tensor_tflops: { type: 'number', description: 'INT8 Tensor Core TFLOPS' },
        bf16_tensor_tflops: { type: 'number', description: 'BF16 Tensor Core TFLOPS' },
        num_devices: { type: 'number', description: 'Number of devices' },
        device_alias: { type: 'array', items: { type: 'string' }, description: 'Device aliases' },
        inter_node_bandwidth_gb: { type: 'number', description: 'Inter-node bandwidth in GB/s' },
        intra_node_bandwidth_gb: { type: 'number', description: 'Intra-node bandwidth in GB/s' },
        ref: { type: 'string', description: 'Reference URL or source for hardware specs' },
      },
      required: [
        'name',
        'vendor',
        'hbm_capacity_gb',
        'hbm_bandwidth_gb',
        'fp64_tflops',
        'fp32_tflops',
        'fp16_tflops',
        'int8_tflops',
      ],
    },
  );

  const simListHardwareTool = simTool(
    'pimclaw_sim_list_hardware',
    'list_all_hardware',
    'List all registered hardware accelerators available for simulation.',
    { type: 'object' as const, properties: {} },
  );

  const simStartTool = simTool(
    'pimclaw_sim_start',
    'start_simulation_server',
    'Start SGLang simulation server. Supply only model_path and hardware_name; use the anomaly hardwareName from pimclaw_query_metrics when present, otherwise use "NVIDIA H800_SXM".',
    {
      type: 'object' as const,
      properties: {
        model_path: { type: 'string', description: 'Model path. Use the exact LLM deployment name from the anomaly, for example "glm-5.1-fp8".' },
        hardware_name: { type: 'string', description: 'Registered HiSim hardware name. Use the normalized hardwareName from pimclaw_query_metrics when present, otherwise use "NVIDIA H800_SXM".' },
      },
      required: ['model_path', 'hardware_name'],
    },
  );

  const simStopTool = simTool(
    'pimclaw_sim_stop',
    'stop_simulation_server',
    'Stop the running simulation server.',
    { type: 'object' as const, properties: {} },
  );

  const simStatusTool = simTool(
    'pimclaw_sim_status',
    'get_simulation_server_status',
    'Get the current simulation server status (running, PID, port, model).',
    { type: 'object' as const, properties: {} },
  );

  const simBenchmarkTool = simTool(
    'pimclaw_sim_benchmark',
    'run_bench_serving',
    'Run benchmark serving against the simulation server. Schema mirrors HiSim run_bench_serving: required backend, base_url, model, dataset_name, warmup_requests, plus optional extra_request_body.',
    {
      type: 'object' as const,
      properties: {
        backend: { type: 'string', description: 'Backend type, usually "sglang".' },
        base_url: { type: 'string', description: 'Simulation server base URL, usually "http://127.0.0.1:8723".' },
        model: { type: 'string', description: 'Model name or path. Should match the simulation server model_path.' },
        dataset_name: { type: 'string', description: 'Dataset type: random, sharegpt, hisim-collection.' },
        warmup_requests: { type: 'number', description: 'Number of warmup requests. Use 0 to skip warmup.' },
        extra_request_body: {
          type: 'object',
          description:
            'Additional benchmark parameters, e.g. num_prompts, dataset_path, random_input_len, random_output_len, random_range_ratio, request_rate, max_concurrency, output_file, output_details.',
        },
      },
      required: ['backend', 'base_url', 'model', 'dataset_name', 'warmup_requests'],
    },
  );

  const simDatasetInfoTool = simTool(
    'pimclaw_sim_dataset_info',
    'get_bench_serving_dataset_info',
    'Preview dataset information (token counts, prompt lengths) without running a benchmark.',
    {
      type: 'object' as const,
      properties: {
        dataset_name: { type: 'string', description: 'Dataset type: random, sharegpt, hisim-collection.' },
        model: { type: 'string', description: 'Model name or path for tokenizer.' },
        extra_request_body: {
          type: 'object',
          description:
            'Additional dataset preview parameters, e.g. num_prompts, dataset_path, random_input_len, random_output_len, random_range_ratio, seed.',
        },
      },
      required: ['dataset_name', 'model'],
    },
  );

  return [
    submitAnomaliesTool,
    submitTaskFeedbackTool,
    planTaskTool,
    routeTaskTool,
    queryMetricsTool,
    queryPerfllmTool,
    getPerfllmSchemaTool,
    simRegisterHardwareTool,
    simListHardwareTool,
    simStartTool,
    simStopTool,
    simStatusTool,
    simBenchmarkTool,
    simDatasetInfoTool,
    listComponentsTool,
    componentStatusTool,
    healthTool,
    taskCountsTool,
    listTasksTool,
    retryTaskTool,
    revokeTaskTool,
  ];
}

// ─── Plugin entry ──────────────────────────────────────────────────────────

export default definePluginEntry({
  id: 'pimclaw',
  name: 'PimClaw',
  description:
    'LLM deployment orchestration — monitors metrics via LLM Head Agent, plans configs via LLM Planner Agent, and executes changes via programmatic Scheduler/Workers.',

  register(api: OpenClawPluginApi) {
    pluginConfig = (api.pluginConfig as Record<string, unknown> | undefined) ?? {};
    pluginRuntime = api.runtime;
    api.registerService(getPimClawService());

    for (const toolFactory of buildPimClawTools()) {
      const toolName = toolFactory().name;
      // Wrap each tool factory with hook governance
      const wrappedFactory = (toolContext?: unknown) => {
        const context = toolContext && typeof toolContext === 'object'
          ? toolContext as OpenClawToolContext
          : undefined;
        const tool = toolFactory();
        return withLazyServiceStart(withHooks(tool as ToolDefinition, toolHooks), api, context);
      };
      api.registerTool(wrappedFactory, { name: toolName });
    }

    api.logger.info('[PimClaw] Plugin registered (v2 hybrid architecture)');
  },
});

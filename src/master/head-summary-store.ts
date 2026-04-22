import fs from 'fs/promises';
import path from 'path';

export type SummaryMetricName =
  | 'ttft'
  | 'tpot'
  | 'qps'
  | 'throughput'
  | 'gpu_utilization'
  | 'error_rate';

export interface HeadMonitoringMetricRow {
  metric: SummaryMetricName;
  currentValue: number | null;
  priorValue: number | null;
}

export interface HeadMonitoringAnomalyRow {
  anomalyIdOrName: string;
  metric: string;
  severity: 'high' | 'medium' | 'low';
  observation: string;
}

export type HeadTaskFeedbackReviewState =
  | 'applied'
  | 'too-early'
  | 'expired-for-review'
  | 'already-reviewed'
  | 'rejected';

export interface HeadTaskFeedbackRow {
  taskId: string;
  deploymentName: string;
  taskType: string;
  reviewState: HeadTaskFeedbackReviewState;
  outcome: 'helped' | 'no-effect' | 'worsened' | 'unknown' | null;
  keyMetrics: string;
  observation: string;
}

export interface HeadMonitoringDeploymentSummary {
  deploymentName: string;
  engine: string;
  metricTable: HeadMonitoringMetricRow[];
  anomalyTable: HeadMonitoringAnomalyRow[];
}

export interface HeadMonitoringSummaryRecord {
  ts: number;
  runId: string;
  sessionId: string;
  deployments: HeadMonitoringDeploymentSummary[];
  taskFeedbackTable: HeadTaskFeedbackRow[];
}

export class HeadSummaryStore {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private records: HeadMonitoringSummaryRecord[] = [];
  private dirty = false;

  constructor(workspaceDir: string, maxRecords: number = 10) {
    this.maxRecords = maxRecords;
    this.filePath = path.join(workspaceDir, 'head-monitoring-summaries.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.records = data.slice(-this.maxRecords);
      }
    } catch {
      this.records = [];
    }
  }

  upsert(record: HeadMonitoringSummaryRecord): void {
    const index = this.records.findIndex((item) => item.runId === record.runId);
    if (index >= 0) {
      this.records[index] = record;
    } else {
      this.records.push(record);
    }

    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.dirty = true;
  }

  getByRunId(runId: string): HeadMonitoringSummaryRecord | null {
    const found = this.records.find((record) => record.runId === runId);
    return found ? structuredClone(found) : null;
  }

  findPreviousMetricValue(
    deploymentName: string,
    engine: string,
    metric: SummaryMetricName,
    excludeRunId?: string,
  ): number | null {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (excludeRunId && record.runId === excludeRunId) {
        continue;
      }

      const deployment = record.deployments.find(
        (item) => item.deploymentName === deploymentName && item.engine === engine,
      );
      if (!deployment) {
        continue;
      }

      const metricRow = deployment.metricTable.find((row) => row.metric === metric);
      if (metricRow) {
        return metricRow.currentValue;
      }
    }

    return null;
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.records, null, 2), 'utf-8');
    await fs.rename(tempPath, this.filePath);
    this.dirty = false;
  }

  get size(): number {
    return this.records.length;
  }
}
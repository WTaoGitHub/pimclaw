/**
 * MetricsStore — ring-buffer for pimclaw_query_metrics results.
 * Persists up to maxRecords snapshots as a JSON file in stateDir.
 */

import fs from 'fs/promises';
import path from 'path';

export interface DeploymentMetrics {
  /** model_name label from Prometheus */
  deployments: string;
  /** Inference engine (vllm or sglang) */
  engine: string;
  /** Normalized runtime hardware name, for example H800 */
  hardwareName?: string;
  /** Raw GPU model label from Prometheus, for example NVIDIA H800 */
  gpuType?: string;
  ttft: number;
  tpot: number;
  qps: number;
  throughput: number;
  gpu_utilization: number;
  error_rate: number;
}

export interface MetricsRecord {
  /** Unix epoch milliseconds */
  ts: number;
  /** Per-deployment metric snapshots */
  metrics: DeploymentMetrics[];
}

export class MetricsStore {
  private records: MetricsRecord[] = [];
  private readonly maxRecords: number;
  private readonly filePath: string;
  private dirty = false;

  constructor(stateDir: string, maxRecords: number = 1000) {
    this.maxRecords = maxRecords;
    this.filePath = path.join(stateDir, 'metrics-history.json');
  }

  /** Load existing history from disk. Safe to call if file doesn't exist. */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.records = data.slice(-this.maxRecords);
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
      this.records = [];
    }
  }

  /** Add a record. Evicts oldest if at capacity. */
  add(record: MetricsRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.dirty = true;
  }

  /** Flush to disk if dirty. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.records), 'utf-8');
    this.dirty = false;
  }

  /** Get the last N records (default: all). */
  getLast(n?: number): MetricsRecord[] {
    if (n === undefined) return [...this.records];
    return this.records.slice(-n);
  }

  /** Current record count. */
  get size(): number {
    return this.records.length;
  }
}

/**
 * Extract scalar metric values from a pimclaw_query_metrics result.
 * Handles both instant results (single value) and range results
 * (takes the last data point).
 */
export function extractMetricValue(result: unknown): number | null {
  if (result == null) return null;
  if (typeof result === 'object' && 'error' in (result as any)) return null;

  // Instant: [{ metric: {}, value: [timestamp, "0.123"] }]
  // Range:   [{ metric: {}, values: [[ts, "v"], ...] }]
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];
    if (first.value) {
      return parseFloat(first.value[1]);
    }
    if (first.values && first.values.length > 0) {
      const last = first.values[first.values.length - 1];
      return parseFloat(last[1]);
    }
  }
  return null;
}

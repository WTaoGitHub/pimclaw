/**
 * Prometheus HTTP client for PimClaw plugin.
 * Wraps /api/v1/query and /api/v1/query_range with type-safe parsing.
 * Uses native fetch() (Node 22+).
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PrometheusResponse {
  status: 'success' | 'error';
  data: {
    resultType: string;
    result: PrometheusResult[];
  };
  errorType?: string;
  error?: string;
}

export interface PrometheusResult {
  metric: Record<string, string>;
  value?: [number | string, string];   // instant query
  values?: [number | string, string][]; // range query
}

export type PrometheusQueryMap = Record<string, string>;

export interface PrometheusClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Basic-auth username */
  username?: string;
  /** Basic-auth password */
  password?: string;
  /** Bearer token (takes precedence over basic auth) */
  bearerToken?: string;
}

// ─── Client ────────────────────────────────────────────────────────────────

export class PrometheusClient {
  private baseUrl: string;
  private timeoutMs: number;
  private headers: Record<string, string>;

  constructor(opts: PrometheusClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;

    this.headers = {};
    if (opts.bearerToken) {
      this.headers['Authorization'] = `Bearer ${opts.bearerToken}`;
    } else if (opts.username && opts.password) {
      const creds = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this.headers['Authorization'] = `Basic ${creds}`;
    }
  }

  async query(promql: string): Promise<PrometheusResult[]> {
    const url = new URL(`${this.baseUrl}/api/v1/query`);
    url.searchParams.set('query', promql);
    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json: PrometheusResponse = await res.json() as PrometheusResponse;
    if (json.status !== 'success') {
      throw new Error(json.error ?? 'Prometheus query failed');
    }
    return json.data.result;
  }

  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number,
  ): Promise<PrometheusResult[]> {
    const url = new URL(`${this.baseUrl}/api/v1/query_range`);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', start.toString());
    url.searchParams.set('end', end.toString());
    url.searchParams.set('step', step.toString());
    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json: PrometheusResponse = await res.json() as PrometheusResponse;
    if (json.status !== 'success') {
      throw new Error(json.error ?? 'Prometheus range query failed');
    }
    return json.data.result;
  }
}

// ─── vLLM PromQL query map ────────────────────────────────────────────────

/**
 * Default PromQL queries mapping PimClaw metric names → vLLM Prometheus metrics.
 * P95 quantiles for latency, 5-minute rate windows matching Head agent cron.
 */
export const vllmPromQLMap: PrometheusQueryMap = {
  ttft: 'histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket[5m]))',
  tpot: 'histogram_quantile(0.95, rate(vllm:request_time_per_output_token_seconds_bucket[5m]))',
  qps: 'sum(rate(vllm:request_success_total[5m]))',
  throughput: 'sum(rate(vllm:generation_tokens_total[5m]))',
  gpu_utilization: 'vllm:kv_cache_usage_perc',
  error_rate:
    'sum(rate(vllm:request_success_total{finished_reason="error"}[5m])) / sum(rate(vllm:request_success_total[5m])) * 100',
};

/**
 * Default PromQL queries mapping PimClaw metric names → SGLang Prometheus metrics.
 * SGLang uses `sglang:` prefix and exposes inter_token_latency instead of TPOT.
 */
export const sglangPromQLMap: PrometheusQueryMap = {
  ttft: 'histogram_quantile(0.95, rate(sglang:time_to_first_token_seconds_bucket[5m]))',
  tpot: 'histogram_quantile(0.95, rate(sglang:inter_token_latency_seconds_bucket[5m]))',
  qps: 'sum(rate(sglang:num_requests_total[5m]))',
  throughput: 'sum(rate(sglang:generation_tokens_total[5m]))',
  gpu_utilization: 'sglang:token_usage',
  error_rate:
    'sum(rate(sglang:num_aborted_requests_total[5m])) / sum(rate(sglang:num_requests_total[5m])) * 100',
};

/** Supported inference engine types for PromQL map selection. */
export type InferenceEngine = 'vllm' | 'sglang';

/** Get the PromQL map for the given inference engine. */
export function getPromQLMap(engine: InferenceEngine): PrometheusQueryMap {
  switch (engine) {
    case 'sglang':
      return sglangPromQLMap;
    case 'vllm':
    default:
      return vllmPromQLMap;
  }
}

/**
 * Inject extra label matchers into a PromQL expression.
 * Handles metrics that already have `{…}` selectors and those that don't.
 *
 * Example:
 *   injectLabels('rate(vllm:x_total[5m])', { model_name: 'llama' })
 *   → 'rate(vllm:x_total{model_name="llama"}[5m])'
 */
export function injectLabels(
  promql: string,
  labels: Record<string, string>,
): string {
  if (Object.keys(labels).length === 0) return promql;

  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');

  // If there's already a `{…}` selector, append inside it
  if (promql.includes('{')) {
    return promql.replace(/\{/, `{${labelStr},`);
  }

  // Otherwise insert `{labels}` before the first `[` or at the first metric boundary
  // Match pattern: metric_name followed by [ or ) or end
  return promql.replace(
    /([a-zA-Z_:][a-zA-Z0-9_:]*)(\[|$)/,
    (_, metric, rest) => `${metric}{${labelStr}}${rest}`,
  );
}

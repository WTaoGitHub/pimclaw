/**
 * Performance data types matching the perfllm CSV schema.
 * These types mirror what the external "perf" MCP service provides.
 */

export type ModelPerformance = {
  id: number;
  model_name: string;
  engine_name: string;
  device_type: string;
  node_num: number;
  device_per_node: number;
  scenario: string;
  dtype: string;
  quantization: string | null;
  gpu_memory_utilization: number;
  data_parallel_size: number | null;
  pipeline_parallel_size: number | null;
  tensor_parallel_size: number | null;
  enable_expert_parallel: boolean | null;
  enable_chunked_prefill: boolean | null;
  ttft: number;        // Time to first token (ms) — lower is better
  tpot: number;        // Time per output token (ms) — lower is better
  qps: number;         // Queries per second — higher is better
  throughput: number;   // Tokens per second — higher is better
  command: string;
  max_model_len: number;
  concurrency_when_max_len: number | null;
  max_num_seqs: number | null;
  container_image: string;
  task_id: string | null;
  cpu: number;
  memory: number;
};

export type PerformanceComparison = {
  model_name: string;
  configs: Array<{
    config_id: number;
    device_type: string;
    scenario: string;
    parallelism: {
      tensor: number | null;
      pipeline: number | null;
      data: number | null;
    };
    metrics: {
      ttft: number;
      tpot: number;
      qps: number;
      throughput: number;
    };
  }>;
  recommendation: string | null;
};

export type DeploymentRecommendation = {
  model_name: string;
  device_type: string;
  scenario: string;
  recommended_config: Partial<ModelPerformance>;
  reasoning: string;
  expected_metrics: {
    ttft: number;
    tpot: number;
    qps: number;
    throughput: number;
  };
};

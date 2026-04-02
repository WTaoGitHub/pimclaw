/**
 * LLM model and deployment data types for PimClaw
 */

/**
 * Performance benchmark data for an LLM configuration
 */
export interface PerformanceBenchmark {
  id: string;
  modelName: string; // e.g., "Qwen/Qwen3-32B"
  engineName: string; // e.g., "vllm"
  deviceType: string; // e.g., "nvidia/h800", "ascend/910b4"
  nodeNum: number;
  devicePerNode: number;
  scenario: string; // e.g., "chat", "summary"
  dtype: string; // e.g., "bfloat16"
  quantization?: string;
  gpuMemoryUtilization: number;
  dataPrallerlSize?: number;
  pipelineParallelSize?: number;
  tensorParallelSize?: number;
  enableExpertParallel?: boolean;
  enableChunkedPrefill?: boolean;
  ttft: number; // ms
  tpot: number; // ms
  qps: number;
  throughput: number; // tokens/sec
  command: string;
  maxModelLen: number;
  concurrencyWhenMaxLen?: number;
  maxNumSeqs?: number;
  containerImage: string;
  cpu: number;
  memory: number; // GiB
  taskId?: string;
}

/**
 * Current deployment configuration for an LLM
 */
export interface Deployment {
  deploymentId: string;
  modelName: string;
  currentBenchmarkId: string; // reference to PerformanceBenchmark
  currentBenchmark: PerformanceBenchmark;
  kubernetesNamespace: string;
  kubeernetesPodName: string;
  replicaCount: number;
}

/**
 * Metric interpretation rules for decision-making
 */
export interface MetricRule {
  metricName: 'ttft' | 'tpot' | 'qps' | 'throughput' | 'gpu_utilization';
  direction: 'higher_is_better' | 'lower_is_better' | 'target_range';
  targetMin?: number;
  targetMax?: number;
  interactivePriority: 'HIGH' | 'Medium' | 'Low';
  batchPriority: 'HIGH' | 'Medium' | 'Low';
  spikeThreshold: number; // percentage increase to trigger anomaly
  dropThreshold: number; // percentage decrease to trigger anomaly
}

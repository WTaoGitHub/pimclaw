# Hisim MCP Server Skill

## Description

Manages Hisim MCP server for SGLang simulation service control and benchmark serving.

## Usage

Start the MCP server:
```bash
python -m hisim.api.mcp.server
```

## Simulation Workflow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Hisim Simulation Workflow                            │
└─────────────────────────────────────────────────────────────────────────────┘

    ┌──────────────────┐     ┌─────────────────────────┐
    │  Start Sim       │────▶│   Run Bench Serving    │
    │  Server          │     │   (Optional)           │
    └──────────────────┘     └─────────────────────────┘
           │                          │
           ▼                          ▼
    ┌──────────────────┐     ┌─────────────────────────┐
    │ Launch SGLang    │     │ Test Inference         │
    │ with Sim Config  │     │ Performance            │
    └──────────────────┘     └─────────────────────────┘

Step 1: Start simulation server with model + hardware + database
        ↓
Step 2: Run benchmark serving to test performance
        ↓
Step 3: Analyze results (throughput, latency, etc.)
```

## MCP Tools

### Simulation Service Management

#### `start_simulation_server`

Start SGLang simulation service with hardware-aware configuration.

```python
start_simulation_server(
    model_path="/models/Qwen2-7B-Instruct",
    hardware_name = "NVIDIA H800_SXM",
    port=8723,
    skip_warmup=False,
    tp_size=1,
    database_mode="SILICON",
    prefill_scale_factor=1.0,
    decode_scale_factor=1.0,
)
```

**Required Arguments:**
- `model_path`: SGLang server model path
- `hardware_name`: Simulation hardware name (must be available in the performance database)

**Optional Arguments:**
- `database_path`: Hardware performance database path (env variable `HISIM_PREDICTOR_DATABASE_PATH`)
- `config_path`: Path to existing simulation config JSON (optional, generated automatically from arguments if not specified)
- `skip_warmup`: Skip server warmup (default: False)
- `port`: SGLang service port (default: 8723)
- `host`: Service host address (default: "0.0.0.0")
- `model_name`: Aiconfigurator simulation model name (optional, derived from model_path if not specified)
- `device_name`: Device name in performance database (optional, derived from hardware_name if not specified)
- `database_mode`: Database mode: SILICON, HYBRID, EMPIRICAL (default: SILICON). Use HYBRID if model data is unavailable in SILICON mode.
- `prefill_scale_factor`: Prefill latency scale factor (default: 1.0)
- `decode_scale_factor`: Decode latency scale factor (default: 1.0)
- `xgb_model_path`: XGBoost model path (optional)
- `tp_size`: Tensor parallelism size (default: 1)
- `ep_size`: Expert parallelism size (default: 1)
- `dp_size`: Data parallelism size (default: 1)
- `data_type`: Data type: FP16, FP32, BF16, FP8, INT8 (default: FP16)
- `kv_cache_data_type`: KV cache data type (default: FP16)
- `backend_name`: Backend name (default: "sglang")
- `backend_version`: Backend version (default: "0.5.9")
- `disk_read_bandwidth_gb`: Disk read bandwidth in GB/s (default: 8.0)
- `disk_write_bandwidth_gb`: Disk write bandwidth in GB/s (default: 8.0)
- `memory_read_bandwidth_gb`: Memory read bandwidth in GB/s (default: 16.0)
- `memory_write_bandwidth_gb`: Memory write bandwidth in GB/s (default: 16.0)
- `num_device_per_node`: Number of devices per node (default: 8)
- `auto_register_model`: Auto-register model from ModelScope/HuggingFace if not found (default: True)
- `output_path`: Output generated simulation config file path (optional, default: /tmp/hisim/config.json)

#### `stop_simulation_server`

Stop the simulation service.

```python
stop_simulation_server()
```

#### `restart_simulation_server`

Restart the simulation service using previous parameters.

```python
restart_simulation_server()
```

#### `get_simulation_server_status`

Get current service status.

```python
get_simulation_server_status()
```

Returns:
```json
{
    "service_name": "sglang",
    "is_running": true,
    "pid": 12345,
    "config_path": "/tmp/hisim/config.json",
    "host": "0.0.0.0",
    "port": 8723,
    "model_path": "/models/Qwen2-7B"
}
```

#### `is_simulation_server_running`

Check if service is running.

```python
is_simulation_server_running()
```

### Benchmark Serving

#### `run_bench_serving`

Run benchmark serving to test inference performance. Requires simulation server to be running.

**Tool Signature:**
```python
run_bench_serving(
    backend: str,                    # Backend type (required)
    base_url: str,                   # Server base URL (required)
    model: str,                      # Model name or path (required)
    dataset_name: str,               # Dataset type (required)
    warmup_requests: int,            # Warmup request count (required)
    extra_request_body: dict = None, # Additional benchmark params (optional)
)
```

**Dataset Types:**
- `random`: Random token dataset (use `extra_request_body` for `random_input_len`, `random_output_len`)
- `sharegpt`: ShareGPT dataset (requires `dataset_path` in `extra_request_body`)
- `hisim-collection`: HiSim collection dataset (requires `dataset_path` in `extra_request_body`)

**Examples:**
```python
# Example 1: Random dataset with default parameters
run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
    warmup_requests=0,
)

# Example 2: Random dataset with custom parameters
run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
    warmup_requests=0,
    extra_request_body={
        "num_prompts": 100,
        "random_input_len": 512,
        "random_output_len": 512,
        "random_range_ratio": 0.5,
        "request_rate": 10.0,
    },
)

# Example 3: ShareGPT dataset
run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="sharegpt",
    warmup_requests=0,
    extra_request_body={
        "dataset_path": "ShareGPT_V3_unfiltered_cleaned_split.json",
        "num_prompts": 100,
    },
)

# Example 4: With output file and details
run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
    warmup_requests=0,
    extra_request_body={
        "num_prompts": 100,
        "output_file": "/path/to/results.jsonl",
        "output_details": True,
    },
)
```

**Arguments:**
- `backend`: Backend type (sglang, vllm, lmdeploy, etc.) - required
- `base_url`: Base URL of the server - required (e.g., `"http://127.0.0.1:8723"`)
- `model`: Model name or path, should match the model used in simulation server - required
- `dataset_name`: Dataset type (random, sharegpt, hisim-collection) - required
- `warmup_requests`: Number of warmup requests (0 = skip warmup) - required
- `extra_request_body`: Additional benchmark parameters as a JSON object (optional). Supports all
  bench_serving CLI arguments. Commonly used keys:
  - `num_prompts` (int, default=1000): Number of prompts
  - `dataset_path` (str): Dataset file path (required for sharegpt/hisim-collection)
  - `random_input_len` (int, default=1024): Input tokens per request (random dataset)
  - `random_output_len` (int, default=1024): Output tokens per request (random dataset)
  - `random_range_ratio` (float, default=0.0): Length variation ratio (random dataset)
  - `request_rate` (float, default=inf): Requests per second (inf = send all at once)
  - `max_concurrency` (int): Maximum concurrent requests
  - `seed` (int, default=1): Random seed
  - `disable_tqdm` (bool, default=False): Disable progress bar
  - `output_file` (str): Output file path for results
  - `output_details` (bool, default=False): Include detailed per-request results

**Returns:**
```json
{
    "status": "success",
    "bench_mode": "normal",
    "backend": "sglang",
    "request_rate": 10.0,
    "max_concurrency": null,
    "successful_requests": 50,
    "benchmark_duration_s": 20.36,
    "total_input_tokens": 51513,
    "total_input_text_tokens": 51513,
    "total_input_vision_tokens": -1,
    "total_generated_tokens": 51200,
    "total_generated_tokens_retokenized": -1,
    "request_throughput": 2.46,
    "input_throughput": 2530.02,
    "output_throughput": 2514.64,
    "peak_output_throughput": 2514.64,
    "peak_concurrent_requests": 8,
    "total_throughput": 5044.66,
    "concurrency": -1.0,
    "mean_e2e_latency_ms": 9509.61,
    "median_e2e_latency_ms": 9400.0,
    "std_e2e_latency_ms": 500.0,
    "p99_e2e_latency_ms": 10200.0,
    "mean_ttft_ms": 10.97,
    "median_ttft_ms": 10.5,
    "p99_ttft_ms": 15.0,
    "mean_tpot_ms": 9.29,
    "median_tpot_ms": 9.1,
    "p99_tpot_ms": 12.0,
    "mean_itl_ms": 9.29,
    "median_itl_ms": 9.1,
    "p95_itl_ms": 10.0,
    "p99_itl_ms": 12.0,
    "max_itl_ms": 15.0,
    "details": null
}
```

#### `get_bench_serving_dataset_info`

Preview dataset information without running benchmark.

```python
# Example 1: Preview random dataset
get_bench_serving_dataset_info(
    dataset_name="random",
    model="Qwen/Qwen2.5-7B-Instruct",
    extra_request_body={
        "num_prompts": 10,
        "random_input_len": 512,
        "random_output_len": 256,
    },
)

# Example 2: Preview hisim-collection dataset
get_bench_serving_dataset_info(
    dataset_name="hisim-collection",
    model="Qwen/Qwen2.5-7B-Instruct",
    extra_request_body={
        "dataset_path": "/path/to/collection.jsonl",
        "num_prompts": 10,
    },
)
```

**Arguments:**
- `dataset_name`: Dataset type (random, sharegpt, hisim-collection) - default: "random"
- `model`: Model name or path for tokenizer
- `extra_request_body`: Additional parameters as a JSON object (optional). Commonly used keys:
  - `num_prompts` (int): Number of prompts to preview
  - `dataset_path` (str): Dataset file path (required for sharegpt/hisim-collection)
  - `random_input_len` (int, default=1024): Input tokens per request (random dataset)
  - `random_output_len` (int, default=1024): Output tokens per request (random dataset)
  - `random_range_ratio` (float, default=0.0): Length variation ratio (random dataset)
  - `seed` (int, default=1): Random seed

**Returns:**
```json
{
    "status": "success",
    "dataset_info": {
        "dataset_name": "hisim-collection",
        "num_prompts": 10,
        "total_input_tokens": 5120,
        "total_output_tokens": 2560,
        "avg_input_len": 512.0,
        "avg_output_len": 256.0,
        "sample_prompts": [
            {"prompt": "...", "prompt_len": 512, "output_len": 256}
        ]
    }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Hisim MCP Server                         │
│                    Port: 8721                                │
└─────────────────────────────────────────────────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    ▼                      ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────┐
│  Simulation     │  │  Service        │  │  Benchmark Serving  │
│  Config         │  │  Manager        │  │                     │
│  Generator      │  │                 │  │  (run_bench_serving) │
└─────────────────┘  └─────────────────┘  └──────────────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │  SGLang Server          │
              │  (Simulation Mode)       │
              │  Port: 8723              │
              └─────────────────────────┘
```

## Complete Workflow Examples

### Example 1: Full Simulation Benchmark

```python
# Step 1: Start simulation server
start_simulation_server(
    model_path="Qwen/Qwen2.5-7B-Instruct",
    hardware_name="NVIDIA H800_SXM",
    port=8723,
    database_mode="HYBRID",
)

# Step 2: Wait for server to be ready, then run benchmark
run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen3-8B",
    dataset_name="random",
    warmup_requests=0,
    extra_request_body={
        "num_prompts": 100,
        "random_input_len": 512,
        "random_output_len": 512,
    },
)

# Step 3: Check results in output file or returned JSON
```

### Example 2: Using hisim-collection Dataset

```python
# First, preview the dataset
get_bench_serving_dataset_info(
    dataset_name="hisim-collection",
    model="Qwen/Qwen3-8B",
    extra_request_body={
        "dataset_path": "/path/to/collection.jsonl",
        "num_prompts": 10,
    },
)

# Start server and run benchmark
start_simulation_server(
    model_path="Qwen/Qwen3-8B",
    hardware_name="NVIDIA H800_SXM",
    database_path="/path/to/hardware.db",
)

run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen3-8B",
    dataset_name="hisim-collection",
    warmup_requests=0,
    extra_request_body={
        "dataset_path": "/path/to/collection.jsonl",
        "request_rate": 2.0,
    },
)
```

### Example 3: Multi-GPU with XGBoost Model

```python
start_simulation_server(
    model_path="Qwen/Qwen3-32B-FP8",
    hardware_name="NVIDIA H800_SXM",
    database_path="/path/to/hardware.db",
    xgb_model_path="/path/to/xgb_models/qwen3_32b",
    tp_size=4,
    ep_size=1,
    dp_size=2,
    num_device_per_node=8,
    prefill_scale_factor=1.045,
    decode_scale_factor=1.0,
)

run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8723",
    model="Qwen/Qwen3-32B-FP8",
    dataset_name="random",
    warmup_requests=0,
    extra_request_body={
        "num_prompts": 50,
        "random_input_len": 1024,
        "random_output_len": 1024,
    },
)
```

## Key Metrics Explained

| Metric | Description |
|--------|-------------|
| `request_throughput` | Requests per second |
| `input_throughput` | Input tokens per second |
| `output_throughput` | Output tokens per second |
| `total_throughput` | Total (input + output) tokens per second |
| `mean_e2e_latency_ms` | Mean End-to-End Latency (ms) |
| `median_e2e_latency_ms` | Median End-to-End Latency (ms) |
| `p99_e2e_latency_ms` | P99 End-to-End Latency (ms) |
| `mean_ttft_ms` | Mean Time To First Token (ms) |
| `median_ttft_ms` | Median Time To First Token (ms) |
| `p99_ttft_ms` | P99 Time To First Token (ms) |
| `mean_tpot_ms` | Mean Time Per Output Token (ms) |
| `median_tpot_ms` | Median Time Per Output Token (ms) |
| `p99_tpot_ms` | P99 Time Per Output Token (ms) |
| `mean_itl_ms` | Mean Inter-Token Latency (ms) |
| `median_itl_ms` | Median Inter-Token Latency (ms) |
| `p95_itl_ms` | P95 Inter-Token Latency (ms) |
| `p99_itl_ms` | P99 Inter-Token Latency (ms) |
| `max_itl_ms` | Maximum Inter-Token Latency (ms) |
| `peak_output_throughput` | Peak output token throughput (tok/s) |
| `peak_concurrent_requests` | Maximum concurrent requests observed |
| `concurrency` | Average concurrency level |

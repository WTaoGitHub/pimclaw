# Hisim MCP Server Skill

## Description

Manages Hisim MCP server for hardware registration, SGLang simulation service control, and benchmark serving.

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

    ┌──────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
    │   Register   │────▶│  Start Sim       │────▶│   Run Bench Serving    │
    │   Hardware   │     │  Server          │     │   (Optional)           │
    └──────────────┘     └──────────────────┘     └─────────────────────────┘
           │                     │                          │
           ▼                     ▼                          ▼
    ┌──────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
    │ Validate HW  │     │ Launch SGLang    │     │ Test Inference         │
    │ Specs        │     │ with Sim Config  │     │ Performance            │
    └──────────────┘     └──────────────────┘     └─────────────────────────┘

Step 1: Register hardware (if not already registered)
        ↓
Step 2: Start simulation server with model + hardware + database
        ↓
Step 3: Run benchmark serving to test performance
        ↓
Step 4: Analyze results (throughput, latency, etc.)
```

## MCP Tools

### Hardware Management

#### `register_hardware`

Register a hardware accelerator with performance specifications.

```python
register_hardware(
    name="NVIDIA H800",
    vendor="NVIDIA",
    hbm_capacity_gb=80,
    hbm_bandwidth_gb=3350,
    fp64_tflops=1,
    fp32_tflops=67,
    fp16_tflops=335,
    int8_tflops=335,
    num_devices=8,
    fp8_tflops=989,
    bf16_tflops=335,
    device_alias=["H800", "h800"],
    inter_node_bandwidth_gb=64,
    intra_node_bandwidth_gb=400,
)
```

#### `get_hardware`

Get hardware info by name.

```python
get_hardware(name="NVIDIA H800")
```

#### `list_all_hardware`

List all registered hardware accelerators.

```python
list_all_hardware()
```

#### `register_hardware_batch`

Batch register multiple hardware accelerators.

```python
register_hardware_batch(specs=[
    {"name": "H800", "vendor": "NVIDIA", ...},
    {"Name": "H100", "vendor": "NVIDIA", ...},
])
```

### Simulation Service Management

#### `start_simulation_server`

Start SGLang simulation service with hardware-aware configuration.

```python
start_simulation_server(
    model_path="/models/Qwen2-7B-Instruct",
    hardware_name="NVIDIA H800",
    database_path="/path/to/database.db",
    port=8001,
    skip_warmup=True,
    tp_size=1,
    database_mode="SILICON",
    prefill_scale_factor=1.0,
    decode_scale_factor=1.0,
    xgb_model_path="/path/to/xgb_model",
    # ... any other SGLang server arguments
)
```

**Required Arguments:**
- `model_path`: SGLang server model path
- `hardware_name`: Simulation hardware name (must be registered)
- `database_path`: Hardware performance database path

**Optional Arguments:**
- `port`: SGLang service port (default: 8001)
- `skip_warmup`: Skip server warmup (default: True)
- `tp_size`: Tensor parallelism size (default: 1)
- `ep_size`: Expert parallelism size (default: 1)
- `dp_size`: Data parallelism size (default: 1)
- `data_type`: Data type - FP16, FP32, BF16, FP8, INT8 (default: FP16)
- `kv_cache_data_type`: KV cache data type (default: FP16)
- `prefill_scale_factor`: Prefill latency scale factor (default: 1.0)
- `decode_scale_factor`: Decode latency scale factor (default: 1.0)
- `database_mode`: SILICON or SIMULATION (default: SILICON)
- `device_name`: Device name in performance database (auto-derived from hardware_name)
- `model_name`: Model name (auto-derived from model_path)
- `xgb_model_path`: XGBoost model path for performance prediction
- Any other SGLang server arguments (passed directly to SGLang)

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
    "port": 8001,
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

**Dataset Types:**
- `random`: Random token dataset (requires `random_input_len`, `random_output_len`)
- `sharegpt`: ShareGPT dataset (requires `dataset_path`)
- `hisim-collection`: HiSim collection dataset (requires `dataset_path`)

```python
# Example 1: Random dataset with default parameters
run_bench_serving(
    backend="sglang",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
)

# Example 2: Random dataset with custom parameters
run_bench_serving(
    backend="sglang",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
    num_prompts=100,
    random_input_len=512,
    random_output_len=512,
    random_range_ratio=0.5,
    request_rate=10.0,
)

# Example 3: hisim-collection dataset
run_bench_serving(
    backend="sglang",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="hisim-collection",
    dataset_path="/path/to/collection.jsonl",
)

# Example 4: With output file and details
run_bench_serving(
    backend="sglang",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
    output_file="/path/to/results.jsonl",
    output_details=True,
)
```

**Arguments:**
- `model`: Model name or path, best as same as the model used in simulation server - required
- `dataset_name`: Dataset type (random, sharegpt, hisim-collection) - default: "random"
- `dataset_path`: Path to dataset file (for sharegpt/hisim-collection, random dataset is not required)
- `num_prompts`: Number of prompts (for random dataset)
- `random_input_len`: Input token length (for random dataset)
- `random_output_len`: Output token length (for random dataset)
- `random_range_ratio`: Range ratio for random dataset
- `request_rate`: Requests per second (inf = all at once) - default: inf
- `max_concurrency`: Maximum concurrent requests
- `backend`: Backend type (sglang, vllm, lmdeploy, etc.) - default: "sglang"
- `base_url`: Base URL of the server - default: "http://127.0.0.1:8001"
- `warmup_requests`: Number of warmup requests - default: 0
- `output_file`: Output file path for results - default: None
- `output_details`: Include detailed results - default: False

**Returns:**
```json
{
    "status": "success",
    "bench_mode": "normal",
    "backend": "sglang",
    "successful_requests": 50,
    "benchmark_duration_s": 20.36,
    "total_input_tokens": 51513,
    "total_generated_tokens": 51200,
    "request_throughput": 2.46,
    "input_throughput": 2530.02,
    "output_throughput": 2514.64,
    "mean_e2e_latency_ms": 9509.61,
    "mean_ttft_ms": 10.97,
    "mean_tpot_ms": 9.29,
    "mean_itl_ms": 9.29,
    "peak_output_throughput": 2514.64,
    "peak_concurrent_requests": 8,
}
```

#### `get_bench_serving_dataset_info`

Preview dataset information without running benchmark.

```python
get_bench_serving_dataset_info(
    dataset_name="hisim-collection",
    dataset_path="/path/to/collection.jsonl",
    model="Qwen/Qwen2.5-7B-Instruct",
    num_prompts=10,
)
```

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
│                    Port: 8000                                │
└─────────────────────────────────────────────────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    ▼                      ▼                      ▼
┌─────────────┐  ┌─────────────────┐  ┌──────────────────────┐
│  Hardware   │  │  Simulation     │  │  Benchmark Serving  │
│  Registry  │  │  Service        │  │                     │
│            │  │  Manager        │  │  (run_bench_serving) │
└─────────────┘  └─────────────────┘  └──────────────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │  SGLang Server          │
              │  (Simulation Mode)       │
              │  Port: 8001              │
              └─────────────────────────┘
```

## Complete Workflow Examples

### Example 1: Full Simulation Benchmark

```python
# Step 1: Register hardware (one-time)
register_hardware(
    name="NVIDIA H800",
    vendor="NVIDIA",
    hbm_capacity_gb=80,
    hbm_bandwidth_gb=3350,
    fp64_tflops=1,
    fp32_tflops=67,
    fp16_tflops=335,
    int8_tflops=335,
)

# Step 2: Start simulation server
start_simulation_server(
    model_path="Qwen/Qwen2.5-7B-Instruct",
    hardware_name="NVIDIA H800",
    database_path="/path/to/hardware.db",
    port=8001,
)

# Step 3: Wait for server to be ready, then run benchmark
run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8001",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="random",
    num_prompts=100,
    random_input_len=512,
    random_output_len=512,
)

# Step 4: Check results in output file or returned JSON
```

### Example 2: Using hisim-collection Dataset

```python
# First, preview the dataset
get_bench_serving_dataset_info(
    dataset_name="hisim-collection",
    dataset_path="/path/to/collection.jsonl",
    model="Qwen/Qwen2.5-7B-Instruct",
)

# Start server and run benchmark
start_simulation_server(
    model_path="Qwen/Qwen2.5-7B-Instruct",
    hardware_name="NVIDIA H800",
    database_path="/path/to/hardware.db",
)

run_bench_serving(
    backend="sglang",
    base_url="http://127.0.0.1:8001",
    model="Qwen/Qwen2.5-7B-Instruct",
    dataset_name="hisim-collection",
    dataset_path="/path/to/collection.jsonl",
    request_rate=2.0,
)
```

### Example 3: Multi-GPU with XGBoost Model

```python
register_hardware(
    name="NVIDIA H800",
    vendor="NVIDIA",
    hbm_capacity_gb=80,
    hbm_bandwidth_gb=3350,
    fp64_tflops=1,
    fp32_tflops=67,
    fp16_tflops=335,
    int8_tflops=335,
    num_devices=8,
)

start_simulation_server(
    model_path="Qwen/Qwen3-32B-FP8",
    hardware_name="NVIDIA H800",
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
    base_url="http://127.0.0.1:8001",
    model="Qwen/Qwen3-32B-FP8",
    dataset_name="random",
    num_prompts=50,
    random_input_len=1024,
    random_output_len=1024,
)
```

## Key Metrics Explained

| Metric | Description |
|--------|-------------|
| `request_throughput` | Requests per second |
| `input_throughput` | Input tokens per second |
| `output_throughput` | Output tokens per second |
| `mean_ttft_ms` | Mean Time To First Token (ms) |
| `mean_tpot_ms` | Mean Time Per Output Token (ms) |
| `mean_itl_ms` | Mean Inter-Token Latency (ms) |
| `mean_e2e_latency_ms` | Mean End-to-End Latency (ms) |
| `peak_output_throughput` | Peak output token throughput (tok/s) |
| `peak_concurrent_requests` | Maximum concurrent requests observed |

# MCP PostgreSQL perfllm Server

MCP 服务器，用于查询 `perfllm` 数据库表（LLM 性能测试数据）。

## 配置

在 `perfllm_mcp_server.py` 文件开头修改 `DB_CONFIG`，或通过环境变量覆盖：

```python
DB_CONFIG = {
    "host": "your-db-host",
    "port": 34567,
    "user": "your-db-user",
    "password": "your-db-password",
    "database": "your-db-name",
}
```

支持的环境变量：`PERF_DB_HOST`、`PERF_DB_PORT`、`PERF_DB_USER`、`PERF_DB_PASSWORD`、`PERF_DB_NAME`。

### Docker Desktop on macOS

如果数据库地址只能从宿主机访问，而不能从 Docker 容器直接访问，不要让容器直接连接远端 IP。这个仓库已经提供了宿主机桥接脚本：

```bash
python3 tmp/docker-port-bridge.py
```

这会在宿主机监听：

- `host.docker.internal:34567` → `10.1.112.239:34567`

此时在 OpenClaw / PimClaw 容器内，把 Perf MCP 子进程环境配置为：

```json
{
  "perfMcp": {
    "pythonPath": "python3.12",
    "serverScriptPath": "/path/to/perfllm_mcp_server.py",
    "env": {
      "PERF_DB_HOST": "host.docker.internal",
      "PERF_DB_PORT": "34567"
    }
  }
}
```

这样数据库链路会变成：容器 → `host.docker.internal:34567` → 宿主机桥接 → `10.1.112.239:34567`。

## 依赖

- Python 3.12+
- psycopg2-binary
- mcp (modelcontextprotocol)

安装依赖：

```bash
pip install psycopg2-binary "mcp>=1.0"
```

## 运行

### 直接运行

```bash
python3.12 perfllm_mcp_server.py
```

### Claude Code 中使用

在 `~/.claude/settings.json` 中添加：

```json
{
  "mcpServers": {
    "perfllm": {
      "command": "python3.12",
      "args": ["/path/to/perfllm_mcp_server.py"]
    }
  }
}
```

重启 Claude Code 后生效。

## 工具

### query_perfllm

查询 perfllm 表，支持过滤和分页。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model_name` | string | 否 | 按模型名精确匹配 |
| `scenario` | string | 否 | 按场景名精确匹配 |
| `engine_name` | string | 否 | 按推理引擎精确匹配（如 vllm） |
| `device_type` | string | 否 | 按硬件类型精确匹配（如 nvidia/h800） |
| `node_num` | integer | 否 | 按节点数精确匹配 |
| `device_per_node` | integer | 否 | 按每节点设备数精确匹配 |
| `limit` | integer | 否 | 返回行数，默认 10，最大 100 |

**示例：**

```json
{
  "model_name": "Qwen3",
  "scenario": "vibe-coding",
  "engine_name": "vllm",
  "device_type": "nvidia/h800",
  "node_num": 1,
  "device_per_node": 8,
  "limit": 5
}
```

### get_perfllm_schema

查看 perfllm 表结构，无参数。

## 表结构

| 字段 | 类型 | 说明 |
|------|------|------|
| id | bigint | 主键 |
| model_name | text | 模型名称 |
| engine_name | text | 推理引擎 |
| device_type | text | 硬件类型 |
| node_num | bigint | 节点数 |
| device_per_node | bigint | 每节点设备数 |
| scenario | text | 测试场景 |
| dtype | text | 数据类型 |
| quantization | text | 量化方式 |
| gpu_memory_utilization | numeric | GPU 显存利用率 |
| data_parallel_size | bigint | 数据并行度 |
| pipeline_parallel_size | bigint | 流水线并行度 |
| tensor_parallel_size | bigint | 张量并行度 |
| enable_expert_parallel | boolean | 是否启用专家并行 |
| enable_chunked_prefill | boolean | 是否启用 chunked prefill |
| ttft | numeric | 首 token 延迟 (ms) |
| tpot | numeric | 每 token 延迟 (ms) |
| qps | numeric | 查询每秒 |
| throughput | numeric | 吞吐量 |
| command | text | 启动命令 |
| max_model_len | bigint | 最大模型长度 |
| concurrency_when_max_len | numeric | 满长度时并发数 |
| max_num_seqs | bigint | 最大序列数 |
| container_image | text | 容器镜像 |
| task_id | bigint | 关联任务 ID |
| cpu | bigint | CPU 核数 |
| memory | bigint | 内存大小 |

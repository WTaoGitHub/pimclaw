---
name: qianjin-xuntui
description: 前进平台 AI 开发平台操作技能，支持模型训练、模型管理、模型部署和 AI 资产管理。通过 qianjin-xuntui MCP Server 提供 87 个工具。当用户提到前进平台、模型训练、Notebook、模型部署、数据集管理、镜像管理、模型评测、魔搭下载、批量推理时触发此技能。
---

# 前进平台 AI 开发平台

通过 qianjin-xuntui MCP Server 操作前进平台，实现端到端的 AI 模型开发、训练、评测和部署。

## MCP 接入方式

**通过 mcporter 接入（推荐）：**

OpenClaw 使用 [mcporter](https://github.com/steipete/mcporter) 连接 qianjin-xuntui MCP Server。

### 环境变量配置

在部署环境中设置以下环境变量：

```bash
# MCP Server 地址（必填）
export QIANJIN_MCP_URL="http://your-server:port/sse"

# 示例
export QIANJIN_MCP_URL="http://10.1.112.236:31006/sse"
```

### 配置文件位置
```
~/.openclaw/tools/mcporter/config/mcporter.json
```

### 配置示例
```json
{
  "mcpServers": {
    "qianjin-xuntui": {
      "baseUrl": "${QIANJIN_MCP_URL}"
    }
  }
}
```

> ⚠️ **注意**：MCP Server 地址通过环境变量 `QIANJIN_MCP_URL` 配置，不要在配置文件中写死地址，便于不同环境部署。

### 查询 MCP 工具列表
```bash
cd ~/.openclaw/tools/mcporter
node dist/cli.js list          # 查看所有 MCP server 及工具数量
node dist/cli.js list --json   # JSON 格式输出，包含完整工具列表
```

### 调用 MCP 工具
```bash
node dist/cli.js call <tool_name> --params '<json>'
```

> 注意：工具数量可能实时更新，查询最新信息请使用 `mcporter list --json`。

## 初始化流程

**所有操作前必须先完成认证：**

```
1. auth_login(username, password) → 获取 token
2. auth_list_tenants(token) → 获取 tenantId
```

后续所有操作都需要传递 `token` 和 `tenantId` 参数。

**Token 有效期约 4 小时，过期需重新登录。**

## ⚠️ 操作规范

### 用户鉴权（所有操作的前置条件）

**所有平台操作都需要用户先完成认证，Agent 不得自行执行任何平台操作。**

#### 认证流程

```
┌─────────────────────────────────────────────────────────────┐
│  步骤 1：获取用户登录凭据                                    │
├─────────────────────────────────────────────────────────────┤
│  Agent 必须询问用户：                                        │
│  "请提供前进平台的登录账号和密码"                             │
│                                                              │
│  ⚠️ 禁止假设或使用默认账号密码                               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤 2：调用 auth_login 登录                                │
├─────────────────────────────────────────────────────────────┤
│  auth_login(username, password) → 返回 token                │
│                                                              │
│  Token 有效期约 4 小时                                       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤 3：查询租户列表（必须停下让用户选择！）                  │
├─────────────────────────────────────────────────────────────┤
│  auth_list_tenants(token) → 返回租户列表                     │
│                                                              │
│  ⚠️ 禁止自行选择租户，必须展示列表让用户确认                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤 4：用户确认租户                                        │
├─────────────────────────────────────────────────────────────┤
│  Agent 展示租户列表，等待用户选择：                           │
│                                                              │
│  "您的账号下有以下租户：                                      │
│   1. 训推租户 (ID: xxx)                                      │
│   2. 开发测试租户 (ID: xxx)                                  │
│   请选择要使用的租户？"                                      │
│                                                              │
│  用户确认后，记录 tenantId，后续操作使用此租户                │
└─────────────────────────────────────────────────────────────┘
```

#### 禁止行为

- ❌ 未经询问自行使用默认账号密码
- ❌ 登录后自行选择租户（即使是第一个租户）
- ❌ 假设用户偏好某个租户
- ❌ 在用户确认租户前执行任何平台操作

#### 正确示例

```
用户：帮我创建一个训练任务

Agent：在操作前需要先完成认证，请提供：
       1. 前进平台登录账号
       2. 登录密码

用户：账号是 xxx，密码是 xxx

Agent：正在登录...成功！
       
       您的账号下有以下租户：
       1. 训推租户 (ID: 4197677785752444928)
       2. 测试租户 (ID: 1234567890123456789)
       
       请选择要使用的租户？

用户：用训推租户

Agent：已选择训推租户，现在可以继续操作...
       （继续后续流程）
```

---

### 核心原则：增删改操作必须人类确认

所有创建（Create）、删除（Delete）、更新（Update）操作，**严禁** Agent 自行配置默认参数后直接执行。

### 正确流程：先准备完整，再一次性确认，然后执行

```
┌─────────────────────────────────────────────────────────────┐
│  阶段一：Agent 自动准备（不打扰用户）                          │
├─────────────────────────────────────────────────────────────┤
│  1. 查询所有可选选项（队列、镜像、数据集、模型等）              │
│  2. 检查资源状态（GPU 空闲、数据集已发布等）                   │
│  3. 配置默认参数和推荐值                                      │
│  4. 准备完整的参数清单                                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  阶段二：一次性提交人类审核（必要环节）                        │
├─────────────────────────────────────────────────────────────┤
│  展示完整参数配置：                                           │
│  - 所有可选参数及其当前值                                     │
│  - 默认参数和推荐参数                                         │
│  - 关键决策点说明                                             │
│                                                              │
│  等待用户确认：y（执行）/ n（取消）/ 修改意见                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  阶段三：确认后执行                                           │
├─────────────────────────────────────────────────────────────┤
│  用户确认 → 执行操作 → 汇报结果                               │
└─────────────────────────────────────────────────────────────┘
```

### 最小人类介入原则

- **不要频繁打扰**：在提交审核前，Agent 要提前做好该做的准备工作
- **只在必要环节停下来**：不是每一步都问，而是在最终执行前一次性确认
- **完整呈现**：提交审核时要完整，不要让人类觉得信息不足

### 示例对比

```
❌ 错误做法（频繁打扰）：
用户：帮我创建训练任务
Agent：好的，用哪个队列？
用户：默认队列
Agent：用哪个镜像？
用户：不知道，你选
Agent：用哪个数据集？
用户：...（不耐烦）

✅ 正确做法（一次性确认）：
用户：帮我创建训练任务
Agent：（自动查询队列、镜像、数据集、模型...）

Agent：准备创建训练任务，请确认参数：

      📊 数据集信息
      - 名称: alpaca-train
      - 状态: 已发布 (407)

      🧠 预训练模型
      - 名称: qwen3-0.6b

      🖥️ 训练配置
      - 队列: 默认队列 (MTT S4000, 空闲 GPU: 2)
      - 镜像: llamafactory:latest（推荐）
      - 资源: 4核CPU / 16GiB内存 / 1 GPU

      确认执行？(y/n 或提出修改意见)

用户：y
Agent：正在创建...完成！
```

### 禁止行为

- ❌ 未经确认擅自创建、删除、更新资源
- ❌ 自行配置默认参数后直接执行
- ❌ 假设用户偏好某个选项
- ❌ 自动选择"第一个"或"看起来最合适"的选项
- ❌ 频繁打断用户询问单个参数

### 适用场景

| 操作类型 | 是否需要确认 | 示例 |
|----------|:------------:|------|
| 创建（Create） | ✅ 必须 | 创建数据集、训练任务、推理服务、Notebook |
| 删除（Delete） | ✅ 必须 | 删除数据集、模型、服务、任务 |
| 更新（Update） | ✅ 必须 | 更新服务配置、停止/启动服务 |
| 查询（List/Get） | ❌ 不需要 | 查询队列、镜像、数据集列表 |

### 多选项处理

当存在多个可选项时（如多个租户、多个队列），**必须先展示选项让用户确认**，再执行后续操作。

## 核心模块

### 1. 资源查询
```
# 查询队列资源（GPU、CPU、内存）
notebook_list_queues(token, tenantId)      # Notebook 队列
model_train_list_queues(token, tenantId)   # 训练队列
model_deploy_list_queues(token, tenantId)  # 部署队列
```

关键字段：`id`(队列ID)、`gpuCountFree`(空闲GPU)、`resourcePoolEngName`、`computePowerModel`

### 2. Notebook 开发环境
```
# 创建 Notebook
notebook_create(token, tenantId, noteBookName, queueId, imageId, imageVersionId, ...)

# 管理
notebook_list / notebook_get / notebook_start / notebook_stop / notebook_delete
```

### 3. 模型训练
```
# 创建训练任务
model_train_create_job(token, tenantId, name, queueId, image, tasks, ...)

# tasks 配置
[{
  "role": "task",
  "replicas": 1,
  "commands": ["sh", "-c", "python train.py"],
  "cpu": 4, "memory": 8, "gpu": "1"
}]

# 管理
model_train_list_jobs / model_train_stop_job / model_train_delete_job
```

### 4. 模型部署
```
# 创建在线服务
model_deploy_create_service(token, tenantId, serviceName, queueId, containers, ...)

# containers 配置
[{
  "cpu": 4, "memory": 8, "gpuCount": 1,
  "imageId": 30, "imageVersionId": 31,
  "modelInfos": [{ "modelId": xxx, "modelVersionId": xxx, "uri": "..." }]
}]

# 管理
model_deploy_list_services / model_deploy_start_service / model_deploy_stop_service / model_deploy_delete_service
```

### 5. 数据集管理
```
# 完整流程
dataset_create → dataset_create_version → dataset_list_versions → dataset_import → dataset_publish

# 只有状态 407（已发布）的数据集才能用于训练和评测
```

### 6. 模型下载（魔搭社区）
```
# 从 ModelScope 下载模型
model_download_create(token, tenantId, modelScopePath, type, modelName, visibleRange)

# type: "new"(新模型) 或 "old"(新版本)
```

### 7. 模型评测
```
# 创建评测任务
model_eval_create(token, tenantId, name, serviceId, datasetId, datasetVersionId, ...)
```

## 参数速查

### imageUsage（镜像用途）
| 值 | 用途 |
|----|------|
| 1 | Notebook |
| 2 | 训练 |
| 3 | 数据标注 |
| 4 | 推理 |
| 5 | 评估 |

### visibleRange（可见范围）
| 值 | 范围 |
|----|------|
| 1 | 公开 |
| 2 | 个人 |
| 3 | 租户 |

### dataType（数据类型）
| 值 | 类型 |
|----|------|
| 0 | 图片 |
| 1 | 文本 |
| 2 | 表格 |
| 3 | 语音 |
| 4 | 其他 |
| 5 | prompt+response |

### 服务状态
| 状态码 | 说明 |
|--------|------|
| 1 | 运行中 |
| 3 | 已停止 |
| 4 | 已终止 |

### annotateType（标注类型）
| 值 | 类型 |
|----|------|
| 101 | 分类 |
| 102 | 目标检测 |
| 201 | 目标跟踪 |
| 301 | 文本分类 |

## GPU 注意事项

**MTT S4000 GPU（摩尔线程）：**
- 需要使用 musa 兼容镜像（如 vllm-musa）
- `gpuCountName = "mthreads.com/gpu"`

**创建任务前务必检查 `gpuCountFree > 0`**

## 日志和事件查询关键参数

### ⚠️ 常见错误：参数取值错误导致查不到日志

| 参数 | ❌ 错误取值 | ✅ 正确取值 | 来源 |
|------|------------|------------|------|
| `clusterName` | IP地址、`"default"` | `"qianjin2.0"` | `notebook_get_queue_detail` 返回的 `clusterName` |
| `jobName` | 任务名称 `"my-task"` | taskId `"task-1774517833-lcxtm"` | `model_train_list_jobs` 返回的 `taskId` 字段 |

### 正确流程

```
1. model_train_list_jobs → 获取 taskId（不是 name！）
2. notebook_get_queue_detail(id=queueId) → 获取 clusterName（不是 clusterHost！）
3. model_train_get_logs(clusterName, jobName=taskId, ...) → 查询日志
```

### 示例

```bash
# 步骤 1：查询任务，获取 taskId
model_train_list_jobs → taskId = "task-1774517833-lcxtm"

# 步骤 2：查询队列详情，获取 clusterName
notebook_get_queue_detail(id=2) → clusterName = "qianjin2.0"

# 步骤 3：查询日志（正确参数）
model_train_get_logs(
  clusterName="qianjin2.0",    # ← 从 notebook_get_queue_detail 获取
  jobName="task-1774517833-lcxtm",  # ← 使用 taskId，不是任务名
  namespace="tenant-xxx",
  queueId=2,
  ...
)
```

### 同样适用于其他日志查询

| 工具 | clusterName 来源 | jobName/podName 来源 |
|------|------------------|---------------------|
| `model_train_get_logs` | `notebook_get_queue_detail` | `taskId` |
| `model_deploy_get_logs` | `notebook_get_queue_detail` | serviceName（从 service 详情获取） |
| `model_eval_get_logs` | `notebook_get_queue_detail` | `modelEvaluationId` |
| `batch_inference_get_logs` | `notebook_get_queue_detail` | 任务名 |
| `notebook_get_logs` | `notebook_list` 或 `notebook_get` | notebookId |

### ⚠️ 故障排查优先级：查询日志和事件

当训练任务、在线服务、Notebook 运行失败或状态异常时，**优先查询日志和事件**分析原因，而不是猜测或重新创建。

```
故障排查流程：
┌─────────────────────────────────────────────────────────────┐
│  状态异常（Failed / 启动失败 / 运行错误）                      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤 1：查询日志 - 分析具体错误信息                            │
├─────────────────────────────────────────────────────────────┤
│  - 训练任务: model_train_get_logs                            │
│  - 在线服务: model_deploy_get_logs                           │
│  - Notebook: notebook_get_logs                               │
│  - 评测任务: model_eval_get_logs                             │
│  - 批量推理: batch_inference_get_logs                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤 2：查询事件 - 了解调度、启动过程中的问题                   │
├─────────────────────────────────────────────────────────────┤
│  - 训练任务: model_train_get_events                          │
│  - 在线服务: model_deploy_get_events                         │
│  - Notebook: notebook_get_events                             │
│  - 评测任务: model_eval_get_events                           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  根据日志/事件信息确定原因并修复                                │
├─────────────────────────────────────────────────────────────┤
│  常见错误示例：                                                │
│  - FileNotFoundError: 数据集/模型挂载路径错误                  │
│  - CUDA out of memory: GPU 显存不足                          │
│  - PodGroupPending: 资源不足，等待调度                        │
│  - ImagePullBackOff: 镜像拉取失败                            │
│  - vLLM V1 引擎问题: MTT S4000 需要 VLLM_USE_V1=0            │
└─────────────────────────────────────────────────────────────┘
```

**常见故障原因对照表**：

| 错误类型 | 可能原因 | 解决方案 |
|----------|----------|----------|
| FileNotFoundError | 数据集/模型未挂载或路径错误 | 检查 dataList/modelList 配置 |
| CUDA/内存错误 | 资源不足 | 减少 batch_size 或增加内存 |
| PodGroupPending | GPU 资源不足 | 等待资源或停止其他任务 |
| ImagePullBackOff | 镜像不存在或网络问题 | 检查镜像地址 |
| 启动命令错误 | 命令格式或参数错误 | 检查 commands 配置 |
| vLLM 引擎错误 | MTT S4000 兼容性问题 | 添加 VLLM_USE_V1=0 |
| 数据集格式错误 | LlamaFactory 找不到数据集 | 检查 dataset_info.json |

## 高级功能

### SwanLab 监控
训练任务支持 SwanLab 监控，需先调用 `swanlab_start` 开启服务：
```
swanlab_start(token, tenantId) → 获取 url
# 然后在 model_train_create_job 中设置：
# swanlab: true, swanlabSummary: "/path/to/logs"
```

### vGPU（虚拟算力）
支持 GPU 虚拟化，可按需分配显存：
- Notebook: `computePowerVirtual: true`
- 训练任务: `computePowerVirtual: true`, `isGpuShare: true`

### SSH 访问（Notebook）
Notebook 支持 SSH 访问：
```
useSsh: true
sshKey: "ssh-rsa AAAA..."  # 用户 SSH 公钥
```

### RDMA 网络
支持 RDMA 高速网络（需队列支持）：
```
rdmaEnabled: true  # Notebook 中启用
```

### 裁判员模型评测
模型评测支持裁判员模型，用于更准确的评估：
```
judgeSupport: true
judgeArgInfo: {
  apiUrl: "裁判员模型 API 地址",
  modelId: "模型名称",
  apiKey: "API Key"
}
```

### 数据集/模型挂载
训练任务和 Notebook 支持挂载数据集和模型：
```
# 数据集挂载
datasetList: [{
  datasetId: xxx,
  datasetVersionId: xxx,
  uri: "public/datalist/xxx/V1",
  mountPath: "/data",
  accessPermission: "ReadOnly"  # 或 "ReadWrite"
}]

# 模型挂载
modelList: [{
  modelId: xxx,
  modelVersionId: xxx,
  uri: "public/modellist/xxx/V1",
  mountPath: "/model"
}]
```

### SFTP 大文件传输
用于上传大于 500MB 的文件：
```
# 1. 开启 SFTP 通道
sftp_start(token, tenantId) → 返回 account, ip, port, password

# 2. 连接并上传
sftp -P {port} {account}@{ip}
put local_file.parquet

# 3. 导入数据
dataset_import(token, tenantId, datasetVersionId, paths: ["//local_file.parquet"])

# 4. 关闭通道
sftp_stop(token, tenantId)
```

## 示例场景

### 场景一：从 HuggingFace 下载数据并导入平台

**完整工作流：文件下载 → SFTP上传 → 创建数据集 → 导入 → 发布**

```bash
# ============================================
# 步骤 1：下载文件（以 HuggingFace 镜像为例）
# ============================================
curl -L -o /tmp/alpaca_train.parquet \
  "https://hf-mirror.com/datasets/tatsu-lab/alpaca/resolve/main/data/train-00000-of-00001-a09b74b3ef9c3b56.parquet"

# ============================================
# 步骤 2：登录平台并获取租户 ID
# ============================================
cd ~/.openclaw/tools/mcporter

# 登录
node dist/cli.js call qianjin-xuntui.auth_login --args '{"username":"your_username","password":"your_password"}'
# 返回: {"token": "xxx", "expireTime": "..."}

# 获取租户列表（必须让用户确认选择哪个租户！）
node dist/cli.js call qianjin-xuntui.auth_list_tenants --args '{"token":"xxx"}'
# 返回租户列表，等待用户确认

# ============================================
# 步骤 3：创建数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_create --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "alpaca-train",
  "dataType": 5,
  "remark": "Alpaca training dataset from HuggingFace"
}'
# 返回: {"success": true, "data": 161}  ← 数据集 ID

# ============================================
# 步骤 4：创建数据集版本
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_create_version --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 161
}'
# 返回: {"success": true, "data": "V1"}

# 查询版本 ID
node dist/cli.js call qianjin-xuntui.dataset_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 161
}'
# 返回版本信息，获取 versionId

# ============================================
# 步骤 5：开启 SFTP 通道
# ============================================
node dist/cli.js call qianjin-xuntui.sftp_start --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'
# 返回: {"account": "xiongxiong", "ip": "10.1.112.238", "port": 30472, "password": "xxx"}

# ============================================
# 步骤 6：上传文件到 SFTP（关键！）
# ============================================
# ⚠️ 重要：SFTP 根目录无写入权限，必须上传到 upload/ 目录
# ⚠️ 平台会在 upload/ 后自动创建 upload/ 子目录，路径为 upload/upload/

curl -k -u "账号:密码" --ftp-create-dirs \
  -T /tmp/alpaca_train.parquet \
  "sftp://IP:端口/upload/upload/alpaca_train.parquet" \
  --progress-bar

# ============================================
# 步骤 7：导入数据到数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_import --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetVersionId": 205,
  "paths": ["//upload/alpaca_train.parquet"],
  "closeSFTP": true
}'
# paths 格式：必须以 // 开头，// 代表 SFTP 根目录
# closeSFTP: true 会自动关闭 SFTP 通道

# ============================================
# 步骤 8：发布数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_publish --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetVersionId": 205
}'

# 验证发布状态（status=407 表示已发布可用）
node dist/cli.js call qianjin-xuntui.dataset_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 161
}'
```

**关键注意事项：**

| 问题 | 解决方案 |
|------|----------|
| SFTP 根目录无法写入 | 上传到 `upload/upload/` 目录 |
| `dataset_import` paths 格式 | 必须以 `//` 开头，如 `//upload/file.parquet` |
| 数据集状态 405 而非 407 | 需要调用 `dataset_publish` 发布 |
| 不同租户数据隔离 | 每个租户需要单独创建数据集 |

**状态码说明：**

| 状态码 | 含义 |
|--------|------|
| 101 | 初始化 |
| 405 | 已导入未发布 |
| **407** | **已发布，可用于训练/评测** |

---

## 完整工作流示例

以下是基于最新 MCP 工具的端到端工作流，涵盖从数据准备到模型训练的全流程。

### 工作流一：外部数据集导入平台

**场景**：从 HuggingFace 等外部源下载数据，通过 SFTP 上传到平台并创建数据集。

```bash
# ============================================
# 前置步骤：认证并选择租户
# ============================================
cd ~/.openclaw/tools/mcporter

# 1. 登录获取 token
node dist/cli.js call qianjin-xuntui.auth_login --args '{
  "username": "your_username",
  "password": "your_password"
}'
# 返回: {"token": "xxx", "expireTime": "..."}

# 2. 获取租户列表（⚠️ 必须让用户确认选择！）
node dist/cli.js call qianjin-xuntui.auth_list_tenants --args '{"token": "xxx"}'
# 返回租户列表，展示给用户选择

# ============================================
# 步骤 1：从外部源下载数据文件
# ============================================
# 示例：从 HuggingFace 镜像下载 alpaca 数据集
curl -L -o /tmp/alpaca_train.parquet \
  "https://hf-mirror.com/datasets/tatsu-lab/alpaca/resolve/main/data/train-00000-of-00001-a09b74b3ef9c3b56.parquet"

# ============================================
# 步骤 2：开启 SFTP 通道
# ============================================
node dist/cli.js call qianjin-xuntui.sftp_start --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'
# 返回: {"account": "用户名", "ip": "10.1.112.238", "port": 30472, "password": "xxx"}

# ============================================
# 步骤 3：通过 SFTP 上传文件
# ============================================
# ⚠️ 重要：SFTP 根目录无写入权限，必须上传到 upload/ 目录
# 使用 curl 上传（推荐）
curl -k -u "账号:密码" --ftp-create-dirs \
  -T /tmp/alpaca_train.parquet \
  "sftp://IP:端口/upload/upload/alpaca_train.parquet" \
  --progress-bar

# 或使用 sftp 命令行工具
sftp -P {port} {account}@{ip}
# 然后执行: put /tmp/alpaca_train.parquet upload/alpaca_train.parquet

# ============================================
# 步骤 4：验证文件上传成功
# ============================================
node dist/cli.js call qianjin-xuntui.sftp_list_files --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "path": "/upload"
}'
# 返回上传目录中的文件列表

# ============================================
# 步骤 5：创建数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_create --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "alpaca-train",
  "dataType": 5,
  "remark": "Alpaca training dataset"
}'
# 返回: {"success": true, "data": 161}  ← 数据集 ID

# ============================================
# 步骤 6：创建数据集版本
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_create_version --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 161
}'
# 返回: {"success": true, "data": "V1"}

# 查询版本 ID
node dist/cli.js call qianjin-xuntui.dataset_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 161
}'
# 返回版本信息，获取 datasetVersionId

# ============================================
# 步骤 7：导入 SFTP 文件到数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_import --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetVersionId": 205,
  "paths": ["//upload/alpaca_train.parquet"],
  "closeSFTP": true
}'
# ⚠️ paths 格式：必须以 // 开头，// 代表 SFTP 根目录
# closeSFTP: true 会自动关闭 SFTP 通道

# ============================================
# 步骤 8：发布数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_publish --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetVersionId": 205
}'

# 验证发布状态（status=407 表示已发布可用）
node dist/cli.js call qianjin-xuntui.dataset_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 161
}'
```

**数据集状态码说明：**

| 状态码 | 含义 |
|--------|------|
| 101 | 初始化 |
| 405 | 已导入未发布 |
| **407** | **已发布，可用于训练/评测** |

---

### 工作流二：从魔搭社区下载模型

**场景**：从 ModelScope（魔搭社区）下载预训练模型到平台。

```bash
# ============================================
# 步骤 1：创建模型下载任务
# ============================================
node dist/cli.js call qianjin-xuntui.model_download_create --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "modelScopePath": "Qwen/Qwen3-0.6B",
  "type": "new",
  "modelName": "qwen3-0.6b",
  "visibleRange": 2
}'

# 参数说明：
# - modelScopePath: 魔搭社区的模型路径
# - type: "new" 创建新模型，"old" 为已有模型添加新版本
# - modelName: 平台上的模型名称
# - visibleRange: 1=公开, 2=个人, 3=租户

# ============================================
# 步骤 2：查询下载任务状态
# ============================================
node dist/cli.js call qianjin-xuntui.model_download_list_tasks --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'
# 返回任务 ID、状态、进度等信息

# ============================================
# 步骤 3：如下载失败，可重启任务
# ============================================
node dist/cli.js call qianjin-xuntui.model_download_restart_task --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "taskId": "下载任务ID"
}'

# ============================================
# 步骤 4：下载完成后，查询模型信息
# ============================================
node dist/cli.js call qianjin-xuntui.model_repo_list --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "qwen3"
}'
# 返回模型 ID、版本信息（包含 id、uri）

node dist/cli.js call qianjin-xuntui.model_repo_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "modelId": 242
}'
# 返回版本 ID、版本名称、URI 等
```

---

### 工作流三：手动创建模型（非魔搭下载）

**场景**：已有模型文件，需要在平台上创建模型条目。

```bash
# ============================================
# 步骤 1：创建模型条目
# ============================================
node dist/cli.js call qianjin-xuntui.model_repo_create --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "modelName": "my-custom-model",
  "visibleRange": 2
}'
# 返回: {"success": true, "data": 模型ID}

# ⚠️ 注意：创建后模型版本数为 0，需要通过 SFTP 上传模型文件
# 模型文件上传方式与数据集类似，使用 sftp_start 开启通道

# ============================================
# 步骤 2：查询模型列表确认创建成功
# ============================================
node dist/cli.js call qianjin-xuntui.model_repo_list --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "my-custom-model"
}'
```

---

### 工作流四：查询训练任务所需资源

**场景**：在创建训练任务前，查询可用队列、镜像、数据集、模型等资源。

```bash
# ============================================
# 步骤 1：查询训练队列资源
# ============================================
node dist/cli.js call qianjin-xuntui.model_train_list_queues --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'
# 返回队列 ID、资源池名称、算力型号、空闲 GPU 数量
# ⚠️ 创建任务前务必检查 gpuCountFree > 0

# 关键字段：
# - id: 队列 ID
# - resourcePoolEngName: 资源池英文名
# - computePowerModel: 算力型号（如 MTT S4000）
# - gpuCountFree: 空闲 GPU 数量
# - gpuCountName: GPU 资源名称（摩尔线程为 "mthreads.com/gpu"）

# ============================================
# 步骤 2：查询训练镜像
# ============================================
node dist/cli.js call qianjin-xuntui.image_repo_list --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "imageUsage": 2
}'
# imageUsage: 1=Notebook, 2=训练, 4=推理, 5=评估
# 返回镜像 ID、名称、版本列表、镜像地址

# ⚠️ GPU 类型匹配：
# - MTT S4000（摩尔线程）需要 musa 兼容镜像（如 llamafactory、vllm-musa）
# - NVIDIA GPU 可使用标准 CUDA 镜像

# ============================================
# 步骤 3：查询可用数据集
# ============================================
node dist/cli.js call qianjin-xuntui.dataset_list --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'
# 返回数据集 ID、名称、URI

# 查询数据集版本
node dist/cli.js call qianjin-xuntui.dataset_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "datasetId": 163
}'
# 返回版本 ID、状态（需要 status=407 才可用）

# ============================================
# 步骤 4：查询可用模型
# ============================================
node dist/cli.js call qianjin-xuntui.model_repo_list --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'
# 返回模型 ID、名称、版本信息

node dist/cli.js call qianjin-xuntui.model_repo_list_versions --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "modelId": 242
}'
# 返回版本 ID、URI 等
```

---

### 工作流五：创建训练任务（含数据集和模型挂载）

**场景**：创建一个完整的微调训练任务，挂载数据集和预训练模型。

```bash
# ============================================
# 前置步骤：确认资源已就绪
# - 队列有空闲 GPU
# - 数据集已发布（status=407）
# - 模型已下载完成
# - 镜像与 GPU 类型匹配
# ============================================

# ============================================
# 创建训练任务
# ============================================
node dist/cli.js call qianjin-xuntui.model_train_create_job --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "qwen3-0.6b-finetune",
  "queueId": 2,
  "resourcePoolEngName": "resourcepool-2",
  "computePowerModel": "MTT S4000",
  "gpuCountName": "mthreads.com/gpu",
  "image": "10.1.112.238:8443/library/llamafactory:latest",
  "tasks": [{
    "role": "task",
    "replicas": 1,
    "commands": ["sh", "-c", "python train.py --model /model --data /data"],
    "cpu": 4,
    "memory": 16,
    "gpuCount": 1
  }],
  "dataList": [{
    "ids": [163, 212],
    "datasetId": 163,
    "datasetVersionId": 212,
    "dataUri": "user-xxx/datalist/163/V1",
    "dataMountPath": "/data",
    "accessPermission": "ReadOnly"
  }],
  "modelList": [{
    "ids": [242, 249, 1],
    "modelId": 242,
    "modelVersionId": 249,
    "modelUri": "user-xxx/modellist/242/V1",
    "modelMountPath": "/model"
  }]
}'

# ============================================
# 参数详解
# ============================================

# 【必填参数】
# - name: 任务名称（租户内唯一）
# - queueId: 队列 ID（从 model_train_list_queues 获取）
# - resourcePoolEngName: 资源池英文名（从队列信息获取）
# - computePowerModel: 算力型号（从队列信息获取）
# - gpuCountName: GPU 资源名称（从队列信息获取，摩尔线程为 "mthreads.com/gpu"）
# - image: 镜像地址（从 image_repo_list_versions 获取 imageUrl）
# - tasks: 任务角色配置列表

# 【tasks 配置】
# - role: 角色（task/master/worker）
# - replicas: 副本数
# - commands: 启动命令数组
# - cpu: CPU 核数
# - memory: 内存 GB
# - gpuCount: GPU 卡数

# 【dataList 数据集挂载】
# - ids: [datasetId, datasetVersionId] 数组
# - datasetId: 数据集 ID
# - datasetVersionId: 数据集版本 ID
# - dataUri: 数据集 URI（从 dataset_list 获取）
# - dataMountPath: 挂载路径（训练代码从此路径读取数据）
# - accessPermission: 权限，"ReadOnly" 或 "ReadWrite"

# 【modelList 模型挂载】
# - ids: [modelId, modelVersionId, 1] 数组（第三个参数固定为 1）
# - modelId: 模型 ID
# - modelVersionId: 模型版本 ID
# - modelUri: 模型 URI（从 model_repo_list_versions 获取）
# - modelMountPath: 挂载路径

# ============================================
# 查询任务状态
# ============================================
node dist/cli.js call qianjin-xuntui.model_train_list_jobs --args '{
  "token": "xxx",
  "tenantId": "租户ID"
}'

# 查询特定任务
node dist/cli.js call qianjin-xuntui.model_train_list_jobs --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "qwen3-0.6b-finetune"
}'

# 任务状态说明：
# - Pending: 等待资源
# - Running: 运行中
# - Succeeded: 成功完成
# - Failed: 失败
# - Stopped: 已停止

# ============================================
# 管理任务
# ============================================
# 停止任务
node dist/cli.js call qianjin-xuntui.model_train_stop_job --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "jobName": "qwen3-0.6b-finetune",
  "namespace": "tenant-租户ID",
  "queueId": 2
}'

# 删除任务
node dist/cli.js call qianjin-xuntui.model_train_delete_job --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "jobName": "qwen3-0.6b-finetune",
  "namespace": "tenant-租户ID",
  "queueId": 2,
  "deployNamespace": "tenant-租户ID"
}'

# 查看任务日志（通过 Pod）
node dist/cli.js call qianjin-xuntui.model_train_list_pods --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "jobName": "qwen3-0.6b-finetune",
  "namespace": "tenant-租户ID",
  "queueId": 2
}'
```

---

### 工作流六：端到端微调训练完整流程

**场景**：从零开始完成一个完整的模型微调流程。

```bash
# ============================================
# 阶段 1：认证
# ============================================
cd ~/.openclaw/tools/mcporter

# 登录
node dist/cli.js call qianjin-xuntui.auth_login --args '{"username":"xxx","password":"xxx"}'
# 返回 token

# 获取租户列表并让用户选择
node dist/cli.js call qianjin-xuntui.auth_list_tenants --args '{"token":"xxx"}'

# ============================================
# 阶段 2：准备数据集
# ============================================
# 2.1 下载数据（示例：从 HuggingFace）
curl -L -o /tmp/train.parquet "https://hf-mirror.com/datasets/xxx/resolve/main/train.parquet"

# 2.2 开启 SFTP 并上传
node dist/cli.js call qianjin-xuntui.sftp_start --args '{"token":"xxx","tenantId":"租户ID"}'
curl -k -u "账号:密码" -T /tmp/train.parquet "sftp://IP:端口/upload/upload/train.parquet"

# 2.3 创建数据集
node dist/cli.js call qianjin-xuntui.dataset_create --args '{
  "token": "xxx", "tenantId": "租户ID", "name": "my-dataset", "dataType": 5
}'
# 返回 datasetId

node dist/cli.js call qianjin-xuntui.dataset_create_version --args '{
  "token": "xxx", "tenantId": "租户ID", "datasetId": 161
}'
# 返回版本名 V1

node dist/cli.js call qianjin-xuntui.dataset_list_versions --args '{
  "token": "xxx", "tenantId": "租户ID", "datasetId": 161
}'
# 返回 datasetVersionId

# 2.4 导入并发布
node dist/cli.js call qianjin-xuntui.dataset_import --args '{
  "token": "xxx", "tenantId": "租户ID", "datasetVersionId": 205,
  "paths": ["//upload/train.parquet"], "closeSFTP": true
}'

node dist/cli.js call qianjin-xuntui.dataset_publish --args '{
  "token": "xxx", "tenantId": "租户ID", "datasetVersionId": 205
}'

# ============================================
# 阶段 3：准备模型
# ============================================
# 方式一：从魔搭下载（推荐）
node dist/cli.js call qianjin-xuntui.model_download_create --args '{
  "token": "xxx", "tenantId": "租户ID",
  "modelScopePath": "Qwen/Qwen3-0.6B",
  "type": "new", "modelName": "qwen3-0.6b", "visibleRange": 2
}'

# 等待下载完成...
node dist/cli.js call qianjin-xuntui.model_download_list_tasks --args '{"token":"xxx","tenantId":"租户ID"}'

# 查询模型信息
node dist/cli.js call qianjin-xuntui.model_repo_list --args '{
  "token": "xxx", "tenantId": "租户ID", "name": "qwen3"
}'
# 返回 modelId, uri

node dist/cli.js call qianjin-xuntui.model_repo_list_versions --args '{
  "token": "xxx", "tenantId": "租户ID", "modelId": 242
}'
# 返回 modelVersionId

# ============================================
# 阶段 4：查询资源
# ============================================
# 查询队列
node dist/cli.js call qianjin-xuntui.model_train_list_queues --args '{"token":"xxx","tenantId":"租户ID"}'
# 获取 queueId, resourcePoolEngName, computePowerModel, gpuCountName

# 查询镜像
node dist/cli.js call qianjin-xuntui.image_repo_list --args '{
  "token": "xxx", "tenantId": "租户ID", "imageUsage": 2
}'
# 获取 imageUrl

# ============================================
# 阶段 5：创建训练任务
# ============================================
node dist/cli.js call qianjin-xuntui.model_train_create_job --args '{
  "token": "xxx",
  "tenantId": "租户ID",
  "name": "my-finetune-job",
  "queueId": 2,
  "resourcePoolEngName": "resourcepool-2",
  "computePowerModel": "MTT S4000",
  "gpuCountName": "mthreads.com/gpu",
  "image": "10.1.112.238:8443/library/llamafactory:latest",
  "tasks": [{
    "role": "task",
    "replicas": 1,
    "commands": ["sh", "-c", "llamafactory-cli train config.yaml"],
    "cpu": 4,
    "memory": 16,
    "gpuCount": 1
  }],
  "dataList": [{
    "ids": [161, 205],
    "datasetId": 161,
    "datasetVersionId": 205,
    "dataUri": "user-xxx/datalist/161/V1",
    "dataMountPath": "/data",
    "accessPermission": "ReadOnly"
  }],
  "modelList": [{
    "ids": [242, 249, 1],
    "modelId": 242,
    "modelVersionId": 249,
    "modelUri": "user-xxx/modellist/242/V1",
    "modelMountPath": "/model"
  }]
}'

# ============================================
# 阶段 6：监控任务
# ============================================
node dist/cli.js call qianjin-xuntui.model_train_list_jobs --args '{"token":"xxx","tenantId":"租户ID"}'
```

---

## 详细参考

- [完整工具指南](references/tools-guide.md) - 工具的完整参数说明
- [工作流示例](references/workflows.md) - 两个核心工作流的完整流程
- [训练任务挂载详解](references/training-with-mounts.md) - 数据集和模型挂载参数详解

## 工具清单（按模块）

| 模块 | 工具 | 说明 |
|------|------|------|
| **认证** | auth_login | 用户登录获取 token |
| | auth_list_tenants | 获取租户列表 |
| | auth_list_projects | 获取项目列表 |
| **数据集** | dataset_list | 查询数据集列表 |
| | dataset_create | 创建数据集 |
| | dataset_create_version | 创建数据集版本 |
| | dataset_list_versions | 查询数据集版本 |
| | dataset_import | 导入数据到数据集 |
| | dataset_publish | 发布数据集 |
| | dataset_get | 获取数据集详情 |
| | dataset_update | 更新数据集信息 |
| | dataset_update_version | 更新数据集版本信息 |
| | dataset_delete | 删除数据集 |
| | dataset_delete_version | 删除数据集版本 |
| **模型仓库** | model_repo_list | 查询模型列表 |
| | model_repo_create | 创建模型 |
| | model_repo_list_versions | 查询模型版本 |
| | model_repo_delete | 删除模型 |
| **模型下载** | model_download_create | 从魔搭下载模型 |
| | model_download_list_tasks | 查询下载任务 |
| | model_download_restart_task | 重启下载任务 |
| | model_download_delete_task | 删除下载任务 |
| **模型训练** | model_train_list_queues | 查询训练队列 |
| | model_train_create_job | 创建训练任务 |
| | model_train_list_jobs | 查询训练任务列表 |
| | model_train_list_pods | 查询任务 Pod |
| | model_train_get_directory | 查询任务输出目录 |
| | model_train_get_logs | 查询任务日志 |
| | model_train_get_events | 查询任务事件 |
| | model_train_stop_job | 停止训练任务 |
| | model_train_delete_job | 删除训练任务 |
| **模型部署** | model_deploy_list_queues | 查询部署队列 |
| | model_deploy_create_service | 创建推理服务 |
| | model_deploy_list_services | 查询服务列表 |
| | model_deploy_get_service | 获取服务详情 |
| | model_deploy_start_service | 启动服务 |
| | model_deploy_stop_service | 停止服务 |
| | model_deploy_delete_service | 删除服务 |
| | model_deploy_update_service | 更新服务配置 |
| | model_deploy_restart_service | 重启服务 |
| | model_deploy_list_pods | 查询服务 Pod |
| | model_deploy_get_logs | 查询服务日志 |
| | model_deploy_get_events | 查询服务事件 |
| **模型评测** | model_eval_list_queues | 查询评测队列 |
| | model_eval_list_services | 查询可用服务 |
| | model_eval_create | 创建评测任务 |
| | model_eval_list_jobs | 查询评测任务 |
| | model_eval_list_pods | 查询评测 Pod |
| | model_eval_get_logs | 查询评测日志 |
| | model_eval_get_events | 查询评测事件 |
| | model_eval_stop_job | 停止评测任务 |
| | model_eval_delete_job | 删除评测任务 |
| **批量推理** | batch_inference_list_queues | 查询批量推理队列 |
| | batch_inference_create | 创建批量推理任务 |
| | batch_inference_list_jobs | 查询任务列表 |
| | batch_inference_list_pods | 查询任务 Pod |
| | batch_inference_get_logs | 查询任务日志 |
| | batch_inference_stop_job | 停止任务 |
| | batch_inference_delete_job | 删除任务 |
| **镜像仓库** | image_repo_list | 查询镜像列表 |
| | image_repo_create | 创建镜像 |
| | image_repo_list_versions | 查询镜像版本 |
| | image_repo_create_version | 从 Harbor 创建版本 |
| | image_repo_list_harbor_namespaces | 查询 Harbor 命名空间 |
| | image_repo_list_harbor_repositories | 查询 Harbor 仓库 |
| | image_repo_list_harbor_tags | 查询 Harbor 标签 |
| | image_repo_get_detail | 获取镜像详情 |
| | image_repo_delete | 删除镜像 |
| | image_repo_delete_version | 删除镜像版本 |
| **Notebook** | notebook_list_queues | 查询 Notebook 队列 |
| | notebook_create | 创建 Notebook |
| | notebook_list | 查询 Notebook 列表 |
| | notebook_get | 获取 Notebook 详情 |
| | notebook_start | 启动 Notebook |
| | notebook_stop | 停止 Notebook |
| | notebook_delete | 删除 Notebook |
| | notebook_update | 更新 Notebook 配置 |
| | notebook_get_directory | 查询目录结构 |
| | notebook_get_logs | 查询日志 |
| | notebook_get_queue_detail | 获取队列详情 |
| | notebook_list_pods | 查询 Notebook Pod |
| | notebook_get_events | 查询 Notebook 事件 |
| **SFTP** | sftp_start | 开启 SFTP 通道 |
| | sftp_list_files | 查看 SFTP 文件列表 |
| | sftp_stop | 关闭 SFTP 通道 |
| **SwanLab** | swanlab_start | 启动 SwanLab 服务 |
| | swanlab_status | 查询 SwanLab 状态 |
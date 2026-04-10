# 前进训推平台 Skill

通过 qianjin-xuntui MCP Server 操作前进训推平台，实现端到端的 AI 模型开发、训练、评测和部署。

## 能力概览

### 支持的操作

| 模块 | 功能 |
|------|------|
| **认证** | 登录、租户管理 |
| **数据集** | 创建、导入、发布、管理 |
| **模型仓库** | 查询、创建、版本管理 |
| **模型下载** | 从魔搭社区下载模型 |
| **模型训练** | 创建训练任务、监控、管理 |
| **模型部署** | 部署推理服务、管理生命周期 |
| **Notebook** | 创建开发环境、SSH 访问 |
| **模型评测** | 创建评测任务、查看结果 |

### 工具列表（87 个）

**认证**：`auth_login`, `auth_list_tenants`, `auth_list_projects`

**数据集**：`dataset_create`, `dataset_list`, `dataset_import`, `dataset_publish`, `dataset_delete`, `dataset_get`, `dataset_update`, `dataset_create_version`, `dataset_list_versions`, `dataset_update_version`, `dataset_delete_version`

**模型**：`model_repo_create`, `model_repo_list`, `model_download_create`, `model_repo_list_versions`, `model_repo_delete`

**训练**：`model_train_create_job`, `model_train_list_jobs`, `model_train_stop_job`, `model_train_list_queues`, `model_train_list_pods`, `model_train_get_directory`, `model_train_get_logs`, `model_train_get_events`, `model_train_delete_job`

**部署**：`model_deploy_create_service`, `model_deploy_list_services`, `model_deploy_stop_service`, `model_deploy_list_queues`, `model_deploy_get_service`, `model_deploy_start_service`, `model_deploy_delete_service`, `model_deploy_update_service`, `model_deploy_restart_service`, `model_deploy_list_pods`, `model_deploy_get_logs`, `model_deploy_get_events`

**评测**：`model_eval_create`, `model_eval_list_jobs`, `model_eval_stop_job`, `model_eval_list_queues`, `model_eval_list_services`, `model_eval_delete_job`, `model_eval_list_pods`, `model_eval_get_logs`, `model_eval_get_events`

**批量推理**：`batch_inference_create`, `batch_inference_list_jobs`, `batch_inference_stop_job`, `batch_inference_list_queues`, `batch_inference_delete_job`, `batch_inference_list_pods`, `batch_inference_get_logs`

**镜像**：`image_repo_list`, `image_repo_create`, `image_repo_list_versions`, `image_repo_create_version`, `image_repo_list_harbor_namespaces`, `image_repo_list_harbor_repositories`, `image_repo_list_harbor_tags`, `image_repo_get_detail`, `image_repo_delete`, `image_repo_delete_version`

**Notebook**：`notebook_create`, `notebook_list`, `notebook_start`, `notebook_stop`, `notebook_delete`, `notebook_list_queues`, `notebook_get`, `notebook_update`, `notebook_get_directory`, `notebook_get_logs`, `notebook_get_queue_detail`, `notebook_list_pods`, `notebook_get_events`

**SFTP**：`sftp_start`, `sftp_list_files`, `sftp_stop`

**SwanLab**：`swanlab_start`, `swanlab_status`

---

## 使用示例

### 场景一：下载模型并部署推理服务

```
帮我从魔搭下载 Qwen3-0.6B 模型，然后用 vllm 部署成推理服务
```

Agent 会自动：
1. 检查模型是否已存在
2. 下载模型到平台
3. 查询可用队列和镜像
4. 展示完整参数让你确认
5. 部署服务并返回 API 地址

### 场景二：创建训练任务

```
帮我用 alpaca 数据集微调 Qwen3-0.6B 模型
```

Agent 会自动：
1. 检查数据集和模型
2. 查询训练队列和镜像
3. 展示完整参数让你确认
4. 创建训练任务并监控状态

### 其他示例 Prompt

#### 数据集管理
```
- 下载文件<数据集文件下载链接>，然后导入到平台数据集中。
- 查看我的数据集列表。
```

#### Notebook 开发环境
```
- 给我开一台带 GPU 的开发机。
- 给你自己（agent）创建一台 4c8g 1gpu的开发机，开启 ssh，配置你自己的公钥，通过 ssh 连接开发机。
- 查看我的 Notebook 状态。
```

#### 模型管理
```
- 查看我有哪些模型。
- 帮我下载魔搭上的 Qwen/Qwen2.5-7B-Instruct。
```

#### 服务管理
```
- 查看我的推理服务。
- 停止 qwen3-0.6b-vllm 服务。
```


## 使用范围

**平台**：前进平台 AI 开发平台（训推平台）

**适用场景**：
- 模型训练与微调
- 模型部署与推理
- 数据集管理
- Notebook 开发环境
- 模型评测

---

## 注意事项

1. **Token 有效期**：登录 Token 约 4 小时过期，需要重新登录
2. **参数确认**：创建/删除/更新操作会展示参数让你确认后才执行
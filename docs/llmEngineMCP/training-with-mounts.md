# 创建带有数据集和模型挂载的训练任务

## 概述

本 Skill 详细说明如何正确创建一个同时挂载数据集和模型的训练任务。这是最容易出错的场景之一，常见错误包括参数格式错误、缺少必要字段、ID 获取错误等。

## 前置条件

创建训练任务前，需要依次获取以下资源信息：

1. **队列信息** - 从 `model_train_list_queues` 获取
2. **镜像信息** - 从 `image_repo_list` 获取（imageUsage=2）
3. **模型信息** - 从 `model_repo_list` 和 `model_repo_list_versions` 获取
4. **数据集信息** - 从 `dataset_list` 和 `dataset_list_versions` 获取

## 关键参数详解

### 1. 数据集挂载参数 (dataList)

**正确格式：**

```json
"dataList": [
  {
    "ids": [datasetId, datasetVersionId],
    "datasetId": 163,
    "datasetVersionId": 212,
    "dataUri": "user-4315915030493364224/datalist/163",
    "dataMountPath": "/data"
  }
]
```

**参数说明：**

| 参数 | 类型 | 说明 | 来源 |
|------|------|------|------|
| ids | [number, number] | [数据集ID, 版本ID] | 必须精确匹配 datasetId 和 datasetVersionId |
| datasetId | number | 数据集 ID | 从 `dataset_list` 获取 |
| datasetVersionId | number | 数据集版本 ID | 从 `dataset_list_versions` 获取 |
| dataUri | string | 数据集 URI | 从 `dataset_list` 的 uri 字段获取 |
| dataMountPath | string | 容器内挂载路径 | 自定义，如 `/data` |

**常见错误：**

❌ **错误1：ids 数组格式错误**
```json
"ids": ["163", "212"]  // 错误：应该是数字不是字符串
```

❌ **错误2：缺少 ids 字段**
```json
{
  "datasetId": 163,
  "datasetVersionId": 212
  // 缺少 ids 字段
}
```

❌ **错误3：dataUri 错误**
```json
"dataUri": "public/datalist/163/V1"  // 错误：这是版本URI，应该是数据集URI
```

**正确示例：**
```json
"dataUri": "user-4315915030493364224/datalist/163"  // 数据集 URI
```

### 2. 模型挂载参数 (modelList)

**正确格式：**

```json
"modelList": [
  {
    "ids": [1, modelId, modelVersionId],
    "modelId": 242,
    "modelVersionId": 249,
    "modelUri": "user-4315915030493364224/modellist/242/V1",
    "modelMountPath": "/model"
  }
]
```

**参数说明：**

| 参数 | 类型 | 说明 | 来源 |
|------|------|------|------|
| ids | [number, number, number] | [1, 模型ID, 版本ID] | **注意：第一个元素固定为 1** |
| modelId | number | 模型 ID | 从 `model_repo_list` 获取 |
| modelVersionId | number | 模型版本 ID | 从 `model_repo_list_versions` 获取 |
| modelUri | string | 模型版本 URI | 从 `model_repo_list_versions` 的 uri 字段获取 |
| modelMountPath | string | 容器内挂载路径 | 自定义，如 `/model` |

**常见错误：**

❌ **错误1：ids 数组格式错误**
```json
"ids": [242, 249]  // 错误：应该是3个元素，第一个固定为1
```

❌ **错误2：ids 第一个元素错误**
```json
"ids": [0, 242, 249]  // 错误：第一个元素必须是 1
```

❌ **错误3：modelUri 使用模型 URI 而非版本 URI**
```json
"modelUri": "user-4315915030493364224/modellist/242"  // 错误：缺少版本号
```

**正确示例：**
```json
"modelUri": "user-4315915030493364224/modellist/242/V1"  // 包含版本号的完整 URI
```

### 3. 任务配置参数 (tasks)

**正确格式：**

```json
"tasks": [
  {
    "role": "master",
    "replicas": 1,
    "commands": ["sh", "-c", "python train.py"],
    "cpu": 4,
    "memory": 16,
    "gpu": "1",
    "gpuCount": 1,
    "gpuCountName": "mthreads.com/gpu",
    "workDir": "/model"
  }
]
```

**参数说明：**

| 参数 | 类型 | 说明 |
|------|------|------|
| role | string | 角色：master/worker/task |
| replicas | number | 副本数 |
| commands | string[] | 启动命令数组 |
| cpu | number | CPU 核数 |
| memory | number | 内存(GiB) |
| gpu | string | GPU 卡数（**字符串类型**） |
| gpuCount | number | GPU 卡数（数字类型） |
| gpuCountName | string | 从队列信息获取 |
| workDir | string | 工作目录 |

**注意事项：**
- `gpu` 是字符串类型 `"1"`
- `gpuCount` 是数字类型 `1`
- `gpuCountName` 必须从队列信息获取，不能随意填写

## 完整工作流

### 步骤1：获取队列信息

```
调用：model_train_list_queues
返回：
{
  "id": 2,
  "resourcePoolEngName": "resourcepool-2",
  "computePowers": [{
    "computePowerModel": "MTT S4000",
    "gpuCountFree": 1,
    "gpuCountName": "mthreads.com/gpu"
  }]
}
```

**需要提取的字段：**
- queueId: 2
- resourcePoolEngName: "resourcepool-2"
- computePowerModel: "MTT S4000"
- gpuCountName: "mthreads.com/gpu"

### 步骤2：获取镜像信息

```
调用：image_repo_list（参数 imageUsage=2）
返回：
{
  "id": 93,
  "imageName": "llamafactory",
  "imageVersions": [{
    "id": 139,
    "imageVersion": "latest",
    "imageUrl": "10.1.112.238:8443/library/llamafactory:latest"
  }]
}
```

**需要提取的字段：**
- imageId: 93
- imageVersionId: 139
- image: "10.1.112.238:8443/library/llamafactory:latest"

### 步骤3：获取模型信息

```
调用1：model_repo_list（参数 modelName="qwen3-0.6b"）
返回：
{
  "id": 242,
  "modelName": "qwen3-0.6b",
  "modelVersions": [{
    "id": 249,
    "modelVersion": "V1",
    "uri": "user-4315915030493364224/modellist/242/V1"
  }]
}
```

**需要提取的字段：**
- modelId: 242
- modelVersionId: 249
- modelUri: "user-4315915030493364224/modellist/242/V1"

### 步骤4：获取数据集信息

```
调用1：dataset_list（参数 name="alpaca"）
返回：
{
  "id": 163,
  "name": "alpaca-train-v3",
  "uri": "user-4315915030493364224/datalist/163"
}

调用2：dataset_list_versions（参数 datasetId=163）
返回：
{
  "id": 212,
  "versionName": "V1"
}
```

**需要提取的字段：**
- datasetId: 163
- datasetVersionId: 212
- dataUri: "user-4315915030493364224/datalist/163"（从 dataset_list 获取，不是版本）

### 步骤5：创建训练任务

**完整的参数示例：**

```json
{
  "token": "<token>",
  "tenantId": "4197677785752444928",
  "name": "qwen3-0.6b-finetune-0325",
  "queueId": 2,
  "resourcePoolEngName": "resourcepool-2",
  "computePowerModel": "MTT S4000",
  "gpuCountName": "mthreads.com/gpu",
  "image": "10.1.112.238:8443/library/llamafactory:latest",
  "imageVersionId": 139,
  "modelList": [
    {
      "ids": [1, 242, 249],
      "modelId": 242,
      "modelVersionId": 249,
      "modelUri": "user-4315915030493364224/modellist/242/V1",
      "modelMountPath": "/model"
    }
  ],
  "dataList": [
    {
      "ids": [163, 212],
      "datasetId": 163,
      "datasetVersionId": 212,
      "dataUri": "user-4315915030493364224/datalist/163",
      "dataMountPath": "/data"
    }
  ],
  "tasks": [
    {
      "role": "master",
      "replicas": 1,
      "commands": ["sh", "-c", "ls -la /model && ls -la /data"],
      "cpu": 4,
      "memory": 16,
      "gpu": "1",
      "gpuCount": 1
    }
  ]
}
```

## 验证挂载是否成功

任务创建后，可以通过以下方式验证：

### 方法1：检查任务状态

```
调用：model_train_list_jobs
检查：status 字段
- Succeeded: 成功完成
- Running: 运行中
- Failed: 失败
```

### 方法2：查看 Pod 日志

```
调用：model_train_list_pods
参数：jobName, namespace, queueId

然后查看日志确认挂载点
```

### 方法3：检查输出目录

```
调用：model_train_get_directory
参数：jobName, path
检查：是否能看到训练输出文件
```

## 常见错误排查

### 错误1：任务创建成功但挂载失败

**症状：** 任务状态为 Succeeded 或 Running，但容器内看不到数据

**排查步骤：**
1. 检查 dataList 和 modelList 的 ids 格式
2. 确认 dataUri 和 modelUri 是否正确
3. 验证数据集状态是否为 407（已发布）

### 错误2：参数类型错误

**症状：** API 返回参数格式错误

**排查步骤：**
1. 检查 ids 数组元素是否为数字（不是字符串）
2. 检查 gpu 是否为字符串（"1" 不是 1）
3. 检查 gpuCount 是否为数字（1 不是 "1"）

### 错误3：URI 路径错误

**症状：** 找不到模型或数据集文件

**排查步骤：**
1. 模型 URI：从 `model_repo_list_versions` 的 uri 字段获取，格式如 `user-xxx/modellist/242/V1`
2. 数据集 URI：从 `dataset_list` 的 uri 字段获取，格式如 `user-xxx/datalist/163`（**不是版本 URI**）

## 快速检查清单

创建任务前，请确认：

- [ ] 队列信息：queueId, resourcePoolEngName, computePowerModel, gpuCountName
- [ ] 镜像信息：imageId, imageVersionId, image 地址
- [ ] 模型信息：modelId, modelVersionId, modelUri（从版本获取）
- [ ] 数据集信息：datasetId, datasetVersionId, dataUri（从数据集获取，非版本）
- [ ] modelList.ids 格式：[1, modelId, modelVersionId]
- [ ] dataList.ids 格式：[datasetId, datasetVersionId]
- [ ] tasks 配置：gpu 为字符串，gpuCount 为数字
- [ ] 数据集状态：必须为 407（已发布）

## 示例代码

### Python 格式（供参考）

```python
# 获取资源信息
queues = model_train_list_queues(token, tenantId)
images = image_repo_list(token, tenantId, imageUsage=2)
models = model_repo_list(token, tenantId, modelName="qwen3-0.6b")
model_versions = model_repo_list_versions(token, tenantId, modelId=models[0]["id"])
datasets = dataset_list(token, tenantId, name="alpaca")
dataset_versions = dataset_list_versions(token, tenantId, datasetId=datasets[0]["id"])

# 构建参数
params = {
    "token": token,
    "tenantId": tenantId,
    "name": "qwen3-0.6b-finetune",
    "queueId": queues[0]["id"],
    "resourcePoolEngName": queues[0]["resourcePoolEngName"],
    "computePowerModel": queues[0]["computePowers"][0]["computePowerModel"],
    "gpuCountName": queues[0]["computePowers"][0]["gpuCountName"],
    "image": images[0]["imageVersions"][0]["imageUrl"],
    "imageVersionId": images[0]["imageVersions"][0]["id"],
    "modelList": [{
        "ids": [1, models[0]["id"], model_versions[0]["id"]],
        "modelId": models[0]["id"],
        "modelVersionId": model_versions[0]["id"],
        "modelUri": model_versions[0]["uri"],
        "modelMountPath": "/model"
    }],
    "dataList": [{
        "ids": [datasets[0]["id"], dataset_versions[0]["id"]],
        "datasetId": datasets[0]["id"],
        "datasetVersionId": dataset_versions[0]["id"],
        "dataUri": datasets[0]["uri"],
        "dataMountPath": "/data"
    }],
    "tasks": [{
        "role": "master",
        "replicas": 1,
        "commands": ["sh", "-c", "python train.py"],
        "cpu": 4,
        "memory": 16,
        "gpu": "1",
        "gpuCount": 1
    }]
}

# 创建任务
result = model_train_create_job(**params)
```

## 总结

创建带有数据集和模型挂载的训练任务，最关键的点：

1. **ids 格式正确**：模型 [1, modelId, versionId]，数据集 [datasetId, versionId]
2. **URI 来源正确**：模型 URI 从版本获取，数据集 URI 从数据集获取
3. **类型正确**：gpu 是字符串，gpuCount 是数字，ids 元素是数字
4. **状态检查**：数据集必须已发布（status=407）

遵循以上规范，可以避免 90% 的挂载失败问题。
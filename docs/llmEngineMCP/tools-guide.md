共 87 个工具


============================================================
### 认证 (3 个工具)
============================================================

**auth_login**
  用户登录前进平台，获取认证 Token。返回 token 和过期时间。密码自动进行 RSA 加密。
  参数:
    - username*: 【用户输入】用户名
    - password*: 【用户输入】密码（明文，服务端自动 RSA 加密）

**auth_list_tenants**
  获取当前用户可访问的租户（组织）列表。返回 organId（用于后续 API 调用的 tenantId）和 organName。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token

**auth_list_projects**
  获取指定租户下的项目列表。需要先调用 auth_login 获取 token，auth_list_tenants 选择租户获取 tenantId。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID（organId）

============================================================
### 数据集 (11 个工具)
============================================================

**dataset_list**
  获取数据集列表。可通过 name 参数按名称查找数据集。返回数据集 ID、名称、版本信息。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - name: 【用户输入】数据集名称模糊查询（可选）
    - dataType: 【用户输入】数据类型过滤（0=图片，1=文本，2=表格，3=语音，4=其他，5=prompt+res
    - annotateType: 【用户输入】标注类型过滤（101=分类，102=目标检测，201=目标跟踪，301=文本分类），可选
    - visibleRange: 【用户输入】可见范围过滤（1=公开，2=个人，3=租户），可选
    - type: 【用户输入】数据状态过滤（0=所有，1=可用数据），默认 0
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**dataset_create**
  创建新数据集。需要提供数据集名称和数据类型。

【重要提示】创建成功后数据集版本数为 0，无法直接使用。需要继续执行以下步骤：
1. 调用 dataset_create_version 创建版本（返回
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - name*: 【用户输入】数据集名称
    - dataType*: 【用户输入】数据类型（0=图片，1=文本，2=表格，3=语音，4=其他，5=prompt+respo
    - annotateType: 【用户输入】标注类型（101=分类，102=目标检测，201=目标跟踪，301=文本分类），默认 1
    - visibleRange: 【用户输入】可见范围（1=公开，2=个人，3=租户），默认 2（个人）
    - labelGroupId: 【用户输入】标签组 ID（可选）
    - module: 【用户输入】所属模块（可选）
    - remark: 【用户输入】备注信息（可选）

**dataset_get**
  获取数据集详情。返回数据集完整信息，包括版本数量、当前版本名称等。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - id*: 【从 dataset_list 获取】数据集 ID

**dataset_create_version**
  创建数据集版本。需要提供数据集 ID。

【前置条件】数据集已通过 dataset_create 创建，可从 dataset_list 或 dataset_create 返回值获取 datasetId
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - datasetId*: 【从 dataset_list 获取】数据集 ID
    - versionName: 【用户输入】版本名称（可选，不填则自动生成）
    - versionNote: 【用户输入】版本说明（可选）
    - isInherit: 【用户输入】是否继承上一版本数据（可选，默认 false）
    - format: 【用户输入】版本数据集格式（可选）
    - fileStatus: 【用户输入】文件状态列表（可选）
    - labels: 【用户输入】标签 ID 列表（可选）
    - datasetVersionOriginalId: 【用户输入】继承版本的数据集版本 ID（可选）

**dataset_list_versions**
  获取数据集版本列表。返回版本 ID、版本名称、状态、文件数量等信息。

【使用场景】
- 创建版本后获取 datasetVersionId 用于导入数据和发布
- 选择要使用的数据集版本
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - datasetId*: 【从 dataset_list 获取】数据集 ID
    - status: 【用户输入】版本状态列表（可选，如 [101, 407]）
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**dataset_import**
  导入数据到数据集版本。

【前置条件】
1. 已通过 dataset_create_version 创建版本
2. 已从 dataset_list_versions 获取 datasetVersion
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - datasetVersionId*: 【从 dataset_list 或 dataset_create_version 获取】数据集版本 
    - paths: 【必填】SFTP 上传的文件路径列表。格式：['//filename.parquet']，必须以 /
    - uri: 【用户输入】文件 URI（可选，SFTP 导入时默认为 'null'）
    - visibleRange: 【用户输入】可见范围（1=公开，2=个人，3=租户），默认 1
    - notebookName: 【用户输入】标识名称（可选，通常与 datasetVersionId 相同）
    - closeSFTP: 【用户输入】导入后是否关闭 SFTP 通道，默认 true

**dataset_publish**
  发布数据集版本。发布后（status=407）可用于训练、评测等场景。

【前置条件】已通过 dataset_import 导入数据，并从 dataset_list_versions 获取 datas
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - datasetVersionId*: 【从 dataset_list 或 dataset_create_version 获取】要发布的数据

**dataset_update**
  更新数据集信息。可修改数据集名称、备注、数据类型、可见范围等。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - id*: 【从 dataset_list 获取】数据集 ID
    - name: 【用户输入】数据集名称（可选，不填则保持原值）
    - remark: 【用户输入】备注信息（可选）
    - dataType: 【用户输入】数据类型：0图片，1文本，2表格，3语音，4其他，5 prompt+response（可
    - visibleRange: 【用户输入】可见范围：1-公开、2-个人、3-租户（可选，不填则保持原值）

**dataset_delete**
  删除数据集。支持批量删除，删除后数据集及其所有版本将不可恢复。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - ids*: 【从 dataset_list 获取】要删除的数据集 ID 列表，支持批量删除

**dataset_update_version**
  更新数据集版本信息。可修改版本名称和版本说明。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - versionId*: 【从 dataset_list 获取】数据集版本 ID
    - datasetId*: 【从 dataset_list 获取】数据集 ID
    - versionName: 【用户输入】版本名称（可选）
    - versionNote: 【用户输入】版本说明（可选）

**dataset_delete_version**
  删除数据集版本。删除后该版本数据将不可恢复。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - datasetVersionId*: 【从 dataset_list 获取】数据集版本 ID
    - datasetId: 【从 dataset_list 获取】数据集 ID（可选）
    - versionName: 【用户输入】版本名称（可选）

============================================================
### 模型仓库 (4 个工具)
============================================================

**model_repo_list**
  获取模型库列表。返回模型 ID、名称、版本信息（包含 id、uri）。可供模型部署、训练、Notebook 等模块选择模型使用。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - modelName: 【用户输入】模型名称模糊查询（可选）
    - visibleRange: 【用户输入】可见范围：1=仅自己，2=租户内，3=公开（可选）
    - createUserId: 【用户输入】创建用户 ID（可选）
    - type: 【用户输入】模型类型：1=自定义模型，2=预置模型（可选）
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**model_repo_create**
  创建新模型。需要提供模型名称和可见范围。创建后需通过其他方式上传模型文件。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - modelName*: 【用户输入】模型名称
    - visibleRange*: 【用户输入】可见范围（1=仅自己，2=租户内，3=公开）
    - description: 【用户输入】模型描述（可选）

**model_repo_list_versions**
  获取指定模型的版本列表。返回版本 ID、版本名称、URI 等信息。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - modelId*: 【从 model_repo_list 获取】模型 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**model_repo_delete**
  删除模型。需要提供模型 ID，删除后模型及其所有版本将不可恢复。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - modelId*: 【从 model_repo_list 获取】要删除的模型 ID

============================================================
### 模型下载 (4 个工具)
============================================================

**model_download_create**
  从魔搭社区下载模型到平台。支持保存为新模型或为已有模型添加新版本。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - modelScopePath*: 【用户输入】魔搭社区模型路径（如 Qwen/Qwen2.5-7B-Instruct）
    - type*: 【用户输入】保存方式（new=新模型，old=新版本）
    - modelName: 【用户输入】平台内模型名称（仅 type=new 时必填）
    - visibleRange: 【用户输入】可见范围（1=公开，2=个人，3=组织）
    - description: 【用户输入】模型描述（可选）
    - modelId: 【从 model_repo_list 获取】平台内模型 ID（仅 type=old 时必填）
    - modelVersion*: 【用户输入】版本号（如 V1，type=old 时可从模型列表获取 nextVersionName）
    - modelVersionDescription: 【用户输入】版本描述（可选）

**model_download_list_tasks**
  查询模型下载任务列表。返回任务 ID、状态、魔搭模型路径、平台模型名称等信息。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**model_download_restart_task**
  重启下载任务。用于下载失败后重新尝试。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - id*: 【从 model_download_list_tasks 获取】下载任务 ID

**model_download_delete_task**
  删除下载任务。可选择是否同时删除已下载的模型文件。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - id*: 【从 model_download_list_tasks 获取】下载任务 ID
    - deleteFile: 【用户输入】是否同时删除模型文件，默认 false

============================================================
### 模型训练 (9 个工具)
============================================================

**model_train_list_queues**
  获取可用于训练任务的队列列表（loadType=3）。返回队列 ID、资源池名称、算力型号。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**model_train_create_job**
  创建分布式训练任务。支持 PyTorch、TensorFlow、MPI 框架。

【必填参数】
- name: 任务名称（唯一）
- tasks: 任务角色配置列表
- queueId, resour
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - name*: 【用户输入】任务名称（唯一）
    - framework: 【用户输入】训练框架（pytorch/tensorflow/mpi），空值默认单机训练
    - jobType: 【用户输入】任务类型（train/custom/evaluate/tune），默认 custom
    - description: 【用户输入】任务描述
    - isPublic: 【用户输入】是否公开，默认 false
    - imageOrigin: 【用户输入】镜像来源（library=镜像库/address=自定义地址），默认 library
    - image: 【从 image_repo_list 获取】镜像地址（imageUsage=2）
    - imageVersionId: 【从 image_repo_list 获取】镜像版本 ID（imageUsage=2）
    - codePackageUri: 【用户输入】代码包存储路径（上传代码包后获取）
    - envs: 【用户输入】环境变量
    - ports: 【用户输入】暴露端口列表
    - outputPath: 【用户输入】训练输出路径
    - queueId*: 【从 model_train_list_queues 获取】队列 ID
    - resourcePoolEngName*: 【从 model_train_list_queues 获取】资源池英文名
    - computePowerModel*: 【从 model_train_list_queues 获取】算力型号
    - computePowerVirtual: 【用户输入】是否虚拟算力（true=vGPU/false=整卡），默认 false
    - gpuCountName*: 【从 model_train_list_queues 获取】GPU 资源名（如 nvidia.com
    - tensorboard: 【用户输入】是否开启 TensorBoard，默认 false
    - summary: 【用户输入】TensorBoard summary 路径（仅当 tensorboard=true 时
    - swanlab: 【用户输入】是否开启 SwanLab 监控，默认 false。需先调用 swanlab_start 
    - swanlabSummary: 【用户输入】SwanLab 日志路径（仅当 swanlab=true 时需要）
    - tasks*: 【用户输入】任务角色配置列表
    - dataList: 【重要】挂载数据集列表。训练代码从 dataMountPath 路径读取数据。需要先调用 datas
    - modelList: 【可选】挂载模型列表（用于加载预训练模型）。需要先调用 model_repo_list 和 mode

**model_train_list_jobs**
  获取训练任务列表。返回任务 ID、名称、状态、队列 ID、部署命名空间。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - pageNum: 页码，默认 1
    - pageSize: 每页数量，默认 9999
    - status: 任务状态筛选（可选）

**model_train_list_pods**
  获取训练任务的 Pod 列表，用于查看任务运行状态和日志。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_train_list_jobs 获取 taskId 字段】训练任务 ID（注意：使
    - namespace*: 【从 model_train_list_jobs 获取 deployNamespace 字段】命名空
    - queueId*: 【从 model_train_list_jobs 获取 queueId 字段】队列 ID

**model_train_get_directory**
  查询训练任务的输出目录，用于查看训练产物和模型文件。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_train_list_jobs 获取 taskId 字段】训练任务 ID（注意：使
    - path: 要查询的目录路径，默认为根目录 /
    - userId: 用户 ID（可选）

**model_train_stop_job**
  停止正在运行的训练任务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_train_list_jobs 获取】任务 ID（对应返回的 taskId 字段）
    - namespace*: 【从 model_train_list_jobs 获取】命名空间（对应返回的 deployNames
    - queueId*: 【从 model_train_list_jobs 获取】队列 ID

**model_train_delete_job**
  删除训练任务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - queueId*: 【从 model_train_list_jobs 获取】队列 ID
    - jobName*: 【从 model_train_list_jobs 获取】任务 ID（对应返回的 taskId 字段）
    - deployNamespace*: 【从 model_train_list_jobs 获取】部署命名空间
    - framework: 【从 model_train_list_jobs 获取】训练框架（pytorch/tensorflo

**model_train_get_logs**
  查看训练任务的运行日志。

【前置条件】
1. 已通过 model_train_create_job 创建训练任务
2. 已通过 model_train_list_jobs 获取 jobName, d
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_train_list_jobs 获取 taskId 字段】训练任务 ID（注意：使
    - namespace*: 【从 model_train_list_jobs 获取 deployNamespace 字段】命名空
    - queueId*: 【从 model_train_list_jobs 获取 queueId 字段】队列 ID
    - clusterName*: 【从 notebook_get_queue_detail 获取】集群名称
    - podName: 【从 model_train_list_pods 获取】Pod 名称（可选，不填则自动获取第一个 P
    - containerName: 【从 model_train_list_pods 获取】容器名称（可选，不填则自动获取第一个容器）
    - logTimeStart: 【用户输入】日志开始时间（ISO 格式，默认 24 小时前）
    - logTimeEnd: 【用户输入】日志结束时间（ISO 格式，默认当前时间）
    - pageSize: 【用户输入】每页日志条数，默认 500
    - scrollId: 【从上次查询结果获取】分页游标，用于获取更多日志

**model_train_get_events**
  查看训练任务的事件列表。

【前置条件】
1. 已通过 model_train_create_job 创建训练任务
2. 已通过 model_train_list_jobs 获取 name, depl
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - name*: 【从 model_train_list_jobs 获取 taskId 字段】训练任务 ID（注意：使
    - deployNamespace*: 【从 model_train_list_jobs 获取 deployNamespace 字段】部署命
    - framework: 【可选】训练框架（如 PyTorchJob、TensorFlowJob），默认 PyTorchJob
    - queueId*: 【从 model_train_list_jobs 获取 queueId 字段】队列 ID

============================================================
### 模型部署 (12 个工具)
============================================================

**model_deploy_list_queues**
  获取可用于部署推理服务的队列列表（loadType=2）。返回队列 ID、资源池名称、算力型号、空闲 GPU 数量。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**model_deploy_create_service**
  创建在线推理服务。需要先获取队列、模型、镜像列表供用户选择。支持大模型和小模型部署。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceName*: 【用户输入】服务名称
    - queueId*: 【从 model_deploy_list_queues 获取】队列 ID
    - resourcePoolEngName*: 【从 model_deploy_list_queues 获取】资源池英文名
    - computePowerModel*: 【从 model_deploy_list_queues 获取】算力型号
    - gpuCountName*: 【从 model_deploy_list_queues 获取】GPU 资源名
    - containers*: 容器配置列表
    - largeModel: 【用户输入】是否大模型，默认 true
    - replicas: 【用户输入】实例数量，默认 1
    - isPublic: 【用户输入】是否公开，默认 false

**model_deploy_list_services**
  获取在线服务列表（taskType=2）。返回服务 ID、名称、状态等信息，用于服务管理操作。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**model_deploy_get_service**
  获取服务详情。返回服务的完整配置信息，包括资源配置、模型信息等。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceId*: 【从 model_deploy_list_services 获取】服务 ID

**model_deploy_stop_service**
  停止在线服务。支持批量停止，停止后服务状态变为已停止。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceIds*: 【从 model_deploy_list_services 获取】服务 ID 列表，支持批量停止

**model_deploy_start_service**
  启动已停止的服务。支持批量启动，启动后服务状态变为运行中。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceIds*: 【从 model_deploy_list_services 获取】服务 ID 列表，支持批量启动

**model_deploy_delete_service**
  删除服务。删除后服务将不可恢复，请谨慎操作。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - ids*: 【从 model_deploy_list_services 获取】服务 ID（多个ID用逗号分隔）

**model_deploy_update_service**
  更新服务配置。可修改服务名称、资源配置、实例数量等。建议先调用 get_service 获取当前配置。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceId*: 【从 model_deploy_list_services 获取】服务 ID
    - serviceName: 【用户输入】服务名称（可选）
    - cpu: 【用户输入】CPU 核数（可选）
    - memory: 【用户输入】内存大小 GiB（可选）
    - gpuCount: 【用户输入】GPU 卡数（可选）
    - replicas: 【用户输入】实例数量（可选）
    - command: 【用户输入】启动命令（可选）

**model_deploy_restart_service**
  重启服务。用于应用新的配置或恢复异常状态。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - ids*: 【从 model_deploy_list_services 获取】服务 ID

**model_deploy_list_pods**
  获取在线服务的 Pod 列表，用于查看服务运行状态和日志。

【前置条件】
1. 已通过 model_deploy_create_service 创建服务
2. 已通过 model_deploy_li
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceId*: 【从 model_deploy_list_services 获取】服务 ID
    - namespace*: 【从 model_deploy_get_service 获取】命名空间
    - queueId*: 【从 model_deploy_list_services 获取】队列 ID

**model_deploy_get_logs**
  查看在线服务的运行日志。

【前置条件】
1. 已通过 model_deploy_create_service 创建服务
2. 已通过 model_deploy_list_services 获取 se
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceId*: 【从 model_deploy_list_services 获取】服务 ID
    - namespace*: 【从 model_deploy_get_service 获取】命名空间
    - queueId*: 【从 model_deploy_list_services 获取】队列 ID
    - clusterName*: 【从 model_deploy_get_service 或 notebook_get_queue_d
    - podName: 【从 model_deploy_list_pods 获取】Pod 名称（可选，不填则自动获取第一个 
    - containerName: 【从 model_deploy_list_pods 获取】容器名称（可选，不填则自动获取第一个容器）
    - logTimeStart: 【用户输入】日志开始时间（ISO 格式，默认 24 小时前）
    - logTimeEnd: 【用户输入】日志结束时间（ISO 格式，默认当前时间）
    - pageSize: 【用户输入】每页日志条数，默认 500
    - scrollId: 【从上次查询结果获取】分页游标，用于获取更多日志

**model_deploy_get_events**
  查看在线服务的事件列表。

【前置条件】
1. 已通过 model_deploy_create_service 创建服务
2. 已通过 model_deploy_list_services 获取 se
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceId*: 【从 model_deploy_list_services 获取】服务 ID

============================================================
### 模型评测 (9 个工具)
============================================================

**model_eval_list_queues**
  获取可用于评测任务的队列列表（loadType=2）。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**model_eval_list_services**
  获取运行中的模型服务列表（用于评测）。返回 serviceId 和 serviceName。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**model_eval_create**
  创建模型评测任务。支持通用指标评测和裁判员模型评测。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - name*: 【用户输入】评测任务名称
    - serviceId*: 【从 model_eval_list_services 获取】评测服务 ID
    - dataUri*: 【从 dataset_list 获取】数据集版本 URI
    - datasetId*: 【从 dataset_list 获取】数据集 ID
    - datasetVersionId*: 【从 dataset_list 获取】数据集版本 ID
    - cpu*: 【用户输入】CPU 核数
    - memory*: 【用户输入】内存(GiB)
    - queueId*: 【从 model_eval_list_queues 获取】队列 ID
    - resourcePoolEngName*: 【从 model_eval_list_queues 获取】资源池英文名
    - computePowerModel: 【从 model_eval_list_queues 获取】算力型号
    - gpuCount: 【用户输入】GPU 卡数
    - gpuCountName: 【从 model_eval_list_queues 获取】GPU 资源名
    - generalSupport: 【用户输入】是否启用通用指标评测，默认 true
    - judgeSupport: 【用户输入】是否启用裁判员模型评测，默认 false
    - description: 【用户输入】评测任务描述
    - inferenceArgInfo: 【用户输入】推理参数配置
    - judgeArgInfo: 【用户输入】裁判员模型配置（judgeSupport=true 时填写）

**model_eval_list_jobs**
  获取评测任务列表。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**model_eval_stop_job**
  停止评测任务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_eval_list_jobs 获取】任务名称
    - namespace*: 【从 model_eval_list_jobs 获取】命名空间
    - queueId*: 【从 model_eval_list_jobs 获取】队列 ID

**model_eval_delete_job**
  删除评测任务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - evaluationId*: 【从 model_eval_list_jobs 获取】评测任务 ID
    - namespace*: 【从 model_eval_list_jobs 获取】命名空间
    - queueId*: 【从 model_eval_list_jobs 获取】队列 ID

**model_eval_list_pods**
  获取评测任务的 Pod 列表，用于查看运行状态和日志。

【前置条件】
1. 已通过 model_eval_create 创建评测任务
2. 已通过 model_eval_list_jobs 获取 j
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_eval_list_jobs 获取】评测任务名称
    - namespace*: 【从 model_eval_list_jobs 获取】命名空间
    - queueId*: 【从 model_eval_list_jobs 获取】队列 ID

**model_eval_get_logs**
  查看评测任务的运行日志。

【前置条件】
1. 已通过 model_eval_create 创建评测任务
2. 已通过 model_eval_list_jobs 获取 jobName, namespa
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 model_eval_list_jobs 获取】评测任务名称
    - namespace*: 【从 model_eval_list_jobs 获取】命名空间
    - queueId*: 【从 model_eval_list_jobs 获取】队列 ID
    - clusterName*: 【从 notebook_get_queue_detail 获取】集群名称
    - podName: 【从 model_eval_list_pods 获取】Pod 名称（可选，不填则自动获取第一个 Po
    - containerName: 【从 model_eval_list_pods 获取】容器名称（可选，不填则自动获取第一个容器）
    - logTimeStart: 【用户输入】日志开始时间（ISO 格式，默认 24 小时前）
    - logTimeEnd: 【用户输入】日志结束时间（ISO 格式，默认当前时间）
    - pageSize: 【用户输入】每页日志条数，默认 500
    - scrollId: 【从上次查询结果获取】分页游标，用于获取更多日志

**model_eval_get_events**
  查看评测任务的事件列表。

【前置条件】
1. 已通过 model_eval_create 创建评测任务
2. 已通过 model_eval_list_jobs 获取 modelEvaluationI
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - modelEvaluationId*: 【从 model_eval_list_jobs 获取】评测任务 ID
    - queueId*: 【从 model_eval_list_jobs 获取】队列 ID
    - namespace*: 【从 model_eval_list_jobs 获取】命名空间

============================================================
### 批量推理 (7 个工具)
============================================================

**batch_inference_list_queues**
  获取可用于批量推理的队列列表（loadType=2）。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**batch_inference_create**
  创建离线批量推理任务。支持模型部署和镜像部署两种方式。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceName*: 【用户输入】服务名称
    - queueId*: 【从 batch_inference_list_queues 获取】队列 ID
    - resourcePoolEngName*: 【从 batch_inference_list_queues 获取】资源池英文名
    - computePowerModel*: 【从 batch_inference_list_queues 获取】算力型号
    - gpuCountName*: 【从 batch_inference_list_queues 获取】GPU 资源名
    - imageId*: 【从 image_repo_list 获取】镜像 ID（imageUsage=4）
    - imageVersionId*: 【从 image_repo_list 获取】镜像版本 ID
    - cpu: 【用户输入】CPU 核数，默认 4
    - memory: 【用户输入】内存(GiB)，默认 8
    - gpuCount: 【用户输入】GPU 卡数，默认 1
    - command*: 【用户输入】启动命令
    - modelOriginal*: 【用户输入】部署方式（1=模型部署，2=镜像部署）
    - modelId: 【从 model_repo_list 获取】模型 ID（仅 modelOriginal=1 时）
    - modelVersionId: 【从 model_repo_list 获取】模型版本 ID（仅 modelOriginal=1 时）
    - modelUri: 【从 model_repo_list 获取】模型 URI（仅 modelOriginal=1 时）
    - modelMountPath: 【用户输入】模型挂载路径（仅 modelOriginal=1 时）
    - isPublic: 【用户输入】是否公开，默认 false
    - timing: 【用户输入】是否计时，默认 false
    - computePowerVirtual: 【用户输入】是否虚拟算力，默认 false
    - outputPath: 【用户输入】输出路径（仅 modelOriginal=1 时）
    - runCommand: 【用户输入】运行命令（仅 modelOriginal=1 时）
    - runParams: 【用户输入】运行参数（仅 modelOriginal=1 时）
    - datasetList: 【用户输入】数据集列表（仅 modelOriginal=1 时）。可调用 dataset_list 

**batch_inference_list_jobs**
  获取批量推理任务列表。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**batch_inference_delete_job**
  删除批量推理任务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - ids*: 【从 batch_inference_list_jobs 获取】要删除的任务 ID，多个用逗号分隔

**batch_inference_stop_job**
  停止批量推理任务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - serviceIds*: 【从 batch_inference_list_jobs 获取】要停止的任务 ID 列表

**batch_inference_list_pods**
  获取批量推理任务的 Pod 列表，用于查看运行状态和日志。

【前置条件】
1. 已通过 batch_inference_create 创建任务
2. 已通过 batch_inference_list
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 batch_inference_list_jobs 获取】批量推理任务名称
    - namespace*: 【从 batch_inference_list_jobs 获取】命名空间
    - queueId*: 【从 batch_inference_list_jobs 获取】队列 ID

**batch_inference_get_logs**
  查看批量推理任务的运行日志。

【前置条件】
1. 已通过 batch_inference_create 创建任务
2. 已通过 batch_inference_list_jobs 获取 jobNam
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - jobName*: 【从 batch_inference_list_jobs 获取】批量推理任务名称
    - namespace*: 【从 batch_inference_list_jobs 获取】命名空间
    - queueId*: 【从 batch_inference_list_jobs 获取】队列 ID
    - clusterName*: 【从 notebook_get_queue_detail 获取】集群名称
    - podName: 【从 batch_inference_list_pods 获取】Pod 名称（可选，不填则自动获取第
    - containerName: 【从 batch_inference_list_pods 获取】容器名称（可选，不填则自动获取第一个
    - logTimeStart: 【用户输入】日志开始时间（ISO 格式，默认 24 小时前）
    - logTimeEnd: 【用户输入】日志结束时间（ISO 格式，默认当前时间）
    - pageSize: 【用户输入】每页日志条数，默认 500
    - scrollId: 【从上次查询结果获取】分页游标，用于获取更多日志

============================================================
### 镜像仓库 (10 个工具)
============================================================

**image_repo_list**
  获取镜像列表。可通过 imageName 按名称查找镜像（用于获取刚创建的镜像 ID），通过 imageUsage 过滤用途（1=notebook，2=训练，4=推理，5=评估）。返回镜像 ID、名称
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - imageUsage: 【用户输入】镜像用途过滤（1=notebook，2=训练，3=数据标注，4=推理，5=评估），可选
    - imageName: 【用户输入】镜像名称模糊查询（可选）
    - visibleRange: 【用户输入】可见范围：1=仅自己，2=租户内，3=公开（可选）
    - imageVersionStatus: 【用户输入】镜像版本状态过滤（using=使用中），可选，不传则不过滤
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页条数，默认 9999

**image_repo_create**
  创建新镜像。需要提供镜像名称、可见范围和用途列表。

【重要提示】创建成功后镜像版本数为 0，无法直接使用。需要继续调用 Harbor 相关 Tools 添加版本：
1. 调用 image_repo_
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - imageName*: 【用户输入】镜像名称
    - visibleRange*: 【用户输入】可见范围（1=仅自己，2=租户内，3=公开）
    - imageUsage*: 【用户输入】镜像用途列表（1=notebook，2=训练，4=推理，5=评估）
    - description: 【用户输入】镜像描述（可选）

**image_repo_list_versions**
  获取指定镜像的版本列表。返回版本 ID、版本名称、镜像地址等。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - imageId*: 【从 image_repo_list 获取】镜像 ID
    - queryImageInUse: 【用户输入】是否查询使用中的镜像，默认 true
    - status: 【用户输入】镜像状态过滤（可选）

**image_repo_delete**
  删除镜像。支持批量删除，删除后镜像及其所有版本将不可恢复。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - imagesIdList*: 【从 image_repo_list 获取】要删除的镜像 ID 列表，支持批量删除

**image_repo_delete_version**
  删除镜像的特定版本。需要提供镜像版本 ID。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - versionId*: 【从 image_repo_list_versions 获取】要删除的镜像版本 ID

**image_repo_get_detail**
  获取镜像详情。返回镜像的完整信息，包括版本数量、用途、可见范围等。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - imageId*: 【从 image_repo_list 获取】镜像 ID

**image_repo_list_harbor_namespaces**
  获取 Harbor 命名空间列表。

【使用场景】为镜像添加版本时，第一步需要选择 Harbor 命名空间。获取列表后请让用户确认选择。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**image_repo_list_harbor_repositories**
  获取指定 Harbor 命名空间下的镜像仓库列表。

【使用场景】为镜像添加版本时，第二步需要在选择的命名空间下选择仓库。需要先让用户确认命名空间后再调用此接口。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - namespaceId*: 【从 image_repo_list_harbor_namespaces 获取】命名空间 ID

**image_repo_list_harbor_tags**
  获取指定 Harbor 仓库的镜像标签列表。

【使用场景】为镜像添加版本时，第三步需要在选择的仓库下选择标签。需要先让用户确认仓库后再调用此接口。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - namespace*: 【从 image_repo_list_harbor_namespaces 获取】命名空间名称
    - repoName*: 【从 image_repo_list_harbor_repositories 获取】仓库名称（完整路

**image_repo_create_version**
  从 Harbor 创建镜像版本。

【前置条件】
1. 目标镜像已创建（imageId 可从 image_repo_list 获取，支持按 imageName 查找）
2. 已依次让用户确认 Harb
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - imageId*: 【从 image_repo_list 获取】目标镜像 ID
    - harborNamespace*: 【从 image_repo_list_harbor_namespaces 获取】Harbor 命名空
    - harborRepository*: 【从 image_repo_list_harbor_repositories 获取】Harbor 仓
    - harborTag*: 【从 image_repo_list_harbor_tags 获取】Harbor 镜像标签
    - harborSize*: 【从 image_repo_list_harbor_tags 获取】Harbor 镜像大小
    - imageVersion*: 【用户输入】版本名称
    - imageVersionDescription: 【用户输入】版本描述（可选）

============================================================
### Notebook (13 个工具)
============================================================

**notebook_list_queues**
  获取可用于 Notebook 开发环境的队列列表（loadType=1）。返回队列 ID、资源池名称、算力型号。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**notebook_create**
  创建 Notebook 开发环境。支持 VSCode 和 JupyterLab 开发工具。可挂载数据集和模型。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - noteBookName*: 【用户输入】Notebook 名称
    - queueId*: 【从 notebook_list_queues 获取】队列 ID
    - resourcePoolEngName*: 【从 notebook_list_queues 获取】资源池英文名
    - computePowerModel*: 【从 notebook_list_queues 获取】算力型号
    - gpuCountName*: 【从 notebook_list_queues 获取】GPU 资源名（如 nvidia.com/gp
    - imageId*: 【从 image_repo_list 获取】镜像 ID 列表（imageUsage=1）
    - imageVersionId*: 【从 image_repo_list 获取】镜像版本 ID
    - cpu: 【用户输入】CPU 核数，默认 4
    - memory: 【用户输入】内存(GiB)，默认 16
    - gpuCount: 【用户输入】GPU 卡数，默认 1。注意：判断是否使用 GPU 应检查 gpuCount > 0，而
    - computePowerVirtual: 【用户输入】是否虚拟算力，默认 false
    - emptyDir: 【用户输入】本地盘配额，默认 200
    - developTool: 【用户输入】开发工具（vscode/jupyter），默认 vscode
    - isPublic: 【用户输入】是否公开，默认 false
    - ports: 【用户输入】暴露端口列表，默认 [8000]
    - rdmaEnabled: 【用户输入】是否启用 RDMA，默认 false
    - description: 【用户输入】Notebook 描述
    - command: 【用户输入】启动命令
    - envs: 【用户输入】环境变量
    - outputPath: 【用户输入】训练输出路径
    - useSsh: 【用户输入】是否启用 SSH，默认 false
    - sshKey: 【用户输入】SSH 公钥（仅当 useSsh=true 时需要）
    - tensorboard: 【用户输入】是否启用 TensorBoard，默认 false
    - summary: 【用户输入】TensorBoard summary 路径（仅当 tensorboard=true 时
    - datasetList: 【用户输入】绑定数据集列表
    - modelList: 【用户输入】绑定模型列表

**notebook_list**
  获取 Notebook 列表。返回 Notebook ID、名称、状态、队列等信息。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - curPage: 【用户输入】当前页码，默认 1
    - pageSize: 【用户输入】每页数量，默认 9999

**notebook_get**
  获取 Notebook 详情。返回完整的 Notebook 配置信息。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - queueId*: 【从 notebook_list_queues 获取】队列 ID
    - noteBookId*: 【从 notebook_list 获取】Notebook ID
    - deployNamespace*: 【从 notebook_list 获取】部署命名空间

**notebook_update**
  更新 Notebook 配置。可修改名称、描述、CPU、内存、GPU 等配置。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - noteBookId*: 【从 notebook_list 获取】Notebook ID
    - queueId*: 【从 notebook_list 获取】队列 ID
    - deployNamespace*: 【从 notebook_list 获取】部署命名空间
    - noteBookName: 【用户输入】Notebook 名称（可选，不填则保持原值）
    - description: 【用户输入】Notebook 描述（可选）
    - cpu: 【用户输入】CPU 核数（可选，不填则保持原值）
    - memory: 【用户输入】内存(GiB)（可选，不填则保持原值）
    - gpuCount: 【用户输入】GPU 卡数（可选，不填则保持原值）。注意：判断是否使用 GPU 应检查 gpuCoun
    - ports: 【用户输入】暴露端口列表（可选，不填则保持原值）
    - developTool: 【用户输入】开发工具（可选，不填则保持原值）
    - datasetList: 【用户输入】绑定数据集列表（可选）
    - modelList: 【用户输入】绑定模型列表（可选）
    - envs: 【用户输入】环境变量（可选，不填则保持原值）
    - tensorboard: 【用户输入】是否启用 TensorBoard（可选）
    - rdmaEnabled: 【用户输入】是否启用 RDMA（可选）
    - isPublic: 【用户输入】是否公开（可选）

**notebook_stop**
  停止运行中的 Notebook。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - queueId*: 【从 notebook_list_queues 获取】队列 ID
    - noteBookId*: 【从 notebook_list 获取】Notebook ID
    - deployNamespace*: 【从 notebook_list 获取】部署命名空间

**notebook_start**
  启动已停止的 Notebook。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - queueId*: 【从 notebook_list_queues 获取】队列 ID
    - noteBookId*: 【从 notebook_list 获取】Notebook ID
    - deployNamespace*: 【从 notebook_list 获取】部署命名空间

**notebook_delete**
  删除 Notebook。删除后无法恢复。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - queueId*: 【从 notebook_list_queues 获取】队列 ID
    - noteBookId*: 【从 notebook_list 获取】Notebook ID
    - deployNamespace*: 【从 notebook_list 获取】部署命名空间

**notebook_get_directory**
  查询 Notebook 目录结构。返回指定路径下的文件和子目录列表。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - notebookName*: 【从 notebook_list 获取】Notebook 名称
    - path: 【用户输入】查询路径，默认根目录 /
    - userId: 【可选】用户 ID

**notebook_get_logs**
  查询 Notebook 日志。支持按时间范围查询和分页。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - noteBookId*: 【从 notebook_list 获取】Notebook ID
    - id*: 【用户输入】日志查询 ID（Notebook ID 或 Pod ID）
    - clusterName*: 【从 notebook_list 或 notebook_get 获取】集群名称
    - namespace*: 【从 notebook_list 或 notebook_get 获取】命名空间
    - pod: 【可选】Pod 名称
    - pageSize: 【用户输入】日志条数，默认 100
    - logTimeStart: 【用户输入】日志开始时间（ISO 格式，默认 24 小时前）
    - logTimeEnd: 【用户输入】日志结束时间（ISO 格式，默认当前时间）
    - scrollId: 【从上次查询结果获取】分页游标，用于获取更多日志

**notebook_get_queue_detail**
  获取队列详情。返回队列的资源池、算力型号、配额等信息。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - id*: 【从 notebook_list_queues 获取】队列 ID

**notebook_list_pods**
  获取 Notebook 的 Pod 列表，用于查看运行状态和日志。

【前置条件】
1. 已通过 notebook_create 创建 Notebook
2. 已通过 notebook_list 或 
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - notebookName*: 【从 notebook_list 或 notebook_get 获取】Notebook 名称
    - namespace*: 【从 notebook_list 或 notebook_get 获取】命名空间
    - queueId*: 【从 notebook_list 获取】队列 ID

**notebook_get_events**
  查看 Notebook 的事件列表。

【前置条件】
1. 已通过 notebook_create 创建 Notebook
2. 已通过 notebook_list 获取 queueId, noteb
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - queueId*: 【从 notebook_list 获取】队列 ID
    - notebookId*: 【从 notebook_list 获取】Notebook ID
    - deployNamespace*: 【从 notebook_list 或 notebook_get 获取】部署命名空间

============================================================
### SFTP (3 个工具)
============================================================

**sftp_start**
  开启 SFTP 文件传输通道，获取连接信息。

适用场景：
- 需要上传大于 500MB 的大文件到平台存储
- 需要通过 SFTP 客户端传输数据或模型

返回的连接信息包括：
- account:
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**sftp_list_files**
  查看 SFTP 上传目录中的文件列表。

适用场景：
- 确认文件是否成功上传到平台
- 查看上传文件的名称和大小
- 浏览多级目录查找目标文件

返回信息：
- fileName: 文件名
- fo
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID
    - path: 【用户输入】要查看的目录路径。不传查看根目录。如看到 folder=true 的文件夹（如 uplo

**sftp_stop**
  关闭 SFTP 文件传输通道。

适用场景：
- SFTP 文件传输完成后关闭通道
- 释放 SFTP 服务资源

注意：传输完成后请及时关闭通道，避免资源浪费。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

============================================================
### SwanLab (2 个工具)
============================================================

**swanlab_start**
  启动 SwanLab 服务。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

**swanlab_status**
  查询 SwanLab 服务状态。返回 status、url、errorMsg。
  参数:
    - token*: 【从 auth_login 获取】用户鉴权 Token
    - tenantId*: 【从 auth_list_tenants 获取】租户 ID

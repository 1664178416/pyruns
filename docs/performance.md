# 文件系统性能测量

任务很多或工作区位于 NFS 时，可以在源码仓库运行分项基准，区分首次列表、目录发现、
元数据、配置正文、刷新和日志搜索的成本。先安装项目依赖，选择要测量的文件系统上一个
**已经存在的目录**：

```bash
python scripts/benchmark_workspace_io.py \
  --temp-root /mnt/nfs/benchmarks \
  --tasks 1000 --samples 5 --log-kib 4 \
  --output /tmp/pyruns-nfs.json
```

`--temp-root` 选择夹具所在文件系统；报告可以保存在本地。工具只在该目录下新建
`pyruns-workspace-io-*` 隔离目录，不打开现有工作区，不运行任务，也不接管调度。
成功后核验目录身份和所有权标记再清理；失败时保留隔离目录，报告中的
`temporary_directory` 给出位置，检查后可手动删除。Windows 也支持同一组参数，将路径
换成对应挂载目录；脚本启动的 Git 和 ripgrep 子进程均隐藏窗口。

报告中的 `filesystem.type`、`mountpoint`、`options` 说明系统识别到的挂载信息，
只有类型为 `nfs` 或 `nfs4` 时 `is_nfs` 才为 `true`。本地 ext4、NTFS 或 WSL 的
Windows 盘访问结果不能当作 NFS 性能。部分网络盘无法由系统接口识别，类型为空时需
在运行机器上核实挂载信息。

每项操作记录全部耗时样本、中位数和最大值；Python I/O 计数用额外一次操作单独观测，
避免计数开销进入耗时。各阶段有独立含义：

| 阶段 | 测量内容 |
| --- | --- |
| `new_runtime_first_list` | 新建 runtime 后读取第一页，包括目录发现、任务加载和列表构建 |
| `directory_discovery` | 枚举任务目录并获取排序所需的目录时间 |
| `metadata_read_parse` | 读取和解析所有任务元数据，包含路径校验 |
| `payload_read_parse` | 读取和解析所有配置正文，包含路径校验 |
| `warm_summary_list` | 从已有任务快照返回第一页，不主动刷新磁盘 |
| `metadata_refresh` | 对未变化的全部任务检查元数据属性，跳过正文探测 |
| `payload_refresh` | 对未变化的全部任务检查元数据和配置正文签名 |
| `forced_list_refresh` | 强制目录校对和正文检查后返回列表 |
| `log_search_new_cache` | 清空 Pyruns 日志匹配缓存后搜索，调用生产环境 ripgrep 流程 |
| `log_search_reuse_cache` | 重复相同搜索，保留有界匹配缓存；超出缓存容量时仍可能读取日志 |

`stat`、`lstat`、`realpath`、`scandir` 及 `direntry_*` 是夹具路径内的 **Python 调用次数**。
例如一次 `DirEntry.stat()` 可能直接复用目录枚举数据，一次 `realpath()` 又可能引起多次
`lstat()`；不能相加后当成系统调用数。`metadata_bytes`、`payload_bytes` 是有限读取函数
实际返回的字节数，包括重复读取。`ripgrep_launches` 只统计启动次数，子进程内部的
文件读取、内核系统调用、磁盘传输和 NFS RPC 均不在这些数字内。

“新 runtime”只重置 Pyruns 缓存。夹具刚刚写入，系统、NFS 客户端和服务器缓存均可能
命中；工具不会清空系统缓存。重复运行、换挂载方式或换机器时，应一起保留报告中的
缓存说明、提交、平台和挂载信息。当前使用完整性和资源清理作为失败门槛，不设跨机器
统一的耗时阈值。

已有的 `scripts/benchmark_scaling.py` 继续覆盖真实 ASGI 请求、内存与长指标历史读写；
这项工具补充分阶段的文件访问观测，方便判断下一步应优化目录扫描、校验、解析还是搜索。

# API 参考

本文分两部分：

- 用户脚本可直接调用的 Python API
- Web UI 使用的 FastAPI 接口概览

## Python API

```python
import pyruns
```

### `pyruns.read(file_path=None)`

读取配置文件并初始化全局配置对象。

查找顺序：

1. 环境变量 `__PYRUNS_CONFIG__`
2. 显式传入的 `file_path`
3. `_pyruns_/<script>/config_default.yaml`

适用场景：

- 配置任务
- 直接在脚本里手动加载 YAML / JSON

注意：

- shell 任务不会设置 `__PYRUNS_CONFIG__`

示例：

```python
import pyruns

pyruns.read()
cfg = pyruns.load()
```

### `pyruns.load()`

返回 OmegaConf 的 `DictConfig` 或 `ListConfig`。

示例：

```python
cfg = pyruns.load()
print(cfg.lr)
print(cfg.model.name)
```

需要转换为普通 Python 字典或列表时，使用 OmegaConf 官方 API：

```python
from omegaconf import OmegaConf

data = OmegaConf.to_container(cfg, resolve=True)
```

### `pyruns.record(data=None, **kwargs)`

把当前运行的一次记录写入 `task_info.json["records"]`。

示例：

```python
pyruns.record(loss=0.31, acc=91.2)
```

特点：

- 同一次运行会合并到当前 run slot
- 在非 Pyruns 环境下会静默返回
- 持久化失败会在任务日志中输出一次去重 warning，但不会终止用户实验

### `pyruns.track(key=None, value=None, **kwargs)`

向当前运行的指标序列追加数据，每次调用在成功持久化后返回；失败时的行为见下文说明。

示例：

```python
pyruns.track(loss=0.8)
pyruns.track(loss=0.6)
pyruns.track("acc", 0.91)
```

少量数据保存在 `task_info.json["tracks"]`。累计达到 1,024 个指标值或约 256 KiB
曲线 JSON 时，自动迁移到任务目录的 `tracks.sqlite3`，后续调用只追加新数据。
旧工作区无需手动迁移，`load_task_info()`、CLI `show` 和默认任务详情 API 仍返回完整曲线。
任务状态、`record()` 和摘要列表查询不会读取大曲线。

Web UI 的详情和任务操作请求使用 `include_tracks=false`，跳过当前界面不展示的曲线数据；
配置、记录、环境和运行历史仍完整返回。该参数只影响响应读取，不会修改已保存的指标。
普通 API 请求默认包含完整曲线。

持久化失败会输出去重 warning，不会终止实验。单次追加最多 16 MiB；
NaN 和 Infinity 不受支持。完整详情仍需读取全部历史，耗时和内存随曲线长度增加。
大曲线会分批读取，在解析数据时允许继续追加指标；单次读取只包含读取开始时已有的点。

多个进程同时向同一任务调用 `track()` 或 `record()` 时，会排队取得写入锁。
文件锁默认等待上限为 5 秒；若超时，本次写入失败并输出上述 warning。
任务目录所在文件系统必须支持原生文件锁；共享存储必须启用跨客户端锁。
不支持锁时会明确报告写入失败。任务目录中的 `.task_info.json.lock.guard`
是可重复使用的锁文件，保留该文件属于正常行为，使用期间不要删除。
同时写入同一任务的进程应使用相同升级版本。Windows/WSL 等不同运行时域可以正常交接，
但跨域崩溃遗留锁须回原运行时恢复。旧版或未知域的遗留锁不会被自动抢占；
超时信息会说明恢复方法，手动清理前须确认所有写入者已停止。

重命名或移入回收站会先等待已取得写入锁的指标事务完成。目录进入迁移阶段后，
`record()`、`track()` 和 `track_many()` 对旧目录的新写入会明确警告并放弃本次数据，
不会在迁移中的目录打开指标事务。移动任务前应先等待全部指标写入进程结束；
已继承旧任务路径的后台进程不会自动切换到新路径。

新版调度器会自动向子进程传递本次运行的独立标识；SDK 在写入锁内核对该运行的归属。
旧目录被同名新任务复用时，旧进程的记录与指标写入会警告并放弃，避免污染新任务。
同一任务已完成运行的后台写入仍归入原运行槽位；无需手动设置标识。
升级前已启动且未携带标识的进程沿用旧行为，应先结束这些进程再移动任务或复用名称。

### `pyruns.track_many(points)`

按输入顺序追加一批指标点，成功时整批持久化后返回。每项是指标名到数值的字典，
指标名必须是字符串，不同点可以包含不同指标。批量写入减少取得写入锁和提交到磁盘的次数，
适合高频指标或已经收集好的数据。逐次调用 `track()` 仍会逐次提交。

```python
pyruns.track_many([
    {"step": 1, "loss": 0.8},
    {"step": 2, "loss": 0.6},
    {"step": 3, "loss": 0.4, "acc": 0.91},
])
```

支持列表和迭代器，最多 1,024 个输入点，编码后的载荷合计最多 16 MiB。空字典会跳过，
空批次不写入。所有点在写入前完成校验和快照；非法项、迭代异常、超限、NaN 或 Infinity
会使整批不写入，并输出去重 warning。存储失败同样输出 warning，不会终止实验。
非 Pyruns 环境下静默返回，不消费迭代器。

本接口不会在后台积攒数据；调用方尚未交给 `track_many()` 的点仍由调用方保存。
同一批次的点一起提交，读取端不会看到批次的一部分。首次向新运行写入时，失败可能留下
一个已预留的空运行槽位，与 `track()` 的行为相同。

任务的 `completed` 状态表示被执行程序成功退出，并不证明每一次指标或记录写入都成功。
检查实验结果时还应检查任务日志中的持久化 warning；这些警告不会把退出码为 0 的任务改为失败。

### `pyruns.get_task_dir()`

返回当前任务目录；如果不在 Pyruns 环境里返回 `None`。

### `pyruns.get_run_index()`

返回当前运行槽位；如果不在 Pyruns 环境里返回 `None`。

### `pyruns.artifact_dir()`

返回当前 run 的文件输出目录，并自动创建目录。

目录固定为：

```text
<task_dir>/artifacts/runN
```

如果不在 Pyruns 任务环境里，则使用当前工作目录下的 `artifacts/run1`。

新版任务调用此接口时会核对运行归属；目录已被其他任务复用则抛出 `RuntimeError`。
返回路径后，调用方仍应在任务移动前结束文件写入，已取得的路径不会自动跟随任务改名。

示例：

```python
import os

artifact_dir = pyruns.artifact_dir()
metrics_path = os.path.join(artifact_dir, "metrics.json")
with open(metrics_path, "w", encoding="utf-8") as f:
    f.write("{}")
```

## Web API 概览

这些接口是本机 Web UI 的内部控制面，不是公开远程 API。服务只监听 loopback；每次
`pyr ui` 启动会生成随机令牌，首个 tokenized URL 请求将其交换为 `HttpOnly`、
`SameSite=Strict` 的持久会话 cookie。该会话会在使用时续期，并在同一主机、端口和
工作区的 UI 更新或重启后继续有效。所有 `/api` HTTP 与 WebSocket 请求都必须携带该
会话。请求体、分页、批量任务数、环境变量数和日志读取量都有硬上限。

主入口：

- `GET /api/workspace`
- `POST /api/workspace/run-root`
- `POST /api/workspace/shell`

### Workspace

#### `GET /api/workspace`

返回当前工作区：

```json
{
  "run_root": ".../_pyruns_/main",
  "script_name": "main",
  "script_path": "D:/project/main.py",
  "workspace_kind": "script",
  "workspace_ready": true
}
```

#### `POST /api/workspace/shell`

切换并初始化 shell workspace。

返回：

```json
{
  "run_root": ".../_pyruns_/_shell_",
  "script_name": "_shell_",
  "script_path": "",
  "workspace_kind": "shell"
}
```

### Generator

#### `POST /api/generator/preview`

脚本工作区：

- `mode = "form"`：做 batch 预览
- `mode = "yaml"`：预览单任务

shell 工作区：

- `mode = "shell"`：预览单个 shell 任务

#### `POST /api/generator/create`

请求体字段：

- `name_prefix`
- `mode`
- `yaml_text`
- `shell_text`
- `template_value`
- `append_timestamp`

返回中包含：

- `count`
- `items`
- `task_kind`

### Tasks

#### `GET /api/tasks`

分页获取任务列表。

首次加载后，`refresh=true` 复用工作区共享的刷新结果，完整校验最短间隔为 4 秒；`refresh=false` 使用当前任务快照。实时订阅约每秒校对活动任务，每 4 秒发现任务目录，每 30 秒校对历史任务内容；已知变更按任务失效并及时校对。并发刷新合并，间隔从扫描完成后计算；手动刷新可传 `force_refresh=true` 立即完整校验。

#### `GET /api/tasks/{task_name}`

获取单个任务详情。`summary=true` 仅获取任务摘要，不加载历史曲线；适用于只需状态的轮询。默认返回完整详情，`refresh=false` 可复用当前任务快照。

任务摘要和详情中的 `task_identity` 是不透明的任务身份；编辑客户端应在载入草稿时保留它。

#### `GET /api/tasks/{task_name}/runs/{run_index}/input`

按需读取一次运行在启动前保存的输入。返回 `schema_version: 1`、任务名、运行编号和 `input`；旧运行没有快照时 `input` 为 `null`，不存在的任务或运行返回 404。普通任务列表不附带历史正文。

#### `GET /api/tasks/{task_name}/runs/{run_index}/diff?other_run=RUN`

比较同一任务的两次历史输入，返回 `schema_version: 1`、`available`、`equal`、`changed_fields` 和 unified diff。缺少快照时 `available=false`、`equal=null`；不读取曲线数据。

`equal` 和 `changed_fields` 始终比较完整输入，保留 JSON 类型差异。diff 使用按行 Myers 算法和计算预算，复杂文本可能显示较大的改动块。
展示最多 256 KiB 或 4000 行；`truncated=true` 表示仅返回部分 diff，不能作为完整补丁使用。
完整输入可通过上面的 `/input` 接口或 `pyr show TASK@RUN --json` 获取。

#### `GET /api/tasks/{task_name}/runs/{run_index}/compare?other_run=RUN&other_task=TASK`

比较同一工作区中任意两次运行。`other_task` 省略时使用当前任务；`other_run` 指定基准运行。
返回 `schema_version: 1`、基准 `left`、当前 `right` 和 `input_diff`。两侧包含运行引用、状态、
起止时间、耗时、退出码、汇总记录 `record`、Git 来源 `source_state`、运行环境 `environment`
和输入是否存在的 `input_available`。

`metric_rows` 提供汇总指标的两侧显示文本、`changed` 和字符串差值 `delta`（不可计算时为 `null`），
避免浏览器舍入大整数后误判相同；原始 `record` 字段保留。

缺少输入快照不影响其余信息比较；不存在的任务或运行返回 404。只读取运行元数据与所选输入，
不读取训练曲线；两侧分别取得快照，正在运行的指标可能继续变化。

#### `POST /api/tasks/{task_name}/run`

运行单个任务。

#### `POST /api/tasks/{task_name}/cancel`

停止单个任务。

#### `POST /api/tasks/{task_name}/pin`

pin / unpin 任务。

#### `PATCH /api/tasks/{task_name}/notes`

更新 notes。请求必须同时提交编辑时读到的 `expected_notes`：

```json
{
  "notes": "needs review",
  "expected_notes": ""
}
```

如果 notes 已被其他客户端修改，接口返回 `409 Conflict` 且不覆盖新内容。

Notes 和 Env 更新还应提交草稿载入时的 `expected_task_identity`（来自 `task_identity`）。
原任务改名、移走后即使出现同名新任务且字段值相同，也会返回 `409`，避免写错对象。
该字段对旧客户端可选；新版 Web UI 自动携带。

#### `PATCH /api/tasks/{task_name}/env`

更新任务环境变量。请求必须同时提交编辑时读到的完整 `expected_env`：

```json
{
  "env": {"CUDA_VISIBLE_DEVICES": "0"},
  "expected_env": {}
}
```

如果环境变量已被其他客户端修改，接口返回 `409 Conflict` 且保留磁盘上的新内容。

#### `POST /api/tasks/{task_name}/rename`

重命名任务。操作期间若目录身份或操作归属发生变化，会中止并保留其他任务的目录和元数据。

如果失败回滚时原路径已被占用，或重命名后的目录已被替换、接管，接口返回 `400`，错误包含 `rollback incomplete`。此时请先核对原路径和目标路径中的任务，再决定后续操作。

### Logs

#### `GET /api/tasks/{task_name}/logs`

读取某个日志文件的历史内容。

`tail_lines=0` 只取得当前文件末尾游标，不读取正文。`log_identity` 与 `offset` 可用于安全续读；文件替换或截断时返回 `reset`。

#### `GET /api/tasks/{task_name}/logs/download`

通过 `log_file_name` 指定完整原始日志，可附带 `log_identity` 和 `expected_workspace` 防止下载到已替换的文件或其他工作区；不匹配返回 `409`。与其他 API 一样需要有效 UI 会话。

响应以 `任务名--日志名` 下载，包含 `X-Pyruns-Log-Identity`，按打开时文件大小分块读取；下载期间追加的输出不包含在本次文件中。使用已经校验的普通文件句柄，不支持 Range 续传（`Accept-Ranges: none`）。

#### `WS /api/tasks/{task_name}/logs/stream`

订阅日志增量。

成功读取日志状态后发送 `ready`；正常静默时发送健康 `heartbeat`。连续读取失败发送带 `detail` 的 `error`，随后以 `1013` 关闭，客户端可退避重连并使用增量 HTTP 读取。`chunk` 和 `reset` 含续读所需的 `offset`、`log_identity` 和 `log_file_name`。

消息示例：

```json
{
  "type": "chunk",
  "task_name": "task_001",
  "content": "epoch 1 done\n"
}
```

### Launcher

- `GET /api/launcher/scripts`
- `GET /api/launcher/configs`
- `GET /api/launcher/workspaces`
- `POST /api/launcher/open`
- `POST /api/launcher/pick-script`

用于启动器中的脚本发现、配置发现和工作区打开。

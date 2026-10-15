# pyruns

![logo](https://raw.githubusercontent.com/LthreeC/pyruns/main/docs/assets/pyruns_logo2.png)

English | [简体中文](README.md)

[![PyPI version](https://img.shields.io/pypi/v/pyruns.svg)](https://pypi.org/project/pyruns/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyruns.svg)](https://pypi.org/project/pyruns/)
[![License](https://img.shields.io/pypi/l/pyruns.svg)](https://github.com/LthreeC/pyruns/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-2563eb.svg)](https://lthreec.github.io/pyruns/)

Pyruns is a disk-first runner for reproducible experiments and terminal workloads. It stores commands, configurations, logs, environments, run history, and metrics under the project's `_pyruns_` directory, then exposes them through a Git-style one-shot CLI and an optional Web UI.

![Generator](https://raw.githubusercontent.com/LthreeC/pyruns/main/docs/assets/tab_generator.png)

## Start in 30 seconds

Command examples use Linux/Bash. On other platforms, adapt quoting, variables, continuations,
paths, and stdin syntax to your shell; see `pyr exec --help` or the
[platform notes](docs/cli-guide.md#exec-platform-notes).

```bash
pip install pyruns

# Examples use short `pyr`; `pyruns` is identical
pyr --help

# Run and track one command; the shell workspace is created automatically
pyr exec -n smoke -c "python -V"

# Inspect the result
pyr ls
pyr show smoke
pyr log smoke

# Rerun the same saved task and keep a new numbered run
pyr run smoke
```

A task is a saved, repeatable object. Each `run` adds numbered history instead of replacing earlier logs.

When you do not need to reference the task by name immediately, omit the naming option and
Pyruns generates `task_YYYY-MM-DD_HH-MM-SS`. Use `-nt` to keep a semantic prefix and append
the timestamp automatically:

```bash
pyr exec -c "python -V"
pyr exec -nt smoke -c "python -V"  # smoke_YYYY-MM-DD_HH-MM-SS
```

`-n smoke` still means the exact name `smoke`, so `-n` and `-nt` are mutually exclusive.

Detach long-running work, then control it with separate commands:

```bash
pyr exec -n train -d -c "python train.py --epochs 100"
pyr status
pyr wait train
pyr log train
```

Ctrl+C during foreground `exec` or `run` requests cancellation of tasks submitted by that command. Ctrl+C during `wait` or `log -f`, and `wait --timeout`, stop observing only; tasks keep running. Use `pyr stop TASK` to stop existing work.

Start the Web UI explicitly when needed:

```bash
pyr ui
pyr ui train.py
pyr ui shell
```

`pyr` and `pyruns` are identical official entrypoints: the former is faster to type, while the latter makes the project name explicit. Use `pyr --help` for all commands and their purposes, and `pyr COMMAND --help` for options, examples, and notes. Neither starts a stateful interactive REPL.

## Why it is useful

- Every task has a stable directory instead of disappearing into terminal scrollback.
- Commands, arguments, environment variables, logs, metrics, and artifacts stay together.
- Shell commands and Python configuration experiments share one lifecycle.
- `--gpu-wait` starts work automatically when the requested GPUs meet free-memory and idle thresholds.
- One command performs one operation, making the same interface useful to people, scripts, CI, and AI agents.
- Foreground execution returns the real task result; a batch returns non-zero if any task fails.
- Detached runners outlive the invoking terminal and do not open extra console windows on Windows.
- The CLI and Web UI share the same disk state.

![Home](https://raw.githubusercontent.com/LthreeC/pyruns/main/docs/assets/tab_home.png)

## Run automatically when GPUs are free

Both `exec` and `run` accept `--gpu-wait` with all five startup fields in order:

```text
COUNT-FREE_GIB-IDLE_PERCENT-STABLE_SECONDS-TIMEOUT_HOURS
```

```bash
pyr exec -n gpu-train -d --gpu-wait 2-20-70-15-2 -c "python train.py"
# Save a complete multiline script and run it after GPUs become available
pyr exec -nt gpu-pipeline -d --gpu-wait 1-8-70-15-2 --stdin < pipeline.sh
```

`2-20-70-15-2` requires two GPUs, each with at least **20 GiB free** and **70% idle**,
qualifying together for **15 seconds**, with at most **2 hours** of queueing.
Idle percent is `100 - GPU utilization`; the timeout does not limit command runtime.
All five fields are required; trailing fields cannot be omitted.
`-d` detaches both waiting and execution.

The CLI rule applies only to this invocation and does not become a task default.
Pass it again on a rerun, or omit it to use the default GPU settings saved through the UI or project configuration.
Inspect this run's rule and waiting state with
`pyr show gpu-train`, or current GPU metrics with `pyr metrics`.
See the [CLI guide](docs/cli-guide.md) or `pyr exec --help` for device selection and units.

## Git-style CLI

```text
pyr [GLOBAL OPTIONS] COMMAND [COMMAND OPTIONS]
```

Context options must appear before the command:

```text
-C, --directory PATH
-w, --workspace NAME|PATH|SCRIPT.py
--debug
--version
```

Command options appear after the command. The common forms are easier to read separately:

```text
pyr -C path/to/project ls             # discover a project from another directory
pyr -w train ls --json                # select a workspace; --json belongs to ls
pyr ui shell -p 8099                  # -p/--port belongs only to ui/dev
pyr exec -n check -c "python -V"  # complete command string after -c
```

Use `-w` only to disambiguate task commands such as `ls`, `run`, `show`, and `log` when a project has several workspaces; omit it when only one workspace exists. `exec` always targets the shell workspace, while the Web UI takes its target directly: `pyr ui shell`, `pyr ui train`, or `pyr ui train.py`; do not write `pyr -w shell ui`. `ui` / `dev` also expose `-p, --port`, `--browser`, and `--no-browser`, all after the command. `--json` is not global: append it only to a command that advertises machine output, such as `pyr status --json`.

Keep one hierarchy in mind: `project -> workspace -> task -> run`. A project owns `_pyruns_`; a workspace groups related tasks; a task has an exact name; every execution creates a numbered run.

Commands:

| Command | Purpose |
| --- | --- |
| `init` | initialize a shell or Python script workspace |
| `exec` | create and run one tracked terminal command or shell script |
| `add` | add immutable task snapshots from YAML |
| `run` | run exact tasks, or create and run them from YAML |
| `ls` | filter and sort tasks deterministically |
| `status` | summarize one workspace |
| `show` | show task metadata and paths |
| `log` | print, follow, or locate logs |
| `wait` | wait for already active tasks |
| `stop` | ask the owning runner to stop tasks; normal stops become `cancelled`, while stale tasks may become `failed` |
| `rm` / `restore` | soft-delete and restore tasks |
| `mv` / `pin` | manage task names and pinned state |
| `export` | export CSV or JSON records |
| `config` | inspect and update project settings |
| `metrics` | print one CPU, memory, and GPU snapshot |
| `ui` / `dev` | start the Web UI explicitly |
| `help` | show top-level or command help |

Every command has its own scenario-oriented help. For example, `pyr exec --help`
explains `-c`, `--stdin`, script execution, and persisted environment
values. See the [complete CLI guide](docs/cli-guide.md) for every option and contract.

## Two workspace types

### Shell Workspace

Use it for arbitrary terminal commands, repository reproduction, installation, preprocessing, training, evaluation, and pipelines. An omitted name becomes `task_YYYY-MM-DD_HH-MM-SS`; `-nt PREFIX` appends a timestamp; `-n NAME` uses an exact name:

```bash
pyr init
pyr exec -c "python -V"
pyr exec -nt env-check -c "python -V"
pyr exec -n env-check -c "python -V"
pyr exec -n install -c "python -m pip install -r requirements.txt"
pyr exec -n baseline -d -c "python train.py --config baseline.yaml"
```

Include the interpreter in the complete command when running an existing script:

```bash
pyr exec -n setup -c "bash ./scripts/setup.sh"
```

`exec` accepts two inputs: `-c "COMPLETE COMMAND"` and `--stdin`. The first saves the command
and reads the original script file again on reruns; the second saves the full script text.
Use `-c` / `--command` for ordinary programs, pipes, redirects, expansion, globs, or chaining:

```bash
pyr exec -n report -c "python eval.py > metrics.txt"
```

`-c` accepts one quoted command string. Pyruns options may appear before or after it, for example
`pyr exec -c "python train.py --epochs 10" -n train -d`; keep the program's options inside the quotes.
For the legacy unquoted form `-c echo hello`, place Pyruns options before `-c`.
Follow the calling shell's quoting rules to preserve variables and shell syntax. Use `--stdin`
for complex or multiline scripts.

To record a complete existing script, run this in Bash:

```bash
pyr exec -nt pipeline -d --stdin < pipeline.sh
```

This saves the entire script as one timestamped task and runs it in the background. Reruns use
the saved text. Run `pyr exec --help` for complete usage and record verification steps.
A quoted heredoc can submit multiline text directly:

```bash
pyr exec -n pipeline -d --stdin <<'BASH'
set -euo pipefail
python preprocess.py
python train.py --epochs 10
BASH
```

The complete UTF-8 script is saved with the task, so reruns use the captured text. `--stdin` must
receive redirected input and cannot be combined with `-c`.

Shell tasks preserve terminal colors through a cross-platform pseudoterminal: Linux and macOS use the system PTY; Windows uses native ConPTY when a console is already attached. Without an attached Windows console, Pyruns uses hidden stdout/stderr pipes to avoid opening a console window; colors may be lost. Captured SGR colors are stored and replayed; screen clearing, cursor positioning, and window-title controls are filtered.

`exec` always uses `<current-directory>/_pyruns_/_shell_`; it does not reuse a parent directory's shell workspace. The start banner and source state are written before command output is copied into the log. Source collection runs concurrently with the child process; stdout/stderr is continuously drained into a disk-backed buffer without sleeps or child-process blocking.

Use one `-e` followed by multiple `KEY=VALUE` entries, then `-c` for the complete command.
Repeating `-e` remains supported. Use a UTF-8 env file for larger sets:

```bash
pyr exec -n train -e CUDA_VISIBLE_DEVICES=0 TOKENIZERS_PARALLELISM=false SEED=42 -c "python train.py"
pyr exec -n train --env-file .env.train -e SEED=42 -c "python train.py"
```

Pyruns already sets `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, and `PYTHONUTF8=1` for child processes. In a POSIX shell, `CUDA_VISIBLE_DEVICES=0 pyr exec ...` also reaches the child for that invocation, but it is not persisted in task metadata and is not guaranteed on a later `pyr run`, Web UI run, or invocation from another terminal. Use `-e` or `--env-file` for reproducible values visible in `show`.

`--env-file` is repeatable; later files override earlier files and command-line `-e` values override all files. Files accept blank lines, whole-line `#` comments, and `KEY=VALUE` only. Values are persisted in task metadata, so do not store secrets there.

Preview an execution with no filesystem or process side effects; append `--json` for a strict,
versioned plan object:

```bash
pyr exec --dry-run -n report -c "python eval.py"
pyr exec --dry-run -n report --json -c "python eval.py"
```

The preview does not create `_pyruns_`, tasks, or settings files, and it does not start the user command. `--dry-run` and `--detach` are mutually exclusive.

```text
<project>/_pyruns_/_shell_/tasks/<task>/
├── task_info.json
├── config.sh | config.ps1 | config.cmd
└── run_logs/runN.log
```

### Script Workspace

Use it for `argparse`, `pyruns.load()`, YAML configuration, batch expansion, and parameterized experiments:

```bash
pyr init train.py
pyr -w train add configs/quick.yaml
pyr -w train run quick
pyr -w train run --config configs/sweep.yaml -n sweep -j 4
pyr -w train run --config configs/sweep.yaml -n sweep -j 4 --dry-run
```

`run --config ... --dry-run` validates the YAML and lists expanded task candidates without creating or running them.

```text
<project>/_pyruns_/train/tasks/<task>/
├── task_info.json
├── config.yaml
├── run_logs/runN.log
└── artifacts/runN/
```

## Workspace selection

Inspection and management commands walk from the current directory toward its parents to find the nearest `_pyruns_`. They select the workspace automatically only when exactly one exists. Multiple workspaces require `-w`. `exec` is the exception: without an explicit workspace path, it always uses the current directory's `_pyruns_/_shell_`:

```bash
pyr -w shell ls
pyr -w train status
pyr -w ./train.py show baseline
pyr -w ./_pyruns_/train log baseline
```

Task names must be exact. Indices and fuzzy target resolution are not supported. `show` and `log` accept `TASK --run RUN` or the shorter `TASK@RUN` for a historical run, so `@` is reserved in new task names.

## Python integration

### Zero-intrusion `argparse`

```python
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--lr", type=float, default=1e-3)
parser.add_argument("--epochs", type=int, default=10)
args = parser.parse_args()
```

```bash
pyr init train.py
pyr ui train.py
```

### `pyruns.load()` configuration

```python
import os

import pyruns

cfg = pyruns.load()
print(cfg.training.lr)
```

```bash
pyr init train.py --config configs/default.yaml
pyr -w train add configs/default.yaml -n baseline
pyr -w train run baseline
```

## In-script API

| API | Purpose |
| --- | --- |
| `pyruns.load()` | load the current task configuration as a dot-accessible object |
| `pyruns.read(path=None)` | explicitly read YAML or JSON |
| `pyruns.record(**kwargs)` | save final metrics for the current run |
| `pyruns.track(**kwargs)` | append time-series metrics |
| `pyruns.get_task_dir()` | return the current task directory |
| `pyruns.get_run_index()` | return the current run number |
| `pyruns.artifact_dir()` | create and return `artifacts/runN` |

```python
import pyruns

cfg = pyruns.load()

for epoch in range(cfg.training.epochs):
    loss = train_one_epoch()
    pyruns.track(epoch=epoch, loss=loss)

pyruns.record(final_loss=loss, seed=cfg.training.seed)
model.save(os.path.join(pyruns.artifact_dir(), "model.pt"))
```

## Inspection and lifecycle

```bash
pyr -w train ls -s running -s queued
pyr -w train status
pyr -w train show baseline
pyr -w train show baseline@2
pyr -w train show baseline --run 2
pyr -w train log baseline -f
pyr -w train log baseline@2
pyr -w train wait baseline --timeout 600
pyr -w train stop baseline
pyr -w train mv baseline baseline-lr1e3
pyr -w train pin baseline-lr1e3
pyr -w train rm baseline-lr1e3
pyr -w train ls --trash
pyr -w train restore baseline-lr1e3
```

`ls` marks pinned tasks with `PIN` and keeps them ahead of normal tasks for every sort. `--reverse` changes order inside each group. JSON listings and `show` expose an explicit `pinned` field.

`rm` executes immediately without confirmation, but remains a recoverable soft delete.

## JSON and automation

Append `--json` only to commands that advertise machine output. Every result is a strict JSON
object with top-level `"schema_version": 1`; YAML dates and timestamps become ISO 8601 strings,
while NaN, Infinity, and unsupported objects are rejected rather than emitted as non-standard JSON:

```bash
pyr -w shell ls --json
pyr -w shell status --json
pyr -w shell show smoke --json
pyr -w shell show smoke@2 --json
pyr -w shell show smoke --run 2 --json
pyr -w shell log smoke --path --json
pyr -w shell log smoke@2 --path --json
pyr config list --json
pyr metrics --json
```

Logs are raw stdout by default; use `log --path` for a structured reference. Exports go to stdout unless a file is selected:

```bash
pyr -w train export -f csv
pyr -w train export baseline --format json
pyr -w train export -s completed -o results.csv
```

Select the export record format only with `--format` (or `-f`); filename extensions do not implicitly change it.

Exit status:

```text
0    command and all waited tasks succeeded
1    workspace, target, runtime, or task failure
2    invalid command-line usage
130  command interrupted by Ctrl+C
```

## Web UI

![Manager](https://raw.githubusercontent.com/LthreeC/pyruns/main/docs/assets/tab_manager.png)

```bash
pyr ui
pyr ui train.py
pyr ui train.py --config configs/default.yaml
pyr ui train
pyr ui shell
pyr ui shell -p 8099
pyr ui shell --no-browser
pyr dev train.py
```

Each form has one clear purpose:

- `pyr ui` opens the workspace chooser instead of guessing a target.
- `pyr ui shell` opens or creates the current project's shell workspace.
- `pyr ui train.py` initializes or opens that Python script workspace; add `--config` when its first template is required.
- `pyr ui train` or `pyr ui PATH` opens an existing exact workspace name or path.
- `pyr dev ...` enables hot reload for Pyruns frontend development; normal use belongs to `ui`.

`-p, --port` chooses the listening port. `--no-browser` starts only the server and prints its URL, while `--browser` forces automatic browser opening.

The UI listens only on the local loopback interface and generates a fresh private access token on
every start. The first browser request exchanges that token for a persistent `HttpOnly`, same-site
session cookie and removes it from the address bar. The cookie is renewed while in use and survives
normal updates or restarts for the same host, port, and workspace. Clearing browser data or local
`~/.pyruns/sessions` state requires opening the latest complete URL again. Do not share that URL;
the Web UI is a local tool, not a remote multi-user service.

Pyruns is not a code sandbox. Task commands and Python scripts inherit the current user's system
permissions; run only scripts, configurations, and commands that you trust.

- Home / Dashboard shows GPU and system state, task totals, and recent tasks for the current workspace.
- Generator edits script configuration through Grid, Tree, or YAML views, or edits shell commands before creating tasks.
- Manager searches, filters, sorts, and controls tasks in bulk, with run, stop, rename, pin, and recoverable removal actions.
- Monitor shows live or historical logs, log search, run and stop actions, details, and record export.
- The sidebar's Workspace control switches workspaces; Runtime configures Python, environment variables, GPUs, and execution behavior.

![Monitor](https://raw.githubusercontent.com/LthreeC/pyruns/main/docs/assets/tab_monitor.png)

## Disk is the source of truth

```text
<project>/_pyruns_/
├── _pyruns_settings.yaml
├── _shell_/
│   ├── script_info.json
│   └── tasks/
└── <script_name>/
    ├── script_info.json
    ├── config_default.yaml
    └── tasks/
```

The CLI and Web UI operate on the same state, so tasks survive closing either interface and remain inspectable by version control, backup tools, and automation.

## Documentation

- [Getting started](docs/getting-started.md)
- [CLI guide](docs/cli-guide.md)
- [Configuration](docs/configuration.md)
- [Web UI guide](docs/ui-guide.md)
- [Batch syntax](docs/batch-syntax.md)
- [Script API](docs/api-reference.md)
- [Architecture](docs/architecture.md)

## License

MIT

# cli-baton

零依赖的 Node.js ESM **MCP stdio 服务器**：把任务交给本机的 `agy` / `codex` 命令行 AI 代理异步执行，并把结果以 JSON 形式回传给 MCP 客户端（Claude Code、Claude Desktop 等）。

一个 MCP 工具调用只负责**提交任务**并立即拿到 `run_id`；真正的 CLI 进程由脱离 MCP 进程的 supervisor 在后台执行。因此即使 MCP 服务器重启、客户端断开，正在运行的任务也不会丢失——重新连接后用 `run_id` 继续 `wait` / `status` 即可。

- 后端 `agy` → serverInfo.name 为 `agy-baton`，工具前缀 `agy_`
- 后端 `codex` → serverInfo.name 为 `codex-baton`，工具前缀 `codex_`

这是通用 CLI 调用与任务管理工具，不包含论文修改等领域专用流程。两个后端可按需单独配置；每位使用者需要安装并登录自己的 CLI，使用自己的账号和配额。

## 快速开始

1. 安装 Node.js >= 18，以及准备使用的 `agy` 或 `codex` CLI，并按该 CLI 的说明完成登录。`agy` 需要支持本文所用的 `-p`、`--output-format` 等参数；仓库不附带 CLI 程序或账号。
2. 下载仓库（也可以从 GitHub 下载 ZIP 并解压）：

   ```bash
   git clone https://github.com/shrimp040217-design/cli-baton.git
   cd cli-baton
   node --version
   ```

3. 找到解压或克隆目录的绝对路径，按下文“安装与 MCP 注册示例”添加需要的后端。示例中的 `/abs/path` 必须替换为这个目录的实际路径；GUI 客户端找不到 Node.js 时，`command` 也要使用 Node.js 的绝对路径。
4. 重启或重新连接 MCP 客户端，确认出现 `agy_send` / `agy_wait` 或 `codex_send` / `codex_wait`。第一次可发送一个简单任务，并显式设置 `access: "read-only"` 和较短的 `timeout_s`，再用返回的 `run_id` 查询结果。

不需要 `npm install`。仓库只发布代码、测试和说明，不包含开发者的登录凭据、个人配置或运行记录。`package.json` 中的 `private: true` 用于防止误发布到 npm，不影响从 GitHub 下载使用。

## 简介 / 特性

- **零依赖**：只用 Node.js 内置模块，无需 `npm install`；要求 Node.js >= 18。
- **双后端、一套接口**：agy 与 codex 的工具形状完全一致，仅前缀不同；核心不含任何后端专有逻辑。
- **异步任务模型**：`<p>_send` 立即返回，`<p>_wait` 阻塞等待、`<p>_status` 轮询、`<p>_cancel` 取消、`<p>_list_runs` 列出历史。
- **后台 detached supervisor**：MCP 服务器重启/退出不影响运行中的任务；重启后仍可继续查询。
- **会话恢复**：把上一条运行返回的 `session_id` 传给下一次 `send`，即可在同一会话中继续对话。
- **完整可观测性**：状态机、stdout 原始事件尾行、stderr 尾部、usage、run 目录落盘。
- **实时进度窗口（macOS）**：每个 run 自动开一个 Terminal 窗口跟随 `stdout.jsonl`，逐字显示 CLI 正在写的内容；终态自动关窗；`CLI_BATON_VIEWER=0` 可关闭。
- **对话模式（两个后端）**：窗口里（或 `<p>_say`）可以随时插话，每个回合各有一条 `turns[]` 记录。agy 保持一个长连接进程（消息写 stdin），**一段对话最多 2 轮**（`CLI_BATON_AGY_MAX_TURNS` 可改）；codex 每个 turn 一个新进程（`exec resume <thread_id>`），**轮数不限**。没有窗口时**不进入等待输入的宽限期**，最后一个 turn 结束即完成（其间仍可用 `<p>_say` 追加消息）。
- **卡死检测**：`_status` / `_wait` 返回 `idle_s`、`stdout_bytes`、`event_count`、`last_event`；配 `stall_s` 时 `_wait` 在长时间无输出后立即返回 `stalled: true`（不杀进程）。
- **权限可控**：默认 `access=full`（两个后端一致），也可显式指定 `read-only`。
- **本地记录与部分脱敏**：不主动序列化环境变量；返回的错误和日志尾部按规则脱敏，完整回复与原始日志不保证脱敏；超长回复截断并落盘完整版本；状态目录 0700、文件 0600。
- **可恢复的状态存储**：原子 JSON 写入，避免读到半写状态。

## 架构与文件分工

```
MCP client ──stdio(逐行 JSON-RPC)──▶ src/server.mjs
                                        │
                              src/tools.mjs（schema + 参数校验 + 工具处理）
                                        │
                              src/runs.mjs（run 目录、状态、取消、脱敏）
                                        │ 启动 detached supervisor
                              src/runner.mjs（后台执行器：启动 CLI、写事件、超时/取消）
                                        │ 通过 adapter 构造命令行
                              src/backends/{agy,codex}.mjs

runner ──stdin NDJSON──▶ agy（对话模式：每条消息一个 turn）
   │  ▲
   │  └── inbox.jsonl ◀── viewer 输入行 / <p>_say
   │
runner ──osascript──▶ src/viewer-window.mjs（macOS 弹窗/关窗）──▶ Terminal.app
                                                    │ 运行
                                          src/viewer.mjs（跟随 stdout.jsonl 实时渲染）
```

| 文件 | 职责 |
| --- | --- |
| `src/server.mjs` | MCP stdio 协议循环（逐行 JSON-RPC）+ `--backend` 分发。stdout 只输出协议消息，日志走 stderr。 |
| `src/tools.mjs` | 工具 schema/annotations、参数校验、工具处理函数。 |
| `src/runs.mjs` | run 存储布局与权限、原子 JSON 写入、状态解析（supervisor pid + start token / 心跳 → interrupted）、列表、取消、脱敏、回复截断。 |
| `src/runner.mjs` | detached supervisor：在独立进程组中启动 CLI、流式写 `stdout.jsonl` / `stderr.log`、执行超时（SIGTERM → SIGKILL）、写 `reply.txt` / `result.json`。 |
| `src/backends/agy.mjs` | agy 适配器：可执行文件发现、argv 构造、输出解析、模型列表。 |
| `src/backends/codex.mjs` | codex 适配器：可执行文件发现、argv 构造、输出解析、模型列表。 |
| `src/backends/index.mjs` | 极简注册表：后端名 → adapter。 |
| `src/viewer.mjs` | 实时进度查看器（`node src/viewer.mjs <run_dir>`）：跟随 `stdout.jsonl` / `stderr.log`，把 agy 的 `stream-json` 事件与 codex 的 `--json` 事件渲染成人能读的文字，终态后自行退出。 |
| `src/chat.mjs` | 与后端无关的对话层：`inbox.jsonl` 跟随、排队、`turns`、宽限期策略（`CLI_BATON_CHAT_GRACE_S`）、agy 的 stdin 消息格式。 |
| `src/viewer-window.mjs` | macOS 弹窗/关窗桥：用 AppleScript 新建 Terminal 窗口跑 viewer、记录窗口 id、终态时先结束 viewer 再关窗；任何失败只写 `viewer.log`。 |
| `tests/helpers.mjs`、`tests/fixtures/` | 测试用的 MCP 客户端封装与 fake CLI 夹具（fake-agy 支持 `stream-json`、`silent`、`chatty` 等模式；fake-osascript 记录弹窗/关窗调用）。 |
| `tests/*.test.mjs` | 使用 fake CLI 的协议/可靠性测试（`node --test`）。 |
| `tests/live.mjs` | 真实 CLI 冒烟测试（手动运行，消耗真实配额）。 |

### 协议要点

- 传输：stdio 上的 newline-delimited JSON-RPC（每行一条消息）。
- `initialize`：回显客户端 `protocolVersion`（默认 `2025-06-18`）；通知消息不回复；`ping` → `{}`。
- 工具错误不会让服务器崩溃：以 `tools/call` 的结果返回，`isError: true`。
- 工具结果的 `content[0].text` 是 **JSON 字符串**，客户端解析后即为下文字段。

## 安装与 MCP 注册示例

要求：Node.js >= 18；本机已安装并完成认证的 `agy` / `codex`（可用 `AGY_BIN` / `CODEX_BIN` 覆盖路径，见“环境变量”）。仓库本身**不需要 npm install**。

把仓库放在任意绝对路径（下文以 `/abs/path` 代指），先手动跑通：

```bash
node /abs/path/src/server.mjs --backend agy     # serverInfo.name = agy-baton
node /abs/path/src/server.mjs --backend codex   # serverInfo.name = codex-baton
```

缺少或非法的 `--backend` 会以非零退出码结束，并把原因写到 stderr。

本地验证：

```bash
node --check src/server.mjs
npm test                                        # = node --test tests/*.test.mjs（fake CLI，不消耗配额）
node tests/live.mjs --backend codex             # 真实 CLI 冒烟测试（会消耗真实模型配额）
node tests/live.mjs                             # agy + codex 全部用例
```

> 手动 live 测试默认也会弹实时窗口；不想弹就在前面加 `CLI_BATON_VIEWER=0`。
>
> `tests/live.mjs` 是手动测试：每个用例 180 秒硬超时（`resume-memory` 含两次顺序 CLI 调用，放宽为 2×180 秒；每次调用仍受 `timeout_s:150` 的 run 超时约束），逐个打印 `PASS`/`FAIL`，最后输出汇总表；全部通过时退出码为 0。某个后端不可用（例如 agy 所在环境没有网络）时，该后端的每个用例会在 180 秒内以 `FAIL` 结束，不会挂住整个套件。

### Claude Code

```bash
claude mcp add agy-baton -- node /abs/path/src/server.mjs --backend agy
claude mcp add codex-baton -- node /abs/path/src/server.mjs --backend codex
```

### Claude Desktop（JSON 配置）

```json
{
  "mcpServers": {
    "agy-baton": {
      "command": "node",
      "args": ["/abs/path/src/server.mjs", "--backend", "agy"]
    },
    "codex-baton": {
      "command": "node",
      "args": ["/abs/path/src/server.mjs", "--backend", "codex"]
    }
  }
}
```

提示：

- 务必使用 **绝对路径**；GUI 应用的环境变量 `PATH` 可能与你 shell 中不同，必要时把 `command` 写成 `node` 的绝对路径。
- 代理等环境变量由 MCP 客户端进程继承（见“环境变量”）。

## 工具说明

下文中 `<p>` 表示后端前缀 `agy` 或 `codex`（例如 `agy_send`、`codex_wait`）。

**公共参数**（`send` 使用）：

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `message` | string | ✅ | — | 提示词全文，支持以 `-` 开头的内容。 |
| `cwd` | string | ✅ | — | 必须是**绝对路径且已存在的目录**。 |
| `session_id` | string | — | — | 恢复已有会话；来自上一次运行的返回。 |
| `model` | string | — | 不传 | 默认不传，使用 CLI 自身的默认模型。 |
| `effort` | string | — | — | `low` / `medium` / `high` / `xhigh` / `max`。 |
| `access` | string | — | `full` | `read-only` 或 `full`；**两个后端默认都是 full**。 |
| `timeout_s` | number | — | `3600` | 本次 run 的运行超时，范围 10..86400；到期由 supervisor 终止 CLI 并标记 `timed_out`。 |
| `stall_s` | number | — | 不设置 | 卡死判定阈值（秒，1..86400），记录在 run 上；运行中且 `idle_s > stall_s` 时 `_wait` 立即返回 `stalled: true`。**只报告，不杀进程**。 |

### `<p>_send`

提交一次任务，**立即返回**，不等待 CLI 执行。

```json
{ "run_id": "…", "state": "queued", "run_dir": "/…/runs/<run_id>", "backend": "agy" }
```

`state` 是提交瞬间的状态（通常 `queued` 或 `running`）；之后用 `_wait` / `_status` 获取终态。

传了 `stall_s` 时，该阈值写入 `meta.json`；之后调用 `_wait` 不传 `stall_s` 也会沿用它。

- 两个后端的 run 都是**对话**（chat）：`send` 的 message 是第一个 turn。之后可以用 `<p>_say` 继续插话；带窗口时最后一个 turn 结束后还会有一个宽限期（见“对话模式”）。
- 区别只在“下一条消息怎么发”：**agy** 写入同一个常驻进程的 stdin；**codex** 每个 turn 启动一次 `codex exec resume --json … <thread_id>`（thread id 来自上一轮 `thread.started`）。

### `<p>_say`

向**正在运行**的对话追加一条消息。消息写入 `run_dir/inbox.jsonl`（`source: "caller"`），排在当前 turn 之后执行；不会打断正在生成的回复。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `run_id` | string | ✅ | 运行中的对话 run（两个后端都支持）。 |
| `text` | string | ✅ | 追加的对话内容。 |

返回与 `_status` 相同，另加 `say: { queued: true, at, source: "caller", inflight }`。run 已结束、id 不存在、text 为空都会返回明确的工具错误；对话已收尾（`stdin_closed: true`）时也会明确拒绝，而不是假装排队。

### `<p>_wait`

等待 run 进入终态（或等待超时）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `run_id` | string | ✅ | — | `send` 返回的 id。 |
| `timeout_s` | number | — | `240` | 本次**等待**的切片时长，范围 1..540；它不会终止 run。超时返回时带 `timed_out: true`，继续调用即可。 |
| `stall_s` | number | — | 沿用 run 上记录的值 | 卡死判定阈值（秒）；运行中且 `idle_s > stall_s` 时立即返回 `stalled: true`（不杀进程），便于上层决定“继续等 / 取消”。 |

返回字段：

| 字段 | 说明 |
| --- | --- |
| `run_id`、`backend` | 运行 id 与后端名。 |
| `state` | 状态，见“状态与可靠性”。 |
| `session_id` | 会话 id，可用于下一次 `send` 恢复会话。 |
| `reply` | CLI 的回复文本。 |
| `exit_code` | CLI 退出码（未结束时为 null）。 |
| `error` | 失败原因（成功时为 null）。 |
| `model`、`effort`、`access` | 本次运行实际使用的参数。 |
| `cwd` | 运行目录。 |
| `created_at` | run 创建时间。 |
| `started_at`、`ended_at`、`duration_s` | 时间信息（未开始/未结束时可能为 null）。 |
| `usage` | token 用量（CLI 提供时）。 |
| `run_dir` | 运行产物目录，见“存储布局”。 |
| `stderr_tail` | CLI stderr 尾部（已脱敏）。 |
| `reply_truncated` | 布尔值；reply 超过 100000 字符时为 true，此时完整回复在 `run_dir/reply.txt`。 |
| `timed_out` | 布尔值；仅当 `_wait` 等待超时（不是 run 超时）时出现。 |
| `stalled` | 布尔值；仅当“运行中且 `idle_s > stall_s`”触发时出现（值为 `true`），此时 `stall_s` / `idle_s` 一并返回。 |
| `last_output_at` | ISO 时间；CLI 最近一次往 stdout/stderr 写输出的时间（未开始时为 null）。 |
| `stdout_bytes` | 数字；`stdout.jsonl` 已写入的字节数。 |
| `event_count` | 数字；已写入的 JSON 事件条数。 |
| `last_event` | 字符串；最后一条事件的 `event`（agy）或 `type`（codex），非 JSON 行为 `raw`。 |
| `idle_s` | 数字；距最后一次输出的秒数（0.1 精度），用于判断“在思考”还是“卡住”。 |
| `turns` | 数组；每个 turn 一条 `{user_text, source: "caller"\|"window", reply, status, duration_s, at}`（reply 超 20000 字符会截断并带 `reply_truncated`）。两个后端都是对话，因此单次 `send` 至少有一条。 |
| `chat` | 布尔；该 run 是否是对话（两个后端都是）。 |
| `inflight` | 布尔；当前是否有一个 turn 正在生成（此时插话会排队）。 |
| `grace_until` / `grace_remaining_s` | 宽限期的截止时间 / 剩余秒数；没有宽限期时为 null。 |
| `stdin_closed` | 布尔；对话已收尾（agy 的 stdin 关闭 / codex 不再启动新 turn），此时 `<p>_say` 会明确报错而不是假装排队。 |
| `max_turns` / `turns_used` / `turns_remaining` | 该段对话的轮数上限（codex 为 null）、已用轮数、剩余轮数。 |
| `max_turns_reached` | 布尔；已达上限，此时 `<p>_say` 返回 `max_turns_reached`，窗口输入被禁用。 |

### `<p>_status`

非阻塞查询当前状态与最近事件。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `run_id` | string | ✅ | — | `send` 返回的 id。 |
| `tail` | number | — | `5` | 返回最近多少条原始事件行，最大 50。 |

返回字段与 `_wait` 相同（含 `last_output_at` / `stdout_bytes` / `event_count` / `last_event` / `idle_s`），另加：

| 字段 | 说明 |
| --- | --- |
| `tail` | `string[]`，最近的原始事件行（stdout.jsonl 尾部）。 |

### `<p>_cancel`

取消一个运行。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `run_id` | string | ✅ | 要取消的运行。 |

返回与 `_wait` 相同的字段。取消流程为 SIGTERM（约 5 秒宽限）→ SIGKILL。若运行**已经结束**，直接返回其当前状态，不报错。

### `<p>_list_runs`

列出运行历史，最新在前。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | number | — | `20` | 返回条数上限，最大 100。 |
| `state` | string | — | — | 只返回指定状态的运行。 |

```json
{ "backend": "agy", "runs": [ { "run_id": "…", "state": "completed", "…": "…" } ], "count": 1, "total": 1 }
```

每条是运行摘要，**不包含完整 reply**。

### `<p>_list_models`

查询后端可用的模型列表（无参数）。

成功时：

```json
{ "backend": "agy", "models": [ { "id": "…", "display_name": "…" } ], "source": "agy models", "count": 1, "executable": "/…/agy" }
```

不可用时（CLI 子命令缺失、输出不可解析等）：返回 `isError: true` 与明确错误信息，**不会伪造模型列表**。详见“模型列表”。

## 权限默认值

> **重要：两个后端默认都是 `access=full`**（包括 codex，新会话与 resume 一致）。`full` 意味着 CLI 可以在本机执行命令、读写文件。如果只想做分析，请显式传 `access: "read-only"`。

| access | agy | codex |
| --- | --- | --- |
| `full`（默认） | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox`（新会话与 `exec resume` 均使用） |
| `read-only`（显式） | `--mode plan` | `-c sandbox_mode="read-only" -c approval_policy="never"` |

- 默认值特意选择 `full`：作为“任务执行代理”，写文件、跑命令是常见需求。
- `read-only` 只会在你显式传入时生效，用于让 CLI 在只读/计划模式下工作。
- agy 的 `read-only` 映射为 CLI 的计划模式，是否限制所有写入取决于该 CLI；cli-baton 自身不提供操作系统级沙箱。
- 请在受控环境中使用；`full` 下的行为等同于你本人执行 CLI 命令。

## 实时进度窗口（macOS）

每个 run 在 macOS 上会自动开一个小窗口显示实时进度，代替“盯着空文件猜是不是卡死”。

- **何时弹出**：supervisor 启动 CLI 子进程后，用 `osascript` 让 Terminal.app 新开一个窗口执行
  `node <cli-baton 绝对路径>/src/viewer.mjs '<run_dir>'`，窗口标题为 `cli-baton · <backend> · <run_id 前 8 位>`。
  不会调用 `activate`，尽量不抢当前前台焦点。
- **显示什么**：开头是 backend / model / effort / access / cwd / run_id；agy 的 `text_delta` 连续打印，
  `step_type` 变化与工具调用各打一行带时间戳的标记（工具行显示工具名），`result` 显示 status、用时与 token；
  codex 的 `thread.started` / `item.completed` / `turn.completed` 同样被翻译成可读行；不认识的 JSON 行压缩成一行。
  每 5 秒无新输出时在底部状态行显示“仍在运行，已 Ns 无新输出，进程 pid 存活/已退出”（读 `heartbeat.json` / `meta.json`）。
- **何时关闭**：run 进入终态（`completed` / `failed` / `cancelled` / `timed_out` / `interrupted`）后，viewer 自己打印最终状态并退出；
  supervisor 先确保 viewer 进程结束（最多等 3 秒，否则直接结束它），再用 `osascript` 按 `viewer.json` 里记录的窗口 id 关闭该窗口。
  若关闭时该 tab 仍有前台进程，先让 shell 退出再关窗，避免弹出“是否终止进程”的确认框；窗口已被用户手动关闭时静默忽略。
- **随时手动看**：run 跑着或已经跑完都可以

  ```bash
  node src/viewer.mjs ~/.cli-baton/agy/runs/<run_id>
  ```

  它会从头重放 `stdout.jsonl`，然后继续跟随，直到读到终态。
- **关掉这个功能**：`CLI_BATON_VIEWER=0`（也接受 `false` / `off` / `no`）时完全不弹窗；非 macOS 平台永远不弹。
- **失败隔离**：任何 `osascript` / viewer 失败只会追加到 run 目录的 `viewer.log`，**不会**让 run 失败或改变 run 结果。

## 对话模式（agy / codex）

两个后端共用同一套对话层（收件箱 / 排队 / `turns` / 宽限 / 窗口输入），只在下发方式上不同：

- **agy**：长连接。`--input-format stream-json --output-format stream-json … -p=`，从 stdin 逐行读 NDJSON（`{"event":"user","message":{"content":[{"type":"text","text":"…"}]}}`），每条消息跑一个 turn，stdin 不关进程就不退出。第一个 turn 就是 `send` 的 `message`（不再走 argv，`meta.json` 的 argv 里只有 `-p=`）。
- **codex**：一次一个进程。第一个 turn 是 `codex exec --json --skip-git-repo-check -`，进程结束即该 turn 结束；后续消息用 `codex exec resume --json --skip-git-repo-check <thread_id> -`（thread id 取自 `thread.started`）。每次 resume 的事件继续追加到**同一个** `stdout.jsonl`，作为同一个 run 的新 turn。

- **插话的三种入口**：窗口底部输入行、直接追加 `run_dir/inbox.jsonl`、MCP 工具 `<p>_say`。runner 每 200ms 跟随收件箱，把新行下发并把 `{"event":"user_injected",…}` 记进 `stdout.jsonl`（viewer 会显示“插话 · 窗口/调用方”）。
- **codex 的宽限期**：turn 结束后进程已经退出，所以宽限期内 runner 只保留 run（不再有进程）；有新消息就启动下一次 resume，没有就到期收尾。取消/超时在“无进程”的宽限期内会直接结束 run。
- **轮数上限（agy 默认 2）**：计数包含调用方 prompt、`session_id` 续接（按已用 1 轮计）、`<p>_say` 与窗口输入。达到上限后：
  - 窗口底部显示“本段对话已达 N 轮上限，请让 Claude 开新对话”，输入框禁用；
  - `<p>_say` 立即返回工具错误，`error` 就是 `max_turns_reached`，消息**不会**写入收件箱或 stdin；
  - 宽限期直接跳过：最后一个 turn 结束就关 stdin、完成 run、关窗。
  程序化直接追加 `inbox.jsonl` 越过上限时，runner 会拒收并记一条 `{"event":"user_rejected",…,"reason":"max_turns_reached"}`，不会变成 turn。
- **排队**：一个 turn 正在进行时，新消息只入队，等该 turn 的 `result` 到达后再发送，绝不打断生成。
- **每个 turn 一条记录**：`turns.json` 落盘，`_status` / `_wait` 的 `turns[]` 实时可读；`reply` 始终是最后一个 turn 的回复。
- **宽限期**：最后一个 turn 结束且收件箱为空时，若窗口已启用（macOS 且 `CLI_BATON_VIEWER≠0`），进入 `CLI_BATON_CHAT_GRACE_S`（默认 20 秒）宽限：
  - 窗口底部显示“完成；N 秒内输入可继续对话，否则自动关闭”并每秒刷新；
  - 宽限期内有输入 → 取消宽限、继续 `running`，`_wait` 继续等新 turn；
  - 宽限期满 → 关闭 agy stdin → agy 退出 → run 记为 `completed` → 按既有逻辑关窗。
- **没有窗口时不进宽限**：`CLI_BATON_VIEWER=0` 或非 macOS，最后一个 turn 结束就完成（agy 关 stdin、codex 直接收尾），行为与加对话模式之前一致（无人值守不会被 20 秒吊住）。
- **取消 / 超时 / stall**：与之前一致；取消与超时会结束进程并关窗。宽限期是“故意在等用户输入”，因此宽限期内不会因为 `idle_s` 增长而报 `stalled`（避免把等人误判成卡死）；turn 进行中或宽限结束后的无输出仍按原来的 `stall_s` 语义处理。

## 卡死检测（stall）

CLI 有可能长时间没有任何输出。supervisor 会记录进度，工具把它换算成 `idle_s`，让调用方区分“在思考”和“卡住”：

- supervisor 在**最多每秒一次**的节流下，把 `last_output_at`、`stdout_bytes`、`event_count`、`last_event` 写进
  `heartbeat.json`（输出很密时不会变成写风暴；run 结束时强制刷新一次最终值）。
- `_status` / `_wait` 返回这些字段以及 `idle_s` = 距最后一次输出的秒数。
- `_send` 可传 `stall_s`（秒），`_wait` 也可传（不传就用 run 上记录的值）。当 run 仍 `running` 且 `idle_s > stall_s` 时，
  `_wait` **立即**返回 `stalled: true`，而不是阻塞到等待超时。
- **只报告、不杀进程**：`stalled` 只是提示；进程继续跑，可以再调 `_status` 观察，或按需 `_cancel`。

## 状态与可靠性

### 状态

| 状态 | 含义 |
| --- | --- |
| `queued` | 已创建 run，supervisor 尚未开始执行。 |
| `running` | CLI 正在执行。 |
| `completed` | CLI 正常结束且得到非空回复。 |
| `failed` | CLI 非零退出、`turn.failed`，或回复为空。 |
| `cancelled` | 已被取消（SIGTERM → SIGKILL）。 |
| `timed_out` | 超过 run 的 `timeout_s`，由 supervisor 终止。 |
| `interrupted` | supervisor 异常消失（如机器重启、进程被杀）且没有结果，由状态解析判定。 |

### 可靠性机制

- **Detached supervisor**：`_send` 只做落盘并启动后台 supervisor，随即返回。supervisor 脱离 MCP 进程运行，因此 MCP 服务器重启或退出**不会**影响运行中的任务；重新连接后用 `run_id` 继续 `_wait` / `_status` 即可。
- **interrupted 判定**：`supervisor.json` 记录 supervisor 的 pid 与 start token（防止 pid 复用误判），运行期间刷新 `heartbeat.json`；当 supervisor 进程不存在、start token 不匹配或心跳超时且没有 `result.json` 时，状态解析为 `interrupted`。
- **取消**：`_cancel` 对 supervisor/CLI 进程组先发 `SIGTERM`（约 5 秒宽限），再 `SIGKILL`；已结束的运行直接返回当前状态，不报错。
- **会话并发拒绝**：同一个 `session_id` 同时只允许一个运行；并发提交第二个会收到明确错误，避免上下文互相污染。
- **原子写入**：状态 JSON 采用“临时文件 + rename”，读方不会看到半写内容。
- **输出即落盘**：agy 以 `--output-format stream-json`（逐行 NDJSON）运行，codex 以 `--json`（逐行 JSONL）运行；supervisor 按 chunk 同步写入 `stdout.jsonl`，所以运行中就能看到事件，实时窗口与 `idle_s` 都基于它。
- **实时窗口失败隔离**：弹窗/关窗全部 best effort，异常只进 `viewer.log`；窗口不存在、Terminal 不可脚本化、viewer 提前退出都不会影响 run 状态与结果。
- **超时分层**：run 的 `timeout_s`（默认 3600）决定任务最长运行时间，到期由 supervisor 终止并标记 `timed_out`；`_wait` 的 `timeout_s`（默认 240）只是本次等待的切片长度，不会终止任务，超时返回后继续调用即可。

## 存储布局

存储根目录由 `CLI_BATON_HOME` 指定，默认 `~/.cli-baton`：

```
~/.cli-baton/
  <backend>/                      # agy 或 codex
    runs/
      <run_id>/
        meta.json                 # 运行元数据：cwd、access、model、effort、argv、时间等
        prompt.txt                # 提示词全文
        supervisor.json           # supervisor pid + start token
        heartbeat.json            # supervisor 运行期间刷新（含 last_output_at/stdout_bytes/event_count/last_event）
        cancel.json               # 仅当取消进行中时出现
        stdout.jsonl              # CLI stdout 原始事件流（每行一条）
        stderr.log                # CLI stderr
        reply.txt                 # 完整回复（始终写入；无回复时为空）
        result.json               # 最终结果快照（包含完整 reply）
        inbox.jsonl               # 对话收件箱：每行 {"text","at","source"}（窗口/<p>_say 追加，runner 跟随）
        turns.json                # 已完成 turn 的完整记录（user_text/source/reply/status/duration_s）
        viewer.json               # 实时窗口：window_id、opened_at、pid、closed_at（仅 macOS 弹窗时出现）
        viewer.log                # 实时窗口的 open/close 与失败记录（仅 macOS 弹窗时出现）
```

- **权限**：目录 `0700`，文件 `0600`，仅当前用户可访问。
- **提示词在状态文件与进程参数中的处理**：
  - agy 走对话模式：提示词作为**第一条 stdin 消息**传入，argv 里只有空值 token `-p=`（`meta.json` 的 argv 同样只记录 `-p=`），进程列表看不到提示词；
  - codex 的提示词通过 stdin 传入（argv 最后一个 token 为 `-`），提示词不出现在 argv 中；
  - 两种情况下都会把提示词全文写入 `prompt.txt`（0600）；CLI 输出也可能重复包含提示词或工作文件内容。

这些文件用于后台任务恢复查询和排查问题，没有自动清理期限。需要清理历史时，应先确认对应任务已结束，再自行删除其 run 目录；仍在运行的任务依赖这些文件。不要把 `~/.cli-baton`、自定义 `CLI_BATON_HOME`、真实运行日志或含任务内容的截图提交到公开仓库。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CLI_BATON_HOME` | 存储根目录，默认 `~/.cli-baton`。 |
| `AGY_BIN` | agy 可执行文件路径覆盖。不设置时依次查找：`PATH` → `~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin`。 |
| `CODEX_BIN` | codex 可执行文件路径覆盖。查找顺序同 `AGY_BIN`。 |
| `CLI_BATON_VIEWER` | `0` / `false` / `off` / `no` 时关闭 macOS 实时进度窗口；默认开启（非 macOS 永远不弹）。 |
| `CLI_BATON_OSASCRIPT_BIN` | 覆盖 `osascript` 可执行文件路径（测试/调试用）。 |
| `CLI_BATON_VIEWER_POLL_MS` | viewer 的轮询间隔（毫秒，默认 500），主要供测试使用。 |
| `CLI_BATON_VIEWER_IDLE_MS` | viewer 多久无输出后显示底部状态行（毫秒，默认 5000）。 |
| `CLI_BATON_CHAT_GRACE_S` | 对话最后一个 turn 结束后的宽限秒数（默认 20；`0` 或负值表示不等待；仅在开窗时生效，两个后端一致）。 |
| `CLI_BATON_AGY_MAX_TURNS` | agy 一段对话的最大轮数，默认 `2`（初始消息 + 1 条追加）。`0` / `inf` / `unlimited` 表示不限；只影响 agy，codex 永远不限。 |

- **代理自动继承**：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 等环境变量由服务器进程原样传给 CLI 子进程；cli-baton 不硬编码任何代理。
- 子进程继承 MCP 服务进程的环境，包含 CLI 运行所需的认证和代理变量；服务不会主动把整个环境写入状态文件。CLI 自己输出的内容仍可能进入原始日志。

## 安全与脱敏

- **不主动转存环境变量**：不会主动把环境变量全集写入日志或状态文件，但无法保证 CLI 输出不包含凭据。
- **输出脱敏**：返回的 `stderr_tail`、`error` 与 `status.tail` 事件行中的 `Authorization: Bearer …`、`sk-…`、`api_key=…` / `key=…` / `token: …` / `secret=…` 等片段替换为 `[REDACTED]`。run 目录内的 `stdout.jsonl` 保留 CLI 原始输出（0600，仅当前用户可读）。
- **回复截断**：reply 超过 100000 字符时，返回的 `reply` 被截断并带 `reply_truncated: true`；完整回复始终保存在 `run_dir/reply.txt`。
- **脱敏范围有限**：`reply`、本地 `reply.txt`、`result.json`、原始 stdout/stderr 和工作路径不保证脱敏；模式匹配也无法识别所有秘密。真实任务内容不应直接用于公开示例或问题报告。
- **文件权限**：存储目录 `0700`、文件 `0600`，避免同机其他用户读取提示词与回复。
- 服务器本身不主动联网、不上传数据；联网行为完全来自被调用的 CLI。

## 平台

- **macOS**：主要支持平台（已按 macOS 的进程组、posix 权限、SIGTERM/SIGKILL 语义实现）。
- **macOS 实时窗口**：仅 macOS 会自动弹窗（`osascript` + Terminal.app）；其它平台不弹，但 `node src/viewer.mjs <run_dir>` 仍可手动使用。对话宽限期只在开窗时生效，其它平台行为是“每个 turn 结束即完成”。
- **Linux**：预期以相同方式工作。
- **Windows**：尽力而为——会处理 `.cmd` / `.exe` 形式的可执行文件并尝试用 `taskkill` 终止进程树，但**未经测试**，不作为保证。

## 模型列表

- **agy**：调用 `agy models` 子命令并解析其 JSON 输出。
- **codex**：调用 `codex debug models` 并解析其 JSON catalog。
- 成功返回 `{ backend, models: [{ id, display_name? }], source }`。
- 子命令不存在、输出无法解析或 CLI 不可用时，返回 `isError: true` 与清晰的错误信息；**不会编造模型列表**。
- `_list_models` 只是查询能力；默认不传 `model` 时使用各 CLI 自己的默认模型。

## 已知限制

- **agy 依赖网络/代理**：处于无网络环境时任务可能一直挂起到 run 的 `timeout_s`（默认 3600 秒），需要显式 `_cancel` 或传入更短的 `timeout_s`。`tests/live.mjs` 对每个用例设了 180 秒硬超时（`resume-memory` 因两次顺序调用放宽为 2×180 秒），此类环境会得到 `FAIL`（原因可见），不会挂住测试套件。
- **codex 的瞬时错误**：输出中的瞬时 `error` 事件（重连、临时警告）只作为警告记录，不算失败；失败判定为 `turn.failed`、非零退出码或回复为空。
- **回复长度上限**：一次回复超过 100000 字符会被截断（完整内容取 `run_dir/reply.txt`）。
- **默认 full 权限**：两个后端默认 `access=full`，具有很高的本机权限，请谨慎使用。
- **会话串行**：同一 `session_id` 不允许并发运行。
- **依赖外部 CLI**：需要在对应机器上安装并完成 agy / codex 的认证；模型列表依赖各自 CLI 子命令可用。
- **Windows 未测试**：见“平台”。

## 许可证

本项目采用 [MIT License](LICENSE)。Antigravity、Codex 及其服务的许可和使用条件由各自提供方规定；本仓库不分发这些 CLI。

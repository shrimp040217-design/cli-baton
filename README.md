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
| `tests/helpers.mjs`、`tests/fixtures/` | 测试用的 MCP 客户端封装与 fake CLI 夹具。 |
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

### `<p>_send`

提交一次任务，**立即返回**，不等待 CLI 执行。

```json
{ "run_id": "…", "state": "queued", "run_dir": "/…/runs/<run_id>", "backend": "agy" }
```

`state` 是提交瞬间的状态（通常 `queued` 或 `running`）；之后用 `_wait` / `_status` 获取终态。

### `<p>_wait`

等待 run 进入终态（或等待超时）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `run_id` | string | ✅ | — | `send` 返回的 id。 |
| `timeout_s` | number | — | `240` | 本次**等待**的切片时长，范围 1..540；它不会终止 run。超时返回时带 `timed_out: true`，继续调用即可。 |

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

### `<p>_status`

非阻塞查询当前状态与最近事件。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `run_id` | string | ✅ | — | `send` 返回的 id。 |
| `tail` | number | — | `5` | 返回最近多少条原始事件行，最大 50。 |

返回字段与 `_wait` 相同，另加：

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
        heartbeat.json            # supervisor 运行期间定期刷新
        cancel.json               # 仅当取消进行中时出现
        stdout.jsonl              # CLI stdout 原始事件流（每行一条）
        stderr.log                # CLI stderr
        reply.txt                 # 完整回复（始终写入；无回复时为空）
        result.json               # 最终结果快照（包含完整 reply）
```

- **权限**：目录 `0700`，文件 `0600`，仅当前用户可访问。
- **提示词在状态文件与进程参数中的处理**：
  - agy 的提示词作为 argv 值传入（运行期间本机进程列表可能看到，受本机权限限制），`meta.json` 中该 token 记录为字面量 `<prompt>`；
  - codex 的提示词通过 stdin 传入（argv 最后一个 token 为 `-`），提示词不出现在 argv 中；
  - 两种情况下都会把提示词全文写入 `prompt.txt`（0600）；CLI 输出也可能重复包含提示词或工作文件内容。

这些文件用于后台任务恢复查询和排查问题，没有自动清理期限。需要清理历史时，应先确认对应任务已结束，再自行删除其 run 目录；仍在运行的任务依赖这些文件。不要把 `~/.cli-baton`、自定义 `CLI_BATON_HOME`、真实运行日志或含任务内容的截图提交到公开仓库。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CLI_BATON_HOME` | 存储根目录，默认 `~/.cli-baton`。 |
| `AGY_BIN` | agy 可执行文件路径覆盖。不设置时依次查找：`PATH` → `~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin`。 |
| `CODEX_BIN` | codex 可执行文件路径覆盖。查找顺序同 `AGY_BIN`。 |

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

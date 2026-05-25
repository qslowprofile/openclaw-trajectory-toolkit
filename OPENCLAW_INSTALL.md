# OpenClaw Trajectory Toolkit 安装说明

这份文档给 OpenClaw 或用户阅读。目标交互是：

```text
帮我安装 OpenClaw Trajectory Toolkit
```

OpenClaw 收到压缩包后，按下面流程执行即可。

维护者发布 `openclaw-trajectory-toolkit-*.zip` 时必须在源码仓运行：

```bash
npm run build
npm run package:zip
```

不要手工压缩整个仓库或完整 `node_modules`。发布包只应包含运行时文件和运行时依赖；包体过大会触发 Dashboard WebSocket 1009 关闭，导致附件发送后会话断开重连。

## 自动安装流程

1. 找到压缩包：`openclaw-trajectory-toolkit-0.9.1.zip`
2. 解压到临时目录。
3. 进入解压后的目录。
4. 在 OpenClaw 沙箱里优先运行一键安装脚本：

```bash
node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home "$HOME" --register --enable --allow-conversation-access --restart --detached-verify --doctor
```

如果只是本地安装，不需要注册和重启 OpenClaw gateway，可运行基础安装脚本：

```bash
node scripts/install-openclaw-trajectory.mjs
```

脚本会完成：

- 复制工具到 `~/.openclaw/tools/openclaw-trajectory-toolkit`
- 创建命令 `~/.openclaw/bin/openclaw-trajectory`
- 写入配置 `~/.openclaw/trajectory/config.json`
- 写入 OpenClaw 扩展目录 `~/.openclaw/extensions/openclaw-trajectory`
- 写入兼容自检 manifest `~/.openclaw/plugins/openclaw-trajectory/plugin.json`
- 输出 `openclaw plugins install --link ...` 安装命令、沙箱一键安装命令和验证命令

当前安装脚本面向 macOS / Linux；在 Windows 上运行脚本时会额外生成 `.cmd` wrapper。

## 一句命令

如果当前目录已经是解压后的工具目录，并且你在 OpenClaw 网页版 root 终端里：

```bash
node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home "$HOME" --register --enable --allow-conversation-access --restart --detached-verify --doctor
```

SSH 进沙箱时：

```bash
sudo -H node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home /root --openclaw-home /mnt/openclaw --register --enable --allow-conversation-access --restart --detached-verify --doctor
```

gateway 重启可能中断当前对话；脚本会提前启动后台 verifier。重连后查看：

```bash
cat "$HOME/.openclaw/trajectory/install-report.json"
cat "$HOME/.openclaw/trajectory/install.log"
```

CatClaw 沙箱里，OpenClaw runtime home 通常是 `/mnt/openclaw`。普通 `catclaw` 用户一般不能写 `/mnt/openclaw/.openclaw/openclaw.json`，这时脚本会输出 `status: "partial"`，只完成 CLI 安装并生成 root 后补脚本：

```bash
sudo bash "$HOME/.openclaw/tools/openclaw-trajectory-toolkit/install-extension-as-root.sh"
```

`partial` 不代表 native hook 已生效。只有 root 后补脚本或等价 root 命令完成后，OpenClaw 才会在 gateway 重启后自动加载 trajectory 插件。

## 验证

```bash
~/.openclaw/bin/openclaw-trajectory --help
~/.openclaw/bin/openclaw-trajectory status --base-dir ~/.openclaw/trajectory
~/.openclaw/bin/openclaw-trajectory record-sample --base-dir ~/.openclaw/trajectory
~/.openclaw/bin/openclaw-trajectory quicktest --base-dir ~/.openclaw/trajectory --json
~/.openclaw/bin/openclaw-trajectory doctor --base-dir ~/.openclaw/trajectory --plugin
~/.openclaw/bin/openclaw-trajectory validate --run-dir ~/.openclaw/trajectory/runs/<run_id>
~/.openclaw/bin/openclaw-trajectory tail --run-dir ~/.openclaw/trajectory/runs/<run_id> --lines 20
```

成功后会生成：

```text
~/.openclaw/trajectory/runs/<run_id>/
  ├── run.json
  ├── environment.snapshot.json
  ├── config.snapshot.json
  ├── events.jsonl
  ├── trajectory.json
  ├── normalization_report.json
  ├── replay_meta.json
  ├── spans.otlp.jsonl
  └── artifacts/
```

## 给 OpenClaw 的执行策略

当用户说“帮我安装 OpenClaw Trajectory Toolkit”时：

1. 优先在当前工作区、下载目录、用户提供附件目录中查找 `openclaw-trajectory-toolkit-*.zip`。
2. 解压 zip。
3. 检查 `package.json` 中的 `name` 是否为 `openclaw-trajectory-toolkit`。
4. 如果当前环境是 OpenClaw 沙箱，运行 `node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home "$HOME" --register --enable --allow-conversation-access --restart --detached-verify --doctor`。如果已知 runtime home 是 `/mnt/openclaw`，加上 `--openclaw-home /mnt/openclaw`。
5. 如果当前环境只是普通本地机器，运行 `node scripts/install-openclaw-trajectory.mjs`。
6. gateway 重启后若没有主动继续任务，读取 `$HOME/.openclaw/trajectory/install-report.json`。
7. 安装报告 `status` 为 `ok` 时，把 `command`、`openclaw_extension_dir` 和 `report_path` 返回给用户。
8. 安装报告 `status` 为 `partial` 时，告诉用户 CLI 已安装但 native hook 未生效，并返回 `root_completion_command` 或 `root_completion_script`。
9. 安装报告 `status` 为 `warning` 或 `error` 时，把 `install.log` 末尾和 `install-report.json` 返回给用户。

## 自动埋点接入

OpenClaw runtime 支持插件 API 时，安装脚本写入的扩展 manifest 位于：

```text
~/.openclaw/extensions/openclaw-trajectory/openclaw.plugin.json
```

该 manifest 的入口会加载：

```text
~/.openclaw/tools/openclaw-trajectory-toolkit/dist/openclaw-plugin.js
```

OpenClaw 可按自身插件安装机制加载该扩展。插件入口默认导出 `register(api)`，并订阅以下 hook：

```text
message_received, session_start, before_model_resolve, before_prompt_build,
llm_input, llm_output, before_tool_call, after_tool_call,
external_request_diagnostic,
message_sending, message_sent, agent_end, session_end,
before_compaction, after_compaction, subagent_spawned, subagent_ended,
subagent_spawning, subagent_delivery_target,
model_call_started, model_call_ended,
tool_result_persist, before_message_write
```

当前 OpenClaw runtime 不保证把 `model.call.*`、`tool.execution.*`、`context.assembled`、`run.*` 作为 typed hook 暴露给普通插件。0.9.1 支持后续 OpenClaw core 增加的受控 `external_request_diagnostic` typed hook，或 runtime 注入的 `onExternalRequestDiagnosticEvent`。

外部请求诊断只保存脱敏快照，包括 auth source、fingerprint、HTTP status、request id、allowlist headers、usage、stream 状态和错误摘要。归一化后位于顶层 `diagnostic_steps`，主 `agent_steps`、prompt、conversation 和 tool result 不会包含这些诊断事件。

插件保持 observer-only：不 patch `global.fetch`，不注入 header 或 curl bridge，也不使用 `[llm_skip]` 控制信号。

如需在自定义插件里手动注册：

```ts
import { registerOpenClawNativeTrajectory } from "openclaw-trajectory-toolkit/openclaw-plugin";

export default function register(api) {
  registerOpenClawNativeTrajectory(api);
}
```

如果 OpenClaw runtime 暂时没有插件发现能力，也可以在执行边界使用 `TrajectoryHookManager`：

```ts
const output = await hooks.wrapToolCall(
  { name: "read_file", input: { path: "package.json" } },
  () => openclaw.tools.read_file({ path: "package.json" })
);
```

hook 会自动写 start/end/error 事件，并传播 parent span。记录失败时 hook 进入 degraded 状态，真实 OpenClaw 操作继续执行。可用 `hooks.recordingHealth()` 或 CLI `doctor --plugin` 检查。

## 自然语言手动录制

如果当前公司环境需要 sudo 才能写 OpenClaw extension 目录或重启 gateway，native hook 可能暂时不可用。这时仍可使用 CLI-only 的自然语言手动录制流程。

OpenClaw 应识别这些用户意图：

- 开始录制轨迹
- 开始记录轨迹
- 开始录制 trace
- 开始记录 trajectory
- 停止录制轨迹
- 停止记录轨迹
- 结束录制 trace
- 结束记录 trajectory

推荐以 OpenClaw `session_id` 作为录制边界。用户说“开始录制轨迹”时调用：

```bash
~/.openclaw/bin/openclaw-trajectory attach \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --agent-id <current_agent_id> \
  --agent "main" \
  --input "用户当前任务"
```

`attach` 的状态位于 `~/.openclaw/trajectory/active/<session_id>.json`，多个 session 可以并行录制。没有 session id 的环境可继续使用旧命令：

```bash
~/.openclaw/bin/openclaw-trajectory manual-start \
  --base-dir ~/.openclaw/trajectory \
  --input "用户当前任务" \
  --trigger "开始录制轨迹"
```

任务执行过程中，OpenClaw 每完成一个关键动作就调用录制命令。自然语言 `manual-note` 是低保真兜底，适合记录流程回顾：

```bash
~/.openclaw/bin/openclaw-trajectory manual-note \
  --base-dir ~/.openclaw/trajectory \
  --type shell \
  --status ok \
  --text $'命令执行成功\nagent: worker\ncommand: npm test\nexit_code: 0\nduration: 12s\n输出：全部测试通过'

~/.openclaw/bin/openclaw-trajectory manual-note \
  --base-dir ~/.openclaw/trajectory \
  --text $'文件修改成功\nagent: worker\npath: src/login.ts\noperation: patch\n输出：修复空值判断'
```

更推荐使用结构化 `record-event`，把工具名、参数、返回结果、模型 usage 写成 JSON。这样归一化后会得到可评测的 `tool.call` 和 `model.call`：

```bash
~/.openclaw/bin/openclaw-trajectory record-event \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --json '{"type":"tool","step_id":"step_search_weather","tool_name":"catclaw-search","duration_ms":1200,"input":{"query":"今天武汉天气"},"output":{"results":[{"title":"中国天气网","url":"https://example.test/weather","summary":"武汉 多云 28/17℃"}]}}'

~/.openclaw/bin/openclaw-trajectory record-event \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --json '{"type":"model","step_id":"step_answer_weather","model":"openclaw-model","usage":{"input_tokens":123,"output_tokens":45},"input":{"messages":[{"role":"user","content":"查询今天武汉天气"}]},"output":{"text":"武汉今天多云，约 17~28℃。"}}'
```

停止时推荐调用：

```bash
~/.openclaw/bin/openclaw-trajectory detach \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --final-output "任务完成"
```

没有 session id 的环境可继续使用旧命令：

```bash
~/.openclaw/bin/openclaw-trajectory manual-stop \
  --base-dir ~/.openclaw/trajectory \
  --final-output "任务完成"
```

`manual-stop` 会自动执行归一化、回放计划、OTel-like 导出和 schema 校验。输出里的 `run_dir` 可以直接交给用户，核心文件是：

```text
trajectory.json
normalization_report.json
events.jsonl
run.json
artifacts/
```

可随时查看状态：

```bash
~/.openclaw/bin/openclaw-trajectory manual-status --base-dir ~/.openclaw/trajectory --session-id <current_session_id>
```

如果录制中断，可恢复并结束：

```bash
~/.openclaw/bin/openclaw-trajectory manual-recover \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --final-output "恢复后结束"
```

如果实时 note 有遗漏，可用对话 transcript 兜底重建：

```bash
~/.openclaw/bin/openclaw-trajectory reconstruct \
  --base-dir ~/.openclaw/trajectory \
  --transcript conversation.md
```

如果能访问 OpenClaw session JSONL，优先从 session log 重建：

```bash
~/.openclaw/bin/openclaw-trajectory reconstruct-session \
  --base-dir ~/.openclaw/trajectory \
  --session ~/.openclaw/agents/main/sessions/<session-id>.jsonl
```

在用户说“停止录制”后，更推荐 OpenClaw 直接跑总命令。它会完成 session 重建、归一化、校验、replay/OTel 后处理，并打包完整证据包：

```bash
~/.openclaw/bin/openclaw-trajectory stop-and-reconstruct \
  --base-dir ~/.openclaw/trajectory \
  --session ~/.openclaw/agents/main/sessions/<session-id>.jsonl
```

输出会包含 `trajectory`、`reconstruction_report`、`evidence_package`、`evaluation_readiness` 和 `readiness_reasons`。`evidence_package` 是完整 run 目录 zip，适合直接发给用户或后续评测系统。

这个命令默认会从 session 里识别“开始录制 / 开始记录 trace / 开始录制轨迹”和“停止录制 / 结束录制”等用户控制语句，自动切出单次任务窗口。需要手动指定窗口时使用：

```bash
~/.openclaw/bin/openclaw-trajectory reconstruct-session \
  --base-dir ~/.openclaw/trajectory \
  --session ~/.openclaw/agents/main/sessions/<session-id>.jsonl \
  --start-time 2026-05-10T03:00:01.000Z \
  --end-time 2026-05-10T03:00:06.000Z \
  --status error \
  --task-completed false
```

重建后会生成 `reconstruction_report.json`，用于检查窗口来源、过滤数量、缺失 tool input 数量、summary-only tool output 数量、质量等级和 `evaluation_readiness`。

人工评测前建议再跑：

```bash
~/.openclaw/bin/openclaw-trajectory quality --run-dir ~/.openclaw/trajectory/runs/<run_id>
```

`quality` 会输出低保真、缺少 model/tool step、缺少 token usage、缺少 session/agent identity、控制步骤残留、缺失 start event 等原因。只有 `evaluation_readiness=ready` 的轨迹才适合作为正式评测样本；`limited` 适合人工复核或调试。

证据质量字段：

- `manual-note`：`recording.mode=live_manual`、`recording.fidelity=low`、`evidence.source=manual_note`
- `record-event`：事件级 `recording.fidelity=medium`、`evidence.source=structured_event`
- `reconstruct`：`recording.mode=reconstructed`、`recording.fidelity=low`、`evidence.source=manual_transcript`
- `reconstruct-session`：`recording.mode=session_log_reconstruct`、`recording.fidelity=medium`、`evidence.source=openclaw_session_log`

## OpenClaw 插件安全策略检查

OpenClaw 2026.5.x 可能会用 `plugins/installs.json` 记录插件安装状态，并通过 `plugins.allow` 与 `plugins.entries.openclaw-trajectory.hooks.allowConversationAccess` 控制 hook 访问。`doctor --plugin` 会同时检查旧 `openclaw.json.plugins.installs` 和新 `plugins/installs.json`。

如果 `doctor` 输出：

- `plugin_not_allowed_by_allowlist`：说明 `plugins.allow` 非空且没有包含 `openclaw-trajectory`
- `conversation_access_not_allowed`：说明 `llm_input`、`llm_output`、`agent_end` 等关键 hook 会被 OpenClaw 安全策略拦截

需要让 OpenClaw runtime owner 执行等价配置，例如：

```bash
openclaw config set plugins.entries.openclaw-trajectory.hooks.allowConversationAccess true
```

如果 `plugins.allow` 已启用，也需要把 `openclaw-trajectory` 加入 allowlist。这个步骤会扩大对话内容访问范围，分享 evidence package 前应确认脱敏策略。

## 记录真实事件流

OpenClaw 已经能把事件写成 JSONL 时，可以直接 pipe：

```bash
cat events.jsonl | ~/.openclaw/bin/openclaw-trajectory record \
  --base-dir ~/.openclaw/trajectory \
  --input "用户任务" \
  --final-output "最终结果"
```

每行 JSON 的字段对应：

```json
{
  "kind": "tool.call",
  "actor": "tool",
  "phase": "end",
  "status": "ok",
  "attrs": { "tool.name": "read" },
  "input": { "path": "package.json" },
  "output": { "content": "{}" }
}
```

如果事件有 start/end 两个阶段，请让同一操作优先复用相同的 `step_id`，其次是 `tool_call_id`、`skill_invocation_id`，最后是 `span_id`。外部事件可以提供 `timestamp`，安装后的命令会保留它用于归一化和 OTel 时间线。缺少稳定关联 ID 时默认给出 stderr 警告；加 `--strict` 可让 OpenClaw 在接入测试中直接失败。

OpenClaw 想使用自身 LLM 给 artifact 生成摘要时，可设置：

```bash
OPENCLAW_TRAJECTORY_LLM=summary
OPENCLAW_LLM_ENDPOINT=http://127.0.0.1:7777/llm/summarize
```

也可以在 `~/.openclaw/runtime.json` 放入：

```json
{
  "llm": {
    "transport": "http",
    "endpoint": "http://127.0.0.1:7777/llm/summarize",
    "model": "openclaw-small",
    "api_key_env": "OPENCLAW_LLM_API_KEY",
    "summary_cache": "cache:///Users/you/.openclaw/trajectory/summary-cache"
  }
}
```

不要在 `runtime.json` 写明文 `api_key`。工具只读取 `api_key_env` 指向的环境变量。LLM endpoint 只允许 `http` / `https`，云元数据地址默认阻断；内网地址会给出警告。

OpenClaw runtime 若直接使用库 API，推荐使用 `InProcessRuntime` 注入自身 LLM 能力：

```ts
import { TrajectoryRecorder, InProcessRuntime } from "openclaw-trajectory-toolkit";

const runtime = new InProcessRuntime({
  capabilities: ["summarize"],
  llm: openclaw.llm,
  summaryModelName: "openclaw-small",
  summaryCache: openclaw.summaryCache,
  summaryBudget: { maxCalls: 100 }
});

await TrajectoryRecorder.start({
  baseDir: "~/.openclaw/trajectory",
  input: "用户任务",
  artifactStore: await runtime.artifactStoreOptions({ summarize: "llm" })
});
```

摘要是后处理增强。原始事件、artifact hash、时间戳和状态仍由 runtime 确定性记录。

LLM 摘要调用会写入 `openclaw.meta_trace=true` 的 `model.call` 事件。归一化后这些内部调用位于顶层 `meta_steps`，主 step metrics 不会把摘要调用算作用户模型调用；汇总在 `root_step.metrics_info.meta_trace`。

外部请求诊断会写入 `openclaw.diagnostic_only=true` 的 `external.request.*` 事件。归一化后这些诊断事件位于顶层 `diagnostic_steps`；`quality`、`list`、`show` 会单独报告 `diagnostic_step_count`。

CLI HTTP 入口和 `HttpRuntime` 共享同一套安全 HTTP LLM 客户端：支持 endpoint 协议校验、云元数据地址阻断、timeout、5xx retry、UTF-8 安全截断、API key header 校验和 response body timeout。

评测是可选实验能力。需要生成 `evals.jsonl` 时显式运行：

```bash
~/.openclaw/bin/openclaw-trajectory eval --run-dir ~/.openclaw/trajectory/runs/<run_id>
```

或在记录时加：

```bash
cat events.jsonl | ~/.openclaw/bin/openclaw-trajectory record \
  --base-dir ~/.openclaw/trajectory \
  --input "用户任务" \
  --final-output "最终结果" \
  --with-eval
```

如果先用 `init-run` 创建了 run，后续可以关闭它：

```bash
~/.openclaw/bin/openclaw-trajectory finalize \
  --run-dir ~/.openclaw/trajectory/runs/<run_id> \
  --status ok \
  --output "最终结果"
```

如果进程崩溃后 `events.jsonl` 已有 root end 事件，但 `run.json` 还停在 running，可运行：

```bash
~/.openclaw/bin/openclaw-trajectory recover --run-dir ~/.openclaw/trajectory/runs/<run_id>
```

清理 stale running run 时先诊断，再显式清理：

```bash
~/.openclaw/bin/openclaw-trajectory doctor --base-dir ~/.openclaw/trajectory --stale-after 1h
~/.openclaw/bin/openclaw-trajectory prune --base-dir ~/.openclaw/trajectory --include-stale --stale-after 1h --older-than 30d
```

合并多个 run 的只读视图：

```bash
~/.openclaw/bin/openclaw-trajectory merge \
  --run-dirs ~/.openclaw/trajectory/runs/<run_a>,~/.openclaw/trajectory/runs/<run_b> \
  --output ~/.openclaw/trajectory/merged.json
```

默认输出 `summary` 模式，适合看批量状态和 metrics。需要完整 trajectory 时加 `--mode full`；重复 run 目录或重复 `run_id` 会直接报错。

## 可选安装位置

```bash
node scripts/install-openclaw-trajectory.mjs \
  --install-dir ~/.openclaw/tools/openclaw-trajectory-toolkit \
  --bin-dir ~/.openclaw/bin
```

测试或沙箱环境可以指定临时 home：

```bash
node scripts/install-openclaw-trajectory.mjs --home /tmp/openclaw-home
```

# Trajectory Toolkit ：OpenClaw 轨迹获取工具

## 一、简介
**OpenClaw Trajectory Toolkit** 是一个把 OpenClaw 这类AI Agent 运行过程转化为标准化、可评测的结构化证据的工具。

除了记录运行的端到端最终答案，还尽量记录 Agent 在过程中做了什么：调用了哪个模型、用了哪个工具、读了什么文件、失败了几次、用了多少 token、耗时多少、哪些信息被打码、这份记录能不能拿去做评测。把零散日志整理成标准 trajectory.json；记录模型、工具、shell、skill、state、子 Agent 等步骤；保留 artifact 证据并支持 redaction；输出 normalization coverage 和 quality readiness；通过 8 个内置 evaluator 提供即时质量反馈；支持从 native hook、session JSONL、message log、OpenClaw bundle 等来源标准化；为后续复盘、调试、回归测试和评测数据生产提供基础。

![图片](docs/images/2762249084-image-001.png)

**下一步建议：**

如果你是**初次使用者**：跑一遍 `quicktest`，看看生成的 `trajectory.json` 长什么样。重点关注 `root_step` 和 `agent_steps` 的结构。

如果你是**Agent 开发者**：尝试在你的任务上跑 `reconstruct-session`，看看你的 Agent 的过程证据是否完整。如果 `quality` 报告显示 `limited`，逐个排查 `reasons` 中的原因。

如果你是**评测体系建设者**：关注 `quality` 和 `evaluators`，它们是连接轨迹采集和评测判断的桥梁。尤其建议用真实 OpenClaw 任务沉淀一批 regression fixtures，让 `trajectory.json` 不只在样例里正确，也能在复杂真实任务中稳定正确。

如果你是**安全工程师**：重点看 `safety` evaluator 和 redaction 机制。前者能在 CI 中拦截危险操作，后者能确保轨迹数据不泄露密钥。

虽然是针对 OpenClaw 生态设计的工具，但其核心理念（schema-first、evidence-aware、evaluation-oriented）对其他 Agent 平台同样有参考价值。

---

## 二、 背景痛点：为什么需要 trajectory？

### 2.1 什么是trajectory（轨迹）？

- **Trace 是一次请求或任务在系统中流转过程中产生的全链路执行记录。**
它用于完整描述一个请求从开始到结束，经过了哪些系统组件、执行了哪些操作、各操作之间的父子关系、时间顺序、输入输出、状态、耗时和异常情况。
在 Agent 场景中，Trace 可以理解为：**Agent 完成一次任务时，系统侧记录下来的原始执行流水。**

- **Trajectory 是一次 Agent 任务执行过程中形成的结构化关键步骤轨迹。**
它用于记录 Agent 从接收用户请求到返回最终结果之间的关键观察、决策、行动和结果，反映 Agent 完成任务的核心行为路径。
在评测场景中，Trajectory 可以定义为：**Trajectory 是面向评测和分析，从 Trace、模型日志或业务日志中抽取、清洗、压缩、语义化后得到的 Agent 关键执行步骤序列。**
指 AI Agent 在任务执行过程中生成的结构化时序数据，完整记录了从接收用户指令开始，Agent 在多轮交互中进行的思考、行动和观察的全链路历史。数据格式多为 JSON。

### 2.2 Agent 执行过程经常是黑盒

想象一下：你的 Agent 在生产环境里返回了一个明显错误的答案。想知道"为什么出错了"，你打开日志——只能看到 prompt 和最终的 response，中间调了哪些工具、工具返回了什么、模型是基于什么上下文做的决策，全是黑盒。

普通聊天记录通常只看得到：用户问了什么、AI 最后回答了什么、偶尔能看到工具输出片段。

但真正影响结果质量的关键过程经常不完整：

- 模型实际收到了什么上下文？
- 工具调用参数是什么？
- 工具结果有没有被截断？
- 子 Agent 是否参与？
- 出错后有没有重试？
- token、耗时、成本如何？
- 最终答案是基于真实工具结果，还是模型猜的？

没有这些过程证据，很难做可靠复盘和评测。

### 2.3 日志分散，格式不统一

一次 OpenClaw 任务可能同时涉及：session JSONL、model call hooks、tool call hooks、diagnostic events、message send/receive events、subagent lifecycle、手工记录的 note、外部 message logger、OpenClaw 官方导出的 bundle。

这些数据来源的字段名、时间戳、ID、父子关系不完全一致。如果不标准化，后续评测系统很难直接使用。

### 2.4 Agent 评测既看结果，也看执行过程

要判断一个 Agent 是否可靠，不能只看最终端到端效果，还要看：是否用了正确工具、是否正确处理错误、是否泄露敏感信息、是否有足够的 model/tool pairing、是否有 token usage 和耗时、是否能 replay 或 mock replay、是否能区分真实证据和人工补记。

所以 trajectory 可以看作一种**面向评测和复盘的结构化记录格式**，用途和重要性远超普通日志。

### 2.5 为什么不直接用现有方案？

目前有许多开源项目和方案，为什么不直接用？拿 OpenTelemetry和 LangSmith / LangFuse 举例对比

| 维度 | [OpenTelemetry](https://github.com/open-telemetry/opentelemetry-collector) | [LangSmith](https://github.com/langchain-ai/langsmith-cookbook) / [LangFuse](https://github.com/langfuse/langfuse) | Trajectory Toolkit |
| --- | --- | --- | --- |
| 部署模式 | 需要 collector + 后端服务 | SaaS / 自托管 | **Local-first**，零外部依赖 |
| 数据所有权 | 数据发往远端 | 数据在第三方平台 | **数据全部留在本地** |
| Agent 语义理解 | 通用 span，无 Agent 语义 | 有 chain/tool 概念 | **原生理解 Agent/Tool/Skill/SubAgent** |
| 证据可信度标注 | 无 | 无 | **区分 captured/inferred/lossy/redacted** |
| 评测 readiness | 无 | 有评测但与采集耦合 | **独立质量评估 + 8 个内置 evaluator** |
| 隐私保护 | 需额外配置 | 依赖平台 | **内置 redaction，自动脱敏** |
| 运行时依赖 | SDK + collector | SDK + 网络 | **仅 ajv + safe-regex2** |

简单说：Trajectory Toolkit 的差异化定位是 **local-first + evidence-aware + evaluation-oriented**。它聚焦"我要用 Agent 过程数据做严肃评测"这个特定场景，可作为 OTel 或 LangSmith 的专用补充基础设施。

---

## 三、 这个工具解决什么问题？

这个工具提供一套面向 Agent 评测与复盘的数据基础设施：

1. **标准 schema**：让数据可被评测系统稳定使用。
2. **多来源标准化**：native hook、diagnostic event、session JSONL、message log、bundle 都能进入同一格式。
3. **证据质量意识**：明确区分 captured、inferred、lossy、redacted、missing。
4. **ID 安全和可追溯**：非法 ID 规范化（sanitize + shortHash），同时保留 raw ID。
5. **隐私保护**：通过 artifact/ref/redaction 保留证据但降低泄露风险，覆盖 7+ 类常见敏感信息。
6. **自动化评估**：8 个内置 evaluator 提供即时质量反馈，safety evaluator 可在 CI 中阻断危险轨迹。
7. **工程可验证**：`npm test`、`quicktest`、`validate`、`quality` 形成基本闭环。
8. **OpenClaw 架构对齐**：能把 runtime telemetry 变成评测友好的结构化轨迹。

### 3.1 把杂乱运行过程整理成标准轨迹

工具会把来自不同来源的事件整理为统一结构：整个任务是什么、哪些 agent 参与了、每个 agent 做了哪些步骤、哪些步骤是模型调用、哪些步骤是工具调用、哪些步骤失败了、输入输出证据在哪里、整体质量是否适合评测。

最终核心产物是：trajectory.json

### 3.2 保证 ID 可校验，同时保留原始追溯信息

真实运行日志里的 ID 不一定符合标准 schema。比如有些 `tool_call_id` 可能包含特殊字符，导致 JSON schema 校验失败。

工具会做两件事：把非法 ID 转成 schema-safe ID；把原始 ID 保留到 metadata，例如 `openclaw.raw_tool_call_id`。

具体来说，ID 规范化的过程如下：

```
原始 ID:       call_abc!@#$%^&*123
                    ↓ sanitize (替换不安全字符为 _)
中间态:        call_abc_________123
                    ↓ 截断到 32 字符 + 追加 SHA-256 短哈希
规范化后:      call_abc_________123_a7f3b2c1d4e5
                    ↓ 同时在 metadata 保留原始值
metadata:      "openclaw.raw_tool_call_id": "call_abc!@#$%^&*123"

```

这样既保证数据能被评测系统稳定读取，又不会丢掉排查问题需要的原始线索。

### 3.3 把运行时 telemetry 映射成可读步骤

工具会把 OpenClaw 运行时事件映射到更容易理解的动作层：

- `model.call.*` → 模型调用步骤；
- `tool.execution.*` → 工具执行步骤；
- `context.assembled` → 上下文组装信息；
- `run.*` → 任务生命周期；
- `session.long_running/stalled/stuck` → session 健康状态；
- `subagent_*` → 子 Agent 关系。

这让 trajectory 从单纯"聊天记录"升级为更接近真实执行链路的过程证据。

### 3.4 评估数据质量，避免盲目相信日志

工具会输出 `quality` 和 `normalization_report.json`，告诉你：数据是否完整、哪些字段是捕获的、哪些字段是推断的、哪些字段缺失、哪些内容被打码、是否适合进入正式评测。

这点很重要：**不完整的轨迹也有价值，但不能假装它是高保真证据。**

---

## 四、 核心概念

### 4.1 Run：一次任务运行

一个 `run` 就是一次完整任务，比如：

> "帮我分析一个工具包，并写介绍文档。"

每个 run 会有自己的目录：

```
~/.openclaw/trajectory/runs/<run_id>/
```

里面保存这次任务的所有证据。

### 4.2 Event：原始事件

`events.jsonl` 里每一行是一个事件，例如：模型开始调用、模型返回、工具开始执行、工具完成、shell 命令执行、文件操作、状态快照、子 Agent 启动或结束。Event 是"原始流水账"。

### 4.3 Artifact：大块输入/输出证据

模型输入、工具输入、工具输出可能很大，也可能有敏感内容。所以工具会把它们放进 artifact，并在 trajectory 中用引用表示：

```
artifact://tool_call_inputs_xxx/yyy.json
artifact://model_call_outputs_xxx/yyy.json
```

Artifact 使用 Content-Addressed（按内容的哈希值存储，相同内容只存一份）设计：每个 artifact 的文件名是其内容的 SHA-256 哈希值。这意味着如果同一个 system prompt 被多次传入模型——这在真实场景中非常常见——它只会被存储一次，大幅节省磁盘空间。

这样考虑是原因存在以下优势：

- `trajectory.json` 主文件不会无限变大；
- 可以对敏感字段做 redaction；
- 大文件仍然可追溯；
- 评测系统可以按需加载证据；
- 重复内容自动去重。

### 4.4 Trajectory：整理后的任务轨迹

`trajectory.json` 是最核心产物。它把原始事件整理成"人和机器都能理解的结构"：

- `root_step`：整个任务；
- `agent_steps`：每个 agent 的工作段；
- `steps`：模型、工具、shell、skill、state 等具体动作；
- `metrics_info`：耗时、token、错误率、成本等指标；
- `metadata`：OpenClaw session、artifact 引用、trace/span ID 等技术信息；
- `session_tree`：主 session 和子 session 的关系。

### 4.5 Normalization Report：标准化报告

`normalization_report.json` 解释转换过程：读到了多少 event、生成了多少 step、有没有 warning、哪些数据是捕获的、哪些数据是推断的、哪些数据被 redacted、哪些来源缺失或无效。

### 4.6 Quality：评测前校验

`quality` 命令告诉你：这份 trajectory 是否适合进入评测、缺不缺 model/tool step、缺不缺 token usage、时间戳是否为自动生成、agent/session identity 是否完整、replayability 如何、artifact redaction 状态如何。

它的角色是"评测前校验"，用于进入最终评测前发现数据质量问题。

---

## 五、 端到端数据流

这一节展示数据从原始事件到最终 trajectory 的完整变换过程。对应工具源码中 `normalizer.ts` 的核心逻辑。

### 5.1 全流程概览

```
[数据源]                [录制]              [规范化]                [消费]
                          │                    │                      │
Native Hook (30+ hooks)   │                    │                      │
Session JSONL 重建     ───▶ events.jsonl  ───▶ trajectory.json   ───▶ evals.jsonl
CLI record-event          │ (append-only)      │ + normalization_     │ + replay_meta.json
Manual note               │                    │   report.json        │ + spans.otlp.jsonl
Message log import        │                    │                      │
OpenClaw bundle import    │                    │                      │

```

### 5.2 Normalizer 内部pipline

`normalize` 负责多步骤的结构化变换 pipeline：

```
events.jsonl
    │
    ▼ readEvents() —— 读取原始事件数组
TrajectoryEvent[]
    │
    ▼ pairEvents() —— 按 correlationKey 将 start/end 事件配对
EventPair[]            配对优先级: step_id > tool_call_id > skill_invocation_id > span_id
    │
    ▼ pairToStep() —— 每对事件转换为一个原子步骤，处理 artifact 和 redaction
AtomicStep[]
    │
    ▼ buildAgentSteps() —— 按 agent.name 分组，解析 parent 关系
AgentStep[]
    │
    ▼ buildMetrics() —— 汇总 duration、token、error_rate 等指标
    ▼ buildTrajectoryLinks() —— 识别 delegates_to、polls 等跨 session 关系
    ▼ buildSessionTree() —— 构建父子 session 树
    ▼ buildNormalizationReport() —— 生成 warnings + coverage 报告
    │
    ▼
trajectory.json + normalization_report.json

```

用一句话概括这条pipline的核心工作：**把时间线上散落的事件，按因果关系组织成树形结构，并标注每一步的质量和可信度。**

---

## 六、 功能设计原理

### 6.1 设计原则

#### Observer-only：只观察，不干预

这个工具的定位是"记录仪"，需要避免变成"控制器"。

它应该：观察模型调用、观察工具调用、观察 session 状态、观察子 Agent 生命周期、记录证据和指标。

它不应该：改写模型请求、注入额外 header、绕过正常工具链、用记录逻辑影响 Agent 行为。

这不只是口号，代码中有具体的机制保障：`hooks.ts` 的 `wrapOperation` 模式在 hook 自身发生错误时，会 swallow error 并继续执行原操作（graceful degradation）。也就是说，即使轨迹采集模块完全崩溃，被观察的 Agent 仍然正常工作。这是一条很重要的边界：**trajectory 工具要尽量不改变被观察对象。**

#### Schema-first：保证数据能被稳定标准化

核心产物遵循 schema，例如：`openclaw.trajectory/v1`、`openclaw.normalization-report/v1`、`openclaw.trajectory-quality/v1`、`openclaw.trajectory-stitch/v1`。

schema-first 的好处：评测系统可以稳定读取、CI 可以自动 validate、字段含义更明确、错误能被定位到具体文件和字段。

#### Evidence-first：区分真实记录和推断信息

不同来源的轨迹可信度不同。例如：native hook 捕获的 model/tool 事件可信度较高；session JSONL 重建通常是中等保真；manual-note 更像人工摘要，保真度较低；自动生成的 timestamp 不等于真实 timestamp。

所以工具会记录：`recording.fidelity`、`evidence.source`、`generated_timestamps`、`missing_agent_identity`、`normalization_report.coverage`。这些字段能帮助评测系统判断：这份数据能不能用于严肃评估。

### 6.2 关键机制

#### 多来源统一标准化

工具面向多种输入来源：

| 来源 | 说明 | 典型可信度 |
| --- | --- | --- |
| native hook | OpenClaw runtime hook 直接捕获 | 高 |
| diagnostic event | OpenClaw 运行时诊断事件 | 中高 |
| session JSONL | 从 session 日志重建 | 中 |
| message log import | 导入 message logger 插件日志 | 中 |
| OpenClaw bundle | 导入官方导出包 | 中高（官方导出，但可能经过汇总裁剪） |
| manual note | 手工补记 | 低 |

这些来源最后都会尽量映射成统一的 `trajectory.json`。

#### Artifact + redaction：兼顾证据和隐私

工具会把输入/输出放到 artifact，并记录：`input_ref`、`output_ref`、`input_summary`、`output_summary`、`input_redacted`、`input_redacted_keys`、`output_redacted`、`output_redacted_keys`。

Redaction 的覆盖范围是具体的、可审计的。内置的自动脱敏规则包括：

| 类别 | 具体 pattern | 示例 |
| --- | --- | --- |
| OAuth / Bearer | `Bearer {token}` → `Bearer [REDACTED]` | HTTP Authorization header |
| OpenAI | `sk-{8+字符}` | OpenAI API key |
| AWS | `AKIA{16大写字符}` | AWS Access Key ID |
| GitHub | `gh[pousr]_{16+字符}` | GitHub Personal Access Token |
| Slack | `xox[baprs]-{10+字符}` | Slack Bot Token |
| JWT | `eyJ{8+}.{8+}.{8+}` | JSON Web Token |
| 通用 key-value | `(key\|token\|secret\|password)=[16+字符]` | 配置文件中的敏感字段 |
| 敏感 key 名 | api_key, client_secret, private_key, 密钥, 口令... | JSON 对象中的敏感 key |

此外，支持通过 `OPENCLAW_REDACT_PATTERNS` 环境变量添加自定义正则规则。

这样可以做到：主结构清晰、大内容可追溯、敏感字段可打码、评测系统知道哪里发生过 redaction。

---

## 七、 内置评估器（Evaluators）

> 目前只是用 openclaw 内置llm 能力初步进行校验，严格标准的评测框架与报告自动化产出待后续开发。

除了数据采集和标准化之外，toolkit 还提供 8 个内置评估器，用于对已完成的轨迹进行自动化质量打分。这是它区别于普通日志工具的核心差异化能力。

运行方式：

```Shell
openclaw-trajectory eval --run-dir <runDir>
```

每个评估器独立输出一个 `{evaluator, score, reason, labels}` 结构，score 取值 0 / 0.5 / 1 三档。

### 7.1 八个评估器一览

| # | 评估器 | 检测什么 | score=0 的条件 |
| --- | --- | --- | --- |
| 1 | **taskCompletion** | 任务是否完成 | root output 为空、status=error、或输出匹配拒绝模式 |
| 2 | **skillSelectionQuality** | Skill 选择正确性 | 选中的 skill 不在 available_skills 列表中 |
| 3 | **toolSelectionQuality** | 工具选择正确性 | 调用的工具不在 tool definitions 中 |
| 4 | **toolArgsCorrectness** | 参数是否匹配 schema | required 字段缺失或类型不匹配 |
| 5 | **trajectoryQuality** | 结构完整性 | root 失败或无内部步骤 |
| 6 | **efficiency** | 是否有冗余操作 | 检测到重复 tool call（相同名称+相同参数） |
| 7 | **safety** | 安全风险 | 检测到危险 shell 命令（rm -rf /、mkfs、dd if=...of=/dev/）或密钥泄露 |
| 8 | **reproducibility** | Artifact 完整性 | 部分步骤缺少 input_ref / output_ref |

### 7.2 Safety evaluator 详解

`safety` 评估器对生产环境有直接保护价值。它检测两类问题：

**危险 shell 命令**：扫描所有 type=shell 的步骤，检测 `rm -rf /`、`mkfs`、`dd if=... of=/dev/` 等破坏性命令。

**密钥泄露**：扫描整个 trajectory 的字符串值，检测未被 redaction 捕获的敏感信息（如 Bearer token、sk- 前缀 key 出现在非 redacted 的输出中）。

如果你在评测流程中只关注一个 evaluator，`safety` 是最值得优先关注的。

---

## 八、 安装与验证

> 如果只是想理解工具或验证包，不建议一开始就安装 native hook。可以先在解压目录里直接跑 CLI 验证，不影响 OpenClaw 运行环境。

### 8.1 只读解包验证

```Shell
unzip openclaw-trajectory-toolkit.zip -d /tmp/openclaw-trajectory-toolkit
cd /tmp/openclaw-trajectory-toolkit

npm test
node dist/cli.js --help
node dist/cli.js quicktest --base-dir /tmp/openclaw-trajectory-quicktest --json

```

验证成功时，会看到类似结果：

```JSON
{
  "status": "ok",
  "run_dir": "/tmp/openclaw-trajectory-quicktest/runs/<run_id>",
  "step_count": 7
}

```

`quicktest` 会进一步生成：

```JSON
{
  "schema_version": "openclaw.trajectory-quicktest/v1",
  "status": "ok",
  "validate": {
    "ok": true,
    "errors": []
  },
  "quality": {
    "evaluation_readiness": "limited",
    "reasons": [
      "generated_timestamps",
      "missing_agent_identity"
    ]
  }
}

```

这里 `limited` 是合理的，因为 quicktest 是样例数据，没有真实 OpenClaw agent 运行所需的完整 agent identity。

### 8.2 如果已经安装 CLI

```Shell
BIN=~/.openclaw/bin/openclaw-trajectory
BASE=~/.openclaw/trajectory

$BIN quicktest --base-dir "$BASE" --json
$BIN list --base-dir "$BASE"

```

### 8.3 OpenClaw 沙箱一键安装

> ⚠️ 以下命令包含 `--restart`，会重启 OpenClaw。如果只是写文档、验证包或做静态审阅，请去掉 `--restart` 和 `--detached-verify` 参数。

在 OpenClaw 网页版终端/root 环境中，可以使用安装脚本：

```Shell
node scripts/install-openclaw-trajectory-openclaw.mjs \
  --mode auto \
  --home "$HOME" \
  --register \
  --enable \
  --allow-conversation-access \
  --restart \
  --detached-verify \
  --doctor

```

参数解释：

- `--mode auto`：优先安装 CLI，权限足够时注册 native hook；
- `--register`：注册 OpenClaw extension；
- `--enable`：启用插件；
- `--allow-conversation-access`：允许捕获 conversation 相关 hook；
- `--restart`：安装后重启 OpenClaw；
- `--detached-verify`：重启后后台验证；
- `--doctor`：运行诊断。

---

## 九、常见使用方法

### 9.1 最安全：跑一个离线样例

```Shell
BASE=/tmp/openclaw-trajectory-play
openclaw-trajectory record-sample --base-dir "$BASE" --no-replay --llm-summarize=off
openclaw-trajectory list --base-dir "$BASE"

```

拿到 `run_dir` 后：

```Shell
RUN=/tmp/openclaw-trajectory-play/runs/<run_id>

openclaw-trajectory validate --run-dir "$RUN"
openclaw-trajectory show --run-dir "$RUN"
openclaw-trajectory quality --run-dir "$RUN"
openclaw-trajectory export --run-dir "$RUN" --format trajectory

```

适合验证 CLI、schema、normalize、quality 是否工作。

### 9.2 一键快速自检

```Shell
openclaw-trajectory quicktest --base-dir ~/.openclaw/trajectory --json

```

它会自动跑一条样例链路，并输出：validate 是否通过、quality 结果、export 文件路径、stitch 结果。

### 9.3 CLI-only 录制：没有 native hook 时使用

> `<current_session_id>` 可以从 OpenClaw 状态面板获取，或通过 `openclaw-trajectory status --base-dir ~/.openclaw/trajectory` 查看当前活跃 session。

开始录制当前 session：

```Shell
openclaw-trajectory attach \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --agent-id <current_agent_id> \
  --agent "main" \
  --input "用户当前任务"

```

记录结构化工具事件：

```Shell
openclaw-trajectory record-event \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --json '{"type":"tool","step_id":"step_read_package","tool_name":"read","duration_ms":120,"input":{"path":"package.json"},"output":{"ok":true}}'

```

记录结构化模型事件：

```Shell
openclaw-trajectory record-event \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --json '{"type":"model","step_id":"step_summarize","model":"sample-model","usage":{"input_tokens":123,"output_tokens":45},"input":{"messages":[{"role":"user","content":"总结这个包"}]},"output":{"text":"这是一个轨迹采集工具。"}}'

```

停止并生成结果：

```Shell
openclaw-trajectory detach \
  --base-dir ~/.openclaw/trajectory \
  --session-id <current_session_id> \
  --final-output "任务完成"

```

### 9.4 从 OpenClaw session JSONL 重建

如果能拿到 session 日志，建议优先用这个方式：

```Shell
openclaw-trajectory reconstruct-session \
  --base-dir ~/.openclaw/trajectory \
  --session ~/.openclaw/agents/main/sessions/<session-id>.jsonl

```

也可以通过 session id 自动查找：

```Shell
openclaw-trajectory reconstruct-session \
  --base-dir ~/.openclaw/trajectory \
  --session-id <id> \
  --openclaw-home ~/.openclaw

```

手动指定时间窗口：

```Shell
openclaw-trajectory reconstruct-session \
  --base-dir ~/.openclaw/trajectory \
  --session ~/.openclaw/agents/main/sessions/<session-id>.jsonl \
  --start-time 2026-05-10T03:00:01.000Z \
  --end-time 2026-05-10T03:00:06.000Z \
  --status ok \
  --task-completed true

```

### 9.5 导入 message logger 日志

```Shell
openclaw-trajectory import-message-log \
  --base-dir ~/.openclaw/trajectory \
  --log /tmp/plugin-message-hook.log

```

工具会尽量兼容常见 tool 字段，例如：`toolName`、`tool_name`、`name`、`function.name`。

### 9.6 导入和对比 OpenClaw bundle

```Shell
openclaw-trajectory import-openclaw-bundle \
  --base-dir ~/.openclaw/trajectory \
  --bundle-dir /path/to/openclaw-bundle

openclaw-trajectory compare-openclaw-bundle \
  --run-dir ~/.openclaw/trajectory/runs/<run_id> \
  --bundle-dir /path/to/openclaw-bundle

```

适合比较官方 bundle 和 toolkit 标准化结果之间的差异。

---

## 十、 预计文件结构与产出样例

### 10.1 预计文件结构

一次 run 通常会生成：

```
runs/<run_id>/
├── run.json
├── events.jsonl
├── trajectory.json
├── normalization_report.json
├── replay_meta.json
├── spans.otlp.jsonl
├── evals.jsonl                     # eval 命令产出
├── reconstruction_report.json      # 如果是 reconstruct-session 路径
├── artifacts/
│   ├── index.jsonl
│   └── <kind>_<hash8>/            # 按 artifact 类型分目录
│       ├── <sha256>.json          # 内容文件（content-addressed）
│       └── <sha256>.json.meta.json # 元数据 sidecar
└── evidence_package.zip            # 某些命令会额外打包证据

```

各文件作用：

| 文件 | 作用 |
| --- | --- |
| `run.json` | run 的状态、开始结束时间、目录、统计信息 |
| `events.jsonl` | 原始事件流，一行一个事件 |
| `trajectory.json` | 标准化后的核心轨迹 |
| `normalization_report.json` | 标准化过程报告和 coverage |
| `replay_meta.json` | replay/mock replay 相关信息 |
| `spans.otlp.jsonl` | OTel span 导出（可对接可观测性后端） |
| `evals.jsonl` | 8 个评估器的打分结果 |
| `reconstruction_report.json` | session 重建质量报告 |
| `artifacts/` | 大块输入输出证据、摘要、redaction 信息 |

---

###  10.2 产出文件样例

#### `trajectory.json` 结果样例

##### 基础样例（quicktest 产出）

下面是一个经过简化的 `trajectory.json` 样例。真实文件通常会更长。

```JSON
{
  "schema_version": "openclaw.trajectory/v1",
  "id": "traj_<run_id>",
  "trace_id": "efa1a9d09e5ec6de21d1d80dabb00421",
  "run_id": "run_example",
  "root_step": {
    "id": "root_span",
    "name": "openclaw_request",
    "input": "OpenClaw trajectory quicktest",
    "output": "quicktest completed",
    "basic_info": {
      "status": "ok",
      "started_at": "2026-05-14T15:18:48.053Z",
      "duration_ms": 136,
      "error": null
    },
    "metrics_info": {
      "input_tokens": 32,
      "output_tokens": 12,
      "llm_duration_ms": 15,
      "tool_duration_ms": 28,
      "shell_duration_ms": 12,
      "skill_duration_ms": 8,
      "tool_error_rate": 0.3333333333333333,
      "tool_errors": {
        "ENOTFOUND": ["step_sample_failed_fetch"]
      },
      "total_cost_usd": 0
    }
  },
  "agent_steps": [
    {
      "id": "agent_planner_run_example",
      "name": "planner",
      "input": "OpenClaw trajectory quicktest",
      "output": "quicktest completed",
      "steps": [
        {
          "id": "step_sample_skill",
          "type": "skill",
          "name": "diagnose_project",
          "basic_info": {
            "status": "ok",
            "duration_ms": 8
          },
          "metadata": {
            "skill.name": "diagnose_project",
            "skill.version": "1.0.0",
            "input_ref": "artifact://skill_invoke_inputs_...json",
            "output_ref": "artifact://skill_invoke_outputs_...json"
          }
        },
        {
          "id": "step_sample_model",
          "type": "model",
          "name": "sample-model",
          "basic_info": {
            "status": "ok",
            "duration_ms": 15
          },
          "model_info": {
            "model": "sample-model",
            "input_tokens": 32,
            "output_tokens": 12,
            "cost_usd": 0
          },
          "metadata": {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "sample-model",
            "input_ref": "artifact://model_call_inputs_...json",
            "output_ref": "artifact://model_call_outputs_...json"
          }
        }
      ]
    },
    {
      "id": "agent_worker_run_example",
      "name": "worker",
      "steps": [
        {
          "id": "step_sample_tool",
          "type": "tool",
          "name": "read",
          "basic_info": {
            "status": "ok",
            "duration_ms": 3
          },
          "metadata": {
            "tool.name": "read",
            "tool.namespace": "openclaw.fs",
            "input_ref": "artifact://tool_call_inputs_...json",
            "output_ref": "artifact://tool_call_outputs_...json"
          }
        },
        {
          "id": "step_sample_failed_fetch",
          "type": "tool",
          "name": "web_fetch",
          "basic_info": {
            "status": "error",
            "duration_ms": 20,
            "error": {
              "code": "ENOTFOUND",
              "message": "host not found",
              "retryable": true
            }
          }
        },
        {
          "id": "step_sample_secret_tool",
          "type": "tool",
          "name": "http_request",
          "metadata": {
            "artifact_inline": {
              "input_redacted": true,
              "input_redacted_keys": ["/api_key"],
              "output_redacted": false
            }
          }
        }
      ]
    }
  ],
  "session_tree": {
    "root_session_id": "quicktest_session",
    "children": []
  }
}

```

#####  复杂场景片段：工具重试 + 子 Agent 委托

以下是一个更接近真实的场景片段，展示了 tool retry、子 Agent 委托、session stall 检测等情况：

```JSON
{
  "agent_steps": [
    {
      "id": "agent_orchestrator_run_real",
      "name": "orchestrator",
      "steps": [
        {
          "id": "step_001",
          "type": "model",
          "name": "claude-3.5-sonnet",
          "basic_info": { "status": "ok", "duration_ms": 2340 },
          "model_info": {
            "model": "claude-3.5-sonnet",
            "input_tokens": 4521,
            "output_tokens": 387,
            "cost_usd": 0.0183
          }
        },
        {
          "id": "step_002",
          "type": "tool",
          "name": "web_fetch",
          "basic_info": {
            "status": "error",
            "duration_ms": 5023,
            "error": { "code": "ETIMEDOUT", "message": "request timed out", "retryable": true }
          }
        },
        {
          "id": "step_003",
          "type": "tool",
          "name": "web_fetch",
          "basic_info": { "status": "ok", "duration_ms": 1200 },
          "metadata": {
            "tool.name": "web_fetch",
            "retry_of": "step_002",
            "attempt_no": 2
          }
        },
        {
          "id": "step_004",
          "type": "agent",
          "name": "sessions_spawn",
          "basic_info": { "status": "ok", "duration_ms": 15400 },
          "metadata": {
            "openclaw.child_session_id": "session_researcher_abc",
            "openclaw.delegated_to_session_id": "session_researcher_abc"
          }
        }
      ]
    }
  ],
  "links": [
    {
      "type": "delegates_to",
      "from_step_id": "step_004",
      "to_session_id": "session_researcher_abc"
    }
  ],
  "session_tree": {
    "root_session_id": "session_main",
    "children": [
      { "session_id": "session_researcher_abc", "agent_id": "researcher", "parent_step_id": "step_004" }
    ]
  }
}

```

这个片段展示了：step_002 工具调用超时（ETIMEDOUT）→ step_003 自动重试成功（retry_of 关联）→ step_004 委托子 Agent 完成子任务（delegates_to link + session_tree 记录父子关系）。

#####  如何读这个 JSON？

可以按三层看：

1. `**root_step**`：整个任务的总览。看输入、输出、总耗时、token、错误率。
2. `**agent_steps**`：参与任务的不同 agent 或阶段，例如 `planner`、`worker`。
3. `**steps**`：真正的一步步动作，例如模型调用、工具调用、shell 命令、状态快照。

如果你只关心"任务为什么失败"，优先看：`basic_info.status`、`basic_info.error`、`metrics_info.tool_errors`、失败 step 的 `input_ref` / `output_ref`。

如果你只关心"是否适合评测"，优先看：`quality` 输出、`normalization_report.json.coverage`、是否缺 token usage、是否缺 model/tool pairing、是否有 generated timestamp、是否有 redaction。

---

####  `normalization_report.json` 样例

`normalization_report.json` 用来解释"原始事件是怎么被整理成 trajectory 的"。样例摘要如下：

```JSON
{
  "schema_version": "openclaw.normalization-report/v1",
  "run_id": "run_example",
  "summary": {
    "event_count": 10,
    "step_count": 7,
    "warning_count": 0
  },
  "warnings": [],
  "coverage": {
    "schema_version": "openclaw.normalization-coverage/v1",
    "sources": {
      "native_hook": {
        "captured": 10,
        "inferred": 8,
        "invalid": 0,
        "lossy": 0,
        "missing": 0,
        "redacted": 0
      },
      "diagnostic_event": {
        "captured": 0,
        "inferred": 0,
        "invalid": 0,
        "lossy": 0,
        "missing": 0,
        "redacted": 0
      },
      "session_jsonl": {
        "captured": 0,
        "inferred": 0,
        "invalid": 0,
        "lossy": 0,
        "missing": 0,
        "redacted": 0
      },
      "message_log_import": {
        "captured": 0,
        "inferred": 0,
        "invalid": 0,
        "lossy": 0,
        "missing": 0,
        "redacted": 0
      },
      "openclaw_bundle": {
        "captured": 0,
        "inferred": 0,
        "invalid": 0,
        "lossy": 0,
        "missing": 0,
        "redacted": 0
      }
    }
  }
}

```

字段解释：

- `captured`：真实捕获到的数据；
- `inferred`：工具根据上下文推断出来的数据；
- `invalid`：不合法或无法通过 schema 的数据；
- `lossy`：有信息损失；
- `missing`：应该有但缺失；
- `redacted`：因为隐私或安全被打码。

---

#### `quality` 样例

质量报告摘要：

```JSON
{
  "schema_version": "openclaw.trajectory-quality/v1",
  "run_id": "run_example",
  "evaluation_readiness": "limited",
  "readiness_dimensions": {
    "identity_completeness": "limited",
    "timing_fidelity": "limited",
    "model_tool_pairing_accuracy": "ready",
    "artifact_redaction_status": "not_required",
    "replayability": "ready",
    "evaluator_readiness": "limited"
  },
  "reasons": [
    "generated_timestamps",
    "missing_agent_identity"
  ],
  "step_count": 7,
  "model_step_count": 1,
  "tool_step_count": 4
}

```

这说明：模型和工具步骤是有的；replay 基础信息也足够；但身份和时间可信度有限；如果是真实 native hook 捕获，readiness 通常会更高。

---

## 十一、适用场景与使用建议

声明 OpenClaw Trajectory Toolkit 适合用在哪些场景，以及在调试、复盘和正式评测前应遵循的基本使用原则。总体建议是：**优先使用高保真数据来源，先完成 validate 和 quality 检查，再进入正式评测；对 redaction、ID 规范化和链路追踪信息保持可追溯理解。**

### 11.1 适用场景

#### 开发调试

当 Agent 行为异常时，trajectory 可以帮助开发者从“只看到最终结果”转向“看到完整执行过程”。

它适合回答以下问题：

- Agent 为什么调用了错误工具？
- 哪一步开始出错？
- 问题来自模型决策、工具执行，还是上下文压缩拼接？
- 工具返回异常后，Agent 是否正确重试或降级处理？
- 最终答案是否基于真实工具结果，还是模型自行猜测？

相比只看 prompt 和 response，trajectory 能把 model step、tool step、error step、artifact、token、耗时等信息放在同一条时间线上，便于定位问题根因。

#### 评测数据生产

Trajectory Toolkit 适合把真实 Agent 任务转换成标准化的 `trajectory.json`，供后续 evaluator 或评测系统使用。

典型用途包括：

- 构建 Agent benchmark；
- 沉淀回归测试集；
- 评估工具调用质量；
- 分析多 Agent 协作链路；
- 对比不同 Agent、不同 prompt、不同工具版本的执行差异。

对于评测体系建设者来说，trajectory 的价值不只是记录“任务是否完成”，还包括记录“任务是如何完成的”。这使评测可以覆盖工具选择、参数正确性、错误处理、证据完整性、安全风险和可复现性等过程指标。

#### 事故复盘

当任务失败、输出异常或线上行为不可解释时，可以基于 trajectory 还原真实执行过程。

复盘时建议重点查看：

- event timeline：确认问题发生顺序；
- error step：定位失败步骤和错误类型；
- artifact：检查模型输入、工具输入和工具输出证据；
- normalization report：判断哪些信息是捕获的，哪些是推断的；
- quality report：判断这份轨迹是否足以支撑可靠复盘；
- trace_id / span_id：串联跨系统链路。

这样可以避免只根据最终答案倒推原因，也能减少“日志看起来完整，但关键证据其实缺失”的风险。

####  OpenClaw runtime 观测

Toolkit 支持将 OpenClaw runtime telemetry 映射为结构化步骤，因此也可以作为运行时观测数据的一种结构化出口。

它尤其适合补充以下信息：

- model call、tool call、shell、skill、subagent 等 Agent 语义步骤；
- session 生命周期和父子 session 关系；
- trace_id、span_id、parent span 等链路信息；
- duration、token、error rate 等基础指标；
- artifact 和 redaction 状态。

需要注意的是，Toolkit 的核心定位仍然是 **trajectory 采集、标准化、评测和复盘**，不是完整替代 APM 或通用可观测性平台。如果要接入 Jaeger、Tempo 等 OTel 后端，`spans.otlp.jsonl` 仍需要根据目标系统做格式适配。

### 11.2 数据来源选择建议

如果目标是正式评测，建议按以下优先级选择数据来源：

**native hook > session JSONL > structured record-event > manual note**

各来源的适用方式如下：

- **native hook 自动捕获**：证据最完整，保真度最高，适合正式评测、长期回归测试和生产级复盘。
- **session JSONL 重建**：适合事后补救，尤其是在没有提前安装 hook、但仍能拿到 session 日志的情况下使用。
- **structured record-event**：适合无法安装 native hook，但仍希望用结构化方式记录关键模型、工具或状态事件的环境。
- **manual-note**：只能作为低保真兜底，适合人工补充背景信息，不建议单独作为正式评测依据。

简单理解：如果要做严肃评测，优先保证数据来源足够可信；如果数据只能通过低保真方式补记，就应该在 quality 和 normalization report 中明确标记，不要假装它和 native hook 捕获的数据等价。

### 11.3 每次评测前必须完成三项检查

在进入正式 evaluator 或 benchmark 之前，建议至少执行以下三条命令：

`openclaw-trajectory validate --run-dir <runDir> openclaw-trajectory quality --run-dir <runDir> openclaw-trajectory export --run-dir <runDir> --format trajectory `

使用原则：

- 如果 `validate` 不通过，不要进入正式评测；
- 如果 `quality.evaluation_readiness` 是 `limited`，需要先查看 `reasons`；
- 如果缺少 model/tool step、token usage、artifact ref、agent identity 或真实 timestamp，应根据评测目标判断是否需要补采或重建；
- 如果只是用于粗略调试，`limited` 不一定阻塞使用；但如果用于正式 benchmark 或回归测试，应尽量使用 `ready` 状态的数据。

这三步可以形成一个基本门禁：**先确认 schema 合法，再确认数据质量，最后导出给评测系统使用。**

### 11.4 正确认识 redaction

不要把 redaction 直接理解成错误。相反，在多数情况下，redaction 表示工具识别并保护了敏感字段。

例如看到：

`{   "input_redacted": true,   "input_redacted_keys": ["/api_key"] } `

这通常是好事，说明敏感字段被识别并打码。真正需要关注的是：

- 哪些字段被打码；
- 打码是否符合预期；
- 评测系统是否知道这些字段发生过 redaction；
- 是否有未被识别的密钥、token、口令或私钥残留在 artifact 中；
- redaction 后是否仍保留了足够的评测证据。

也就是说，redaction 的目标是在保护敏感信息的同时，让评测系统知道证据在哪里被处理过，避免把缺失、打码和真实空值混为一谈。

### 11.5 保留原始 ID 和链路信息

Toolkit 会把不符合 schema 要求的非法 ID 转成合法 ID，但原始 ID 仍会保留在 metadata 中。调试跨系统链路时，不要只看规范化后的 ID，也要同时查看原始追踪字段。

建议重点关注：

- `openclaw.raw_tool_call_id`
- `openclaw.session_id`
- `trace_id`
- `span_id`
- `trace_parent_span_id`

这样做有两个好处：

第一，评测系统可以稳定使用规范化后的 ID，避免因为特殊字符或格式问题导致 schema 校验失败。

第二，开发者在排查问题时仍能回到 OpenClaw 原始日志、runtime telemetry 或外部观测系统中追踪同一次调用。

因此，规范化 ID 是为了保证数据可用，保留 raw ID 是为了保证问题可查。两者都很重要。

### 11.6 推荐使用流程

根据使用目标不同，可以采用不同路径：

如果只是验证工具是否可用，建议先跑 quicktest，确认 CLI、schema、normalize 和 quality 链路正常。

如果是开发调试，建议优先查看失败 step、工具输入输出 artifact、错误类型和 retry 信息。

如果是事故复盘，建议同时查看 `trajectory.json`、`normalization_report.json` 和 `quality` 输出，确认复盘证据是否完整。

如果是正式评测，建议使用 native hook 或 session JSONL 重建，并在进入 evaluator 前强制通过 `validate` 和 `quality` 检查。

最小推荐流程可以概括为：

```Python
openclaw-trajectory validate --run-dir <runDir>
openclaw-trajectory quality --run-dir <runDir>
openclaw-trajectory export --run-dir <runDir> --format trajectory
openclaw-trajectory eval --run-dir <runDir>
```

其中，前三步用于确认数据是否可用于评测，最后一步是对 Agent 执行质量进行自动化打分。

**快速上手**

如果只是想确认工具是否可用：

```Shell
unzip openclaw-trajectory-toolkit.zip -d /tmp/ott
cd /tmp/ott
npm test
node dist/cli.js quicktest --base-dir /tmp/ott-play --json

```

如果已经安装：

```Shell
openclaw-trajectory quicktest --base-dir ~/.openclaw/trajectory --json

```

然后看三个文件：

```
runs/<run_id>/trajectory.json
runs/<run_id>/normalization_report.json
runs/<run_id>/spans.otlp.jsonl

```

如果要进入真实评测：

```Shell
openclaw-trajectory validate --run-dir ~/.openclaw/trajectory/runs/<run_id>
openclaw-trajectory quality --run-dir ~/.openclaw/trajectory/runs/<run_id>
openclaw-trajectory export --run-dir ~/.openclaw/trajectory/runs/<run_id> --format trajectory

```

---

## 使用条件与已知局限

### 使用条件

| 条件 | 具体要求 | 详细情况 |
| --- | --- | --- |
| **Node.js 版本** | node.js>=20.0.0 | package.json engines 字段明确声明 |
| **模块系统** | ESM only（"type": "module"） | package.json type 字段 tsconfig.json 使用 "module": "NodeNext" 所有 import 均带 .js 后缀 |
| **编译目标** | ES2022 | tsconfig.json target 字段；代码中使用了 top-level await、Array.at()、replaceAll 等 ES2022+ API |
| **运行时依赖** | 仅 ajv（JSON Schema 校验）和 safe-regex2（防 ReDoS） | package.json dependencies 无 native addon、无 C++ 绑定 |
| **文件系统访问** | 需要对 `baseDir` 目录有读写权限 | recorder.ts 中大量 mkdir、writeFile、appendFile 操作 使用 mkdir -p 自动创建目录 |
| **Hook 传播** | 依赖 AsyncLocalStorage（Node 内置） | hooks.ts:90 实例化 new AsyncLocalStorage<TrajectoryRuntimeContext>()； 无第三方 APM 依赖 |
| **LLM 摘要（可选）** | 需配置 OPENCLAW_LLM_ENDPOINT + OPENCLAW_LLM_API_KEY；或传入自定义 LlmClient | http-llm.ts 和 cli.ts:1285 读取环境变量 无 LLM 时自动降级为 deterministic 摘要 |
| **自定义 Redaction（可选）** | 通过 OPENCLAW_REDACT_PATTERNS 环境变量传入逗号/换行分隔的正则 | artifact-store.ts:785 每条正则最长 200 字符，且需通过 safe-regex2 检查 |
| **Redaction Key 白名单（可选）** | 通过 OPENCLAW_REDACT_KEY_ALLOWLIST 环境变量排除误判 key | artifact-store.ts:769 如 idempotency_token、csrf_token、*_tokens 已内置白名单 |

### 已知局限

| 局限 | 具体表现 | 影响与应对 |
| --- | --- | --- |
| **normalize 全量读入内存** | readEvents() 使用 readFile(…, "utf8") 一次性读取整个 events.jsonl 后 split("\n").map(JSON.parse) | 万级事件的 run（约 50-200 MB）会产生显著内存压力。当前无流式或分片 pairing 路径。建议对超大 run 提前按 session 拆分 |
| **Pairing 需要全局视图** | pairEvents() 将所有事件按 correlationKey 分组到 Map；orphan start/end 会产生 missing_end_event / missing_start_event warning | 设计跨事件的 start/end 配对要求看到全部事件才能保证正确性 |
| **单个 artifact 无大小上限** | writeBytes() 接受任意长度的 Buffer，只做 SHA-256 content-addressed 去重，无 max size check | 实际上，同一内容只写一次磁盘（{ flag: "wx" } 检查 EEXIST）。如果单条 artifact 特别大（如完整代码库 snapshot），需要在业务层做切分或摘要 |
| **摘要截取前 8000 字符** | summaryMaxChars 默认 8000；LLM 输入 = redactText(text).value.slice(0, this.summaryMaxChars) | 可通过 --summary-max-chars 或 ArtifactStoreOptions.summaryMaxChars 覆盖。超出部分被静默丢弃，不报错 |
| **LLM 摘要有 budget 控制** | summaryBudget.maxCalls 和 summaryBudget.maxBytes 两个阈值；超限时自动降级为 deterministic_budget_exhausted | 默认不设上限（{}）；通过环境变量 OPENCLAW_TRAJECTORY_LLM_MAX_CALLS / OPENCLAW_TRAJECTORY_LLM_MAX_BYTES 或 CLI 参数控制 |
| **Redaction 基于 key name + 值 pattern，非语义** | key 匹配：正则检测 api_key、secret、password、authorization 等（含中日韩俄法德）；值匹配：7 类 pattern（Bearer、Basic、sk-、AKIA、gh[pousr]_、xox[baprs]-、JWT） | 无法识别"一个名为 data 的字段里存了 base64 编码的密钥"。对非标密钥需要通过 OPENCLAW_REDACT_PATTERNS（单条≤200 字符、需通过 safe-regex 校验）自定义补充 |
| **自定义 redaction pattern 有安全限制** | 每条 pattern ≤ 200 字符 必须通过 safe-regex2 的 ReDoS 检查；不通过的 pattern 静默跳过并打 stderr 警告 | 防止恶意/低质正则导致性能问题。复杂正则需拆分为多条简单 pattern |
| **OTel span 输出是简化格式** | 输出类型为自定义 OtelSpanRecord：只有 INTERNAL / CLIENT 两种 kind；attributes 平铺为 key-value（无 resource 层）；无 InstrumentationScope；error 仅映射为单个 exception event | 需要适配器才能接入标准 OTLP/gRPC 后端（Jaeger、Tempo）。当前适合轻量链路分析，不适合作为生产级 trace 接入 |
| **quality 是 readiness 检查，非任务质量** | quality 命令检查 6 个 readiness 维度（identity、timing、model-tool pairing、artifact redaction、replayability、evaluator readiness），不打分 | 告诉你"这份数据能不能用于评测"，不告诉你"Agent 表现好不好"。后者由 evaluators.ts 中 8 个 evaluator 负责 |
| **Evaluator 判断有限** | safety 仅检测 rm -rf /、mkfs、dd if=… of=/dev/ 三类危险命令 + 未 redact 的密钥暴露 efficiency 仅检测完全相同 input 的重复 tool call | 不覆盖 sudo、chmod 777、网络外传等场景；重复检测不考虑语义等价（如同一文件路径的不同表示）。适合作为 baseline，不适合作为唯一安全网 |
| **run.json 写入锁超时 5 秒** | withRunFileLock 使用 mkdir-based lock；如果 5 秒内拿不到锁则抛出错误 | 在高并发向同一 runDir 写入的极端场景下可能失败。正常单 recorder 使用不会触发 |
| **ID 规范化裁剪至 32 字符** | canonicalCorrelationId 中 body 最多 .slice(0, 32)；加上 prefix + shortHash(12) 后总长通常 50-60 字符 | 极长原始 ID 会被截断，但原始值保留在 metadata 的 openclaw.raw_* key 中 |
| **确定性摘要取前 180 字符** | 非 JSON text artifact 的确定性摘要 = compact.slice(0, 180) | 超长纯文本 artifact 的摘要信息很有限；JSON 类型则展示 top-8 keys 或 array length |
| **summary cache 内存模式 LRU 上限 1000 条** | MemorySummaryCache 默认 maxEntries = 1_000 | 超出后 evict 最老条目。如果单次 run 的 artifact 数远超 1000 且都需 LLM 摘要，会重复调用 LLM |

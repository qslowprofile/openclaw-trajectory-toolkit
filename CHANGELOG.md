# Changelog

## 0.9.1

### External diagnostic hardening

- Preserved sanitized external request auth metadata such as `auth.scheme`, `auth.source.type`, `auth.source.id`, `auth.present`, `auth.status`, and `auth.fingerprint` in diagnostic artifacts and normalized metadata.
- Kept generic auth/token/cookie/password redaction strict outside the external request diagnostic schema.
- Added parent tool-call correlation for external request diagnostics when OpenClaw can only provide `parentToolCallId`, including buffered events that arrive before `before_tool_call`.
- Parent external request CLIENT spans now attach to the parent tool span when the tool span is known.

## 0.9.0

### External request diagnostics

- Added safe `external.request.started/completed/failed` diagnostic event support for OpenClaw provider/client/tool-gateway boundaries.
- Added `src/external-request-diagnostic.ts` with deny-by-default sanitization for endpoints, auth metadata, response headers, usage, stream state, response summaries, and provider error summaries.
- Added `diagnostic_steps` to normalized trajectories. Diagnostic-only events are kept out of `agent_steps`, main metrics, evaluation readiness, replay, and tool/model success rates.
- Added `diagnostic_step_count` to `normalization_report.json`, `quality`, `list`, and `show`.
- Added independent external request correlation using `externalRequestId` and diagnostic step/span ids. Parent model/tool ids are recorded only as parent metadata.
- Added guarded collector support for the future `external_request_diagnostic` typed hook and runtime-injected `onExternalRequestDiagnosticEvent`.
- Added OTel CLIENT span export for sanitized external request diagnostics.
- Bumped the install package target to `openclaw-trajectory-toolkit-0.9.0.zip`.
- Added `npm run package:zip` with a runtime-dependency allowlist so published OpenClaw upload zips do not include development dependencies.

## 0.8.6

### Standardization hardening

- Added shared correlation ID canonicalization across recorder paths. Invalid `tool_call_id`, `step_id`, `span_id`, `turn_id`, and `skill_invocation_id` values are rewritten to stable schema-safe ids, with raw values preserved in metadata such as `openclaw.raw_tool_call_id`.
- Expanded native OpenClaw 2026.5.x telemetry mapping for `model.call.*`, `tool.execution.*`, `context.assembled`, `run.*`, `harness.run.*`, and `session.long_running/stalled/stuck`.
- Fixed same-path installer metadata drift by refreshing `plugins/installs.json.installRecords` even when `openclaw plugins install --link` is skipped.
- Added `runtime_version_mismatch` doctor diagnostics when plugin runtime version and install metadata diverge.
- Made the published package smoke test self-contained with `npm test`; full source tests are available through `npm run test:full`.
- Added `quicktest`, `import-openclaw-bundle`, and `compare-openclaw-bundle`.
- Added normalization coverage output under `normalization_report.json.coverage`.
- Improved `import-message-log` compatibility for `toolName`, `tool_name`, `name`, and `function.name` tool fields.
- Added startup scavenger config schema fields to generated OpenClaw plugin manifests.

## 0.8.5

### Native hook reliability

- Made OpenClaw plugin installation idempotent for same-path linked installs and explicit on path conflicts unless `--force-reinstall` is passed.
- Added shared OpenClaw registry parsing for `openclaw.json.plugins.installs`, `plugins/installs.json.installRecords`, `plugins/installs.json.installs`, and array/direct records.
- Connected async OpenClaw diagnostics to the already-registered native collector.
- Added trace aliasing for ingress messages, run ids, session aliases, delayed `agent_end`, and late `llm_output` association.
- Added startup stale-run scavenging for abandoned running runs.
- Added UI projection metadata, context snapshot deduplication, `context.fold` events, session-id log discovery, recursive `stitch`, and message-logger log import.
- Expanded policy diagnostics while keeping the plugin observer-only.

## 0.8.4

### Non-breaking additions

- Added session-scoped `attach` and `detach` commands. Active recording state can now live under `active/<session_id>.json`, so concurrent OpenClaw sessions do not overwrite one another.
- `record-event`, `manual-note`, `manual-status`, `manual-recover`, and `stop-and-reconstruct` accept `--session-id` for session-first workflows.
- Normalization now preserves OpenClaw identity metadata (`openclaw.session_id`, `openclaw.session_key`, `openclaw.agent_id`, `openclaw.agent_name`, `openclaw.message_id`) on root and atomic steps when available.
- Added `trajectory.links[]` and `session_tree` output for delegation and background polling relationships (`delegates_to`, `polls`).
- Added `quality --run-dir <runDir>` for pre-evaluation readiness checks. It flags low-fidelity evidence, missing model/tool steps, missing token usage, generated timestamps, missing session/agent identity, and control-step leakage.
- The OpenClaw plugin entrypoint now exports a synchronous `register(api)` function to match OpenClaw 2026.5.x loader expectations.
- `status` and `doctor --plugin` now recognize both legacy `openclaw.json.plugins.installs` and newer `plugins/installs.json` registry state.
- `doctor --plugin` now reports `plugin_not_allowed_by_allowlist` and `conversation_access_not_allowed` when OpenClaw policy blocks critical hooks.
- The OpenClaw sandbox installer now supports explicit `--allow-conversation-access`, which runs `openclaw config set plugins.entries.openclaw-trajectory.hooks.allowConversationAccess true` before gateway restart.

### Schema field changes

- `trajectory.schema.json` documents `links[]` and `session_tree`.
- `run.schema.json` documents `session_key`, `root_session_id`, `parent_session_id`, `agent_id`, and `agent_name`.

### Migration

- OpenClaw sandbox installs should use `openclaw-trajectory-toolkit-0.8.4.zip`.
- For natural-language flows, prefer `attach --session-id <id>` when the user says “开始录制” and `stop-and-reconstruct --session-id <id>` or `detach --session-id <id>` when the user says “停止录制”.
- If `doctor --plugin` reports conversation access issues, configure `plugins.entries.openclaw-trajectory.hooks.allowConversationAccess=true` in OpenClaw before relying on native model/message hooks.
- Recommended native-hook install command: `node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home "$HOME" --register --enable --allow-conversation-access --restart --detached-verify --doctor`.

## 0.8.3

### Non-breaking additions

- Added CLI-only natural-language manual recording commands: `manual-start`, `manual-note`, `manual-stop`, `manual-status`, `manual-recover`, and `reconstruct`.
- Added `record-event` for appending structured tool/model/shell/file/MCP/skill/state events to an active manual recording or an existing running run directory.
- Added `reconstruct-session` for rebuilding trajectory runs from OpenClaw session JSONL logs.
- `reconstruct-session` now supports explicit `--start-time` / `--end-time` windows and automatically detects natural-language recording markers such as “开始录制轨迹” and “停止录制”.
- Added `stop-and-reconstruct` for the OpenClaw “停止录制” flow. It rebuilds from session logs, normalizes, validates, runs replay/OTel post-processing, and writes a full run evidence zip.
- Added `reconstruction_report.json` with source event counts, filtered counts, missing tool input counts, summary-only tool output counts, quality level, evaluation readiness, and window source.
- Manual live recording now writes `recording.fidelity=low` and `evidence.source=manual_note` instead of implying high evidence quality. Structured events and session reconstruction mark their evidence source separately.
- Added `appendRunDirectoryEvent` for appending structured events to an existing running run directory.
- `OpenClawNativeTrajectoryCollector.flush()` now waits for in-flight finalize and normalize work before returning.

### Schema field changes

- Added `schemas/reconstruction-report.schema.json` for `openclaw.reconstruction-report/v1`.
- `schemas/reconstruction-report.schema.json` documents `evaluation_readiness`, `readiness_reasons`, and `summary_only_tool_output_count`.

### Migration

- OpenClaw sandbox installs should use `openclaw-trajectory-toolkit-0.8.3.zip`.
- In environments where native hook registration needs sudo, install CLI-only and drive recording through `manual-start`, structured `record-event`, and `manual-stop`. Use `manual-note` only as a low-fidelity fallback.

## 0.8.2

### Non-breaking additions

- Split OpenClaw sandbox installation into user-private toolkit install and OpenClaw runtime extension install.
- Added `--mode auto|native|cli-only` to the sandbox installer. `auto` completes native install when permissions allow and otherwise reports an explicit `partial` CLI-only install.
- Added `--openclaw-home` plus runtime home auto-detection for `/mnt/openclaw`, `/root`, and the current user home.
- Added native install preflight checks for extension directory write access, OpenClaw config write access, and `openclaw` command availability.
- Added root completion script generation at `install-extension-as-root.sh` for catclaw-style non-root installs.
- `doctor --plugin` and `status` now distinguish toolkit `--home` from OpenClaw runtime `--openclaw-home`.

### Schema field changes

- `trajectory-openclaw-install-report.schema.json` now accepts `status: "partial"` and documents `mode`, `native_hook_enabled`, `blocked_by`, `root_completion_script`, `root_completion_command`, `openclaw_home`, and `openclaw_config_path`.
- `trajectory-openclaw-install-state.schema.json` now documents `openclaw_home` and `openclaw_config_path`.

### Migration

- OpenClaw sandbox installs should use `openclaw-trajectory-toolkit-0.8.2.zip`.
- Recommended command: `node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home "$HOME" --register --enable --restart --detached-verify --doctor`.
- In CatClaw environments, pass `--openclaw-home /mnt/openclaw` when auto-detection is unavailable.

## 0.8.1

### Non-breaking additions

- Added `scripts/install-openclaw-trajectory-openclaw.mjs` for OpenClaw sandbox one-command installation.
- The sandbox installer runs base install, plugin registration, plugin enable, optional gateway restart, and doctor verification.
- Gateway restart no longer depends on a hard-coded `/run/s6-rc:*` path; the script auto-discovers `*/servicedirs/openclaw` or accepts `--service-dir`.
- Added detached post-restart verifier so installation can finish even when OpenClaw gateway restart interrupts the chat.
- Added `/root/.openclaw/trajectory/install-state.json`, `install-report.json`, and `install.log` outputs for restart-safe status recovery.
- Added JSON Schemas for the OpenClaw sandbox install state and report files.

### Migration

- OpenClaw sandbox installs should use `openclaw-trajectory-toolkit-0.8.1.zip`.
- Recommended command: `node scripts/install-openclaw-trajectory-openclaw.mjs --home /root --register --enable --restart --detached-verify --doctor`.

## 0.8.0

### Breaking

- Install packages should use `openclaw-trajectory-toolkit-0.8.0.zip`.
- The installer now writes a real OpenClaw extension under `~/.openclaw/extensions/openclaw-trajectory`; the legacy `~/.openclaw/plugins/openclaw-trajectory/plugin.json` remains only for local status and doctor compatibility.

### Schema field changes

- `trajectory.schema.json` now accepts atomic step type `agent` for subagent lifecycle capture.
- `trajectory-plugin.schema.json` supported hooks now include session, message, subagent, compaction, and diagnostic hook categories.

### Non-breaking additions

- Added `openclaw-plugin` package subpath and `dist/openclaw-plugin.js` OpenClaw extension entry.
- Added `OpenClawNativeTrajectoryCollector` and `registerOpenClawNativeTrajectory` for native OpenClaw hook capture.
- Native collector subscribes to message, session, model, tool, message-send, agent-end, session-end, compaction, subagent, persistence, and transcript hooks.
- Native collector records deterministic run ids from OpenClaw run ids, preserves original OpenClaw ids in metadata, and finalizes after delayed `agent_end` / `session_end`.
- Native collector correlates `message_sending` / `message_sent` to message tool calls when OpenClaw hook payloads do not carry `toolCallId`.
- Optional diagnostic events can enrich model usage and tool loop observations.
- Installer creates `~/.openclaw/extensions/openclaw-trajectory/openclaw.plugin.json`, `index.mjs`, and an `openclaw plugins install --link ...` next step.
- Added tests for real OpenClaw native hook flow and subagent lifecycle capture.

### Migration

- OpenClaw integrations should prefer `openclaw plugins install --link ~/.openclaw/extensions/openclaw-trajectory`.
- Existing wrapper-style integrations using `TrajectoryHookManager` or `createOpenClawTrajectoryPlugin` continue to work.

## 0.7.0

### Breaking

- Package subpath exports now explicitly expose `./hooks`, `./plugin`, and `./register` for OpenClaw runtime integration.

### Schema field changes

- Added `schemas/trajectory-plugin.schema.json` for `~/.openclaw/plugins/openclaw-trajectory/plugin.json`.
- `schemas/manifest.json` now lists `openclaw.trajectory-plugin/v1`.

### Non-breaking additions

- Added `TrajectoryHookManager` with deterministic wrappers for model, tool, skill, shell, file, MCP, and state operations.
- Added AsyncLocalStorage-based trajectory context propagation so nested hook calls preserve parent span relationships.
- Added `createOpenClawTrajectoryPlugin` and `registerOpenClawTrajectory` for native plugin and preload/register style integration.
- Hook recording failures now degrade trajectory capture without stopping the wrapped OpenClaw operation; callers can inspect `recordingHealth()`.
- Installer now writes `~/.openclaw/plugins/openclaw-trajectory/plugin.json` by default.
- Added `openclaw-trajectory status` and `doctor --plugin` plugin diagnostics.

### Migration

- Existing CLI JSONL ingestion continues to work. New OpenClaw integrations should prefer runtime hooks or plugin registration over model-driven calls.
- Install packages should use `openclaw-trajectory-toolkit-0.7.0.zip`.

## 0.6.1

- Fixed `normalization-report.schema.json` so the emitted `unexpected_phase_mix` warning validates.
- Moved CLI `validate` to the bundled JSON Schemas via Ajv, including run, events, trajectory, normalization report, snapshots, artifact metadata, and artifact index entries.
- Moved Ajv to runtime dependencies and updated the installer to copy the required production dependency closure.
- Added schemas and manifest entries for `openclaw.run-pid/v1`, `openclaw.trajectory-merge/v1`, and artifact index entries.
- Replaced the duplicate `HttpRuntime` fetch code with the shared safe HTTP LLM client used by the CLI path.
- Added endpoint protocol checks, timeout, 5xx retry, UTF-8 safe truncation, API key header validation, response body timeout, and provider response parsing to `HttpRuntime`.
- Made `InProcessRuntime` health usable without an explicit `connect()` call.
- Added lightweight capability probing for `HttpRuntime` through `OPTIONS` when the endpoint supports it.
- Cleaned `pending_*` finalize fields and removed stale `run.pid.json` during `recover`.
- Removed the misleading `watch` alias; `tail` remains a one-shot event tail command.
- Changed `merge` to default to summary output, require `--mode full` for embedded trajectories, and reject duplicate run directories or duplicate `run_id` values.

## 0.6.0

### Breaking

- `normalizeRun` only generates inferred tool / skill specs when `inferSpecs: true` or CLI `--infer-specs=true` is set.
- Inferred specs now live under `step.metadata._inferred` with `spec_quality`, `schema_confidence`, and `spec`.
- Generated recorder step ids are marked with `openclaw.step_id.generated`; normalizer correlation ignores generated step ids and falls back to span ids.
- `agent_step.id` now includes the full `run_id` to avoid collisions when multiple base directories are merged.

### Schema field changes

- `trajectory.schema.json` allows `state.operation="unknown"` and requires `mcp.method.name` for `mcp` steps.
- `artifact.schema.json` now requires `summary`, `redacted`, `redacted_keys`, and `metadata`.
- `normalization-report.schema.json` enumerates known warning codes.
- Added `schemas/manifest.json` to describe the schema version set shipped with the toolkit.
- `step.metadata.state.operation_raw` preserves unknown state operation suffixes.

### Non-breaking additions

- Fixed asymmetric start/end pairing when one event has a supplied `span_id` and both events share a stable `step_id`.
- Fixed nested `parent_span_id` links by rewriting them to atomic step ids; unresolved parents produce `dangling_parent` warnings and attach to the agent step.
- `recover` now repairs `run.json` from an existing root end event in `events.jsonl`.
- `prune` supports `--include-stale --stale-after` for stale running runs.
- Redaction now handles cyclic objects, Chinese sensitive keys, `passcode` / `passphrase`, and Basic auth.
- Artifact metadata records `cycle_detected` and `cycle_paths` for cyclic inputs.
- Added OpenClaw runtime adapter helpers for in-process LLM injection.
- LLM artifact summaries now support structured responses, summary cache, call/byte budgets, runtime.json discovery, safe UTF-8 truncation, API key header validation, and meta-trace `model.call` events.
- `sample-run.jsonl` now covers paired steps, instant state, error steps, multi-agent attrs, shell calls, and secret redaction.

### Migration

- Consumers reading `step.metadata.inferred_spec` should switch to `step.metadata._inferred.spec` and explicitly enable spec inference.
- Consumers building trees from raw `parent_span_id` should use `parent_id` for trajectory hierarchy and `metadata.trace_parent_span_id` for original span linkage.
- Install packages should use `openclaw-trajectory-toolkit-0.6.0.zip`.

## 0.5.0

### Breaking

- Redacted artifact details moved out of `step.input` / `step.output` into `step.metadata.artifact_inline`.
- Atomic step `parent_id` now points to the owning `agent_step.id`; the original span parent is preserved as `metadata.trace_parent_span_id`.
- `redacted_keys` now use JSON Pointer paths, for example `/api_key`.

### Schema field changes

- `artifact.redacted_keys` uses JSON Pointer strings.
- `trajectory.metricsInfo` adds `instant_step_count`.
- `atomicStep.metadata` adds `artifact_inline`, `duration_reported_ms`, `duration_computed_ms`, `duration_source`, and `trace_parent_span_id`.
- `agentStep.metadata.source` is described in schema.
- `event.schema.json` relaxes custom id patterns and allows typed `ids` extensions.
- Added `schemas/mcp-spec.schema.json`; `mcp.schema.json` remains the runtime MCP event/step contract.

### Non-breaking additions

- Added Ajv end-to-end schema conformance tests for generated events, trajectory, and artifact metadata.
- Added `recover`, `validate`, and `prune` CLI commands.
- `list`, `show`, and `doctor` now expose more filtering, diagnostics, metrics, warnings, and artifact size information.
- Added recorder run directory byte stats.
- Added child duration clamp mode for explicit normalization repair.
- Added safer artifact realpath checks to reject symlink escapes.
- Added deterministic summary fallback for redacted artifacts, avoiding LLM calls on redacted content.
- Added LLM request timeout, retry, and body-size controls for the env HTTP client.

### Migration

- Existing v0.4 `events.jsonl` files remain readable.
- Consumers reading `_artifact_ref` from `step.input` should switch to `step.metadata.artifact_inline.input_ref`.
- Consumers using atomic `parent_id` as raw span parent should read `metadata.trace_parent_span_id`.

## 0.4.0

Schema / behavior changes:

- `trajectory.schema.json` now documents `file_duration_ms`, `mcp_duration_ms`, `state_duration_ms`, and `other_duration_ms`.
- `root_step.basic_info.duration_ms` now preserves the root request event window. Child steps outside that window are reported through `normalization_report.json` with `root_window_extended`.
- Redacted artifacts are represented in `trajectory.json` as artifact summaries by default, with `_artifact_ref`, `_artifact_summary`, `_artifact_redacted`, and `_redacted_keys`.
- Artifact content directories now include a hash suffix so similar kinds such as `tool.call` and `tool_call` do not share the same namespace.

Non-breaking additions:

- Added deterministic artifact summaries and an injectable `LlmClient` interface for OpenClaw-provided LLM summaries.
- Added `last_event_at`, recorder `health()`, `recover()`, and `stats()`.
- Redacts sensitive `attrs` before writing `events.jsonl`; added broader secret patterns and `OPENCLAW_REDACT_PATTERNS`.
- Added CLI `list`, `show`, and `doctor`.
- Added `--no-replay`, `--no-otel`, `--llm-summarize`, invalid enum warnings, strict enum rejection, and JSONL parse errors with line numbers.
- Added `schemas/mcp.schema.json`.
- Added example JSONL coverage in tests.
- Installer now excludes personal config directories and can emit a Windows `.cmd` wrapper when run on Windows.

Migration notes:

- Existing v0.3.x `events.jsonl` files remain readable.
- Consumers that expected redacted placeholder values inline should read the artifact ref or run `normalize --artifact-mode inline`.
- Consumers that used root duration as a child-inclusive UI window should switch to step-level ranges plus `normalization_report.json` warnings.

## 0.3.1

- Added normalization warnings for root window extension and reported-vs-timestamp duration mismatches.
- Marked `phase: "event"` steps as instant points.
- Added file, MCP, state, and other duration metrics.
- Used agent metadata for `agent_step.name` when available.
- Shortened shell step names while preserving the full command in metadata.
- Made recorder append failures sticky so later writes cannot hide partial runs.
- Made artifact content and metadata writes more robust under duplicate-content races.
- Added `--version`, `--key=value` parsing, and line-by-line stdin processing for real CLI runs.
- Made read-only replay check missing artifacts.
- Trimmed installed files to runtime essentials.
- Added JSONL examples.

## 0.3.0

- Preserved external event timestamps and stable operation IDs.
- Added `normalization_report.json`.
- Added `finalize` CLI command.
- Made eval generation explicit via `--with-eval` or `eval`.
- Improved OTel-like span timing for inferred starts.

## 0.2.0

- Added start/end pairing, artifact redaction, inferred specs, environment snapshots, and OpenClaw install script.

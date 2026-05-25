import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { normalizeRun } from "./normalizer.js";
import { finalizeRunDirectory, TrajectoryRecorder } from "./recorder.js";
import { OpenClawTraceRegistry } from "./openclaw-trace-registry.js";
import { externalRequestTypes, sanitizeExternalRequestDiagnosticEvent } from "./external-request-diagnostic.js";
const nativeHooks = [
    "message_received",
    "session_start",
    "before_model_resolve",
    "before_prompt_build",
    "llm_input",
    "llm_output",
    "before_tool_call",
    "after_tool_call",
    "external_request_diagnostic",
    "message_sending",
    "message_sent",
    "agent_end",
    "session_end",
    "before_compaction",
    "after_compaction",
    "run.started",
    "run.completed",
    "run.error",
    "model_call_started",
    "model_call_ended",
    "model.call.started",
    "model.call.completed",
    "model.call.error",
    "tool.execution.started",
    "tool.execution.completed",
    "tool.execution.error",
    "tool.execution.blocked",
    "context.assembled",
    "subagent_spawned",
    "subagent_spawning",
    "subagent_delivery_target",
    "subagent_ended",
    "tool_result_persist",
    "before_message_write"
];
export function registerOpenClawNativeTrajectory(api, options = {}) {
    const collector = new OpenClawNativeTrajectoryCollector(api, options);
    collector.register();
    return collector;
}
export class OpenClawNativeTrajectoryCollector {
    api;
    options;
    baseDir;
    finalizeDelayMs;
    normalizeOnFinalize;
    captureMessageEvents;
    captureDiagnostics;
    now;
    startupScavenge;
    startupScavengeStaleAfterMs;
    externalDiagnosticBufferTtlMs;
    runs = new Map();
    latestRunBySession = new Map();
    pendingModelResolveBySession = new Map();
    pendingMessageTools = [];
    traceRegistry;
    systemPromptHashes = new Set();
    historySnapshotHashesByRun = new Map();
    pendingDiagnostics = new Set();
    pendingExternalDiagnostics = new Map();
    activeExternalRequests = new Set();
    externalDiagnosticsDropped = 0;
    diagnosticsUnsubscribe = null;
    externalDiagnosticsUnsubscribe = null;
    startupScavengePromise = null;
    constructor(api, options = {}) {
        this.api = api;
        this.options = options;
        this.baseDir = resolveBaseDir(api, options);
        this.finalizeDelayMs = Math.max(0, numberFrom(options.finalizeDelayMs ?? api.pluginConfig?.finalizeDelayMs, 3000));
        this.normalizeOnFinalize = booleanFrom(options.normalizeOnFinalize ?? api.pluginConfig?.normalizeOnFinalize, true);
        this.captureMessageEvents = booleanFrom(options.captureMessageEvents ?? api.pluginConfig?.captureMessageEvents, true);
        this.captureDiagnostics = booleanFrom(options.captureDiagnostics ?? api.pluginConfig?.captureDiagnostics, true);
        this.startupScavenge = booleanFrom(options.startupScavenge ?? api.pluginConfig?.startupScavenge, true);
        this.startupScavengeStaleAfterMs = Math.max(0, numberFrom(options.startupScavengeStaleAfterMs ?? api.pluginConfig?.startupScavengeStaleAfterMs, 60 * 60 * 1000));
        this.externalDiagnosticBufferTtlMs = Math.max(0, numberFrom(options.externalDiagnosticBufferTtlMs ?? api.pluginConfig?.externalDiagnosticBufferTtlMs, 30_000));
        this.now = options.now ?? (() => Date.now());
        this.traceRegistry = new OpenClawTraceRegistry({ now: this.now });
    }
    register() {
        for (const hookName of nativeHooks) {
            const handler = hookName === "before_message_write"
                ? (event, ctx) => {
                    void this.handleHook(hookName, objectRecord(event), objectRecord(ctx));
                }
                : async (event, ctx) => {
                    await this.handleHook(hookName, objectRecord(event), objectRecord(ctx));
                };
            this.api.on(hookName, handler, { priority: 10 });
        }
        this.attachDiagnostics(this.options.diagnostics);
        if (this.startupScavenge) {
            this.startupScavengePromise = this.scavengeStartupRuns();
        }
        this.log("info", `OpenClaw trajectory native collector registered at ${this.baseDir}`);
    }
    attachDiagnostics(diagnostics) {
        if (!this.captureDiagnostics || !diagnostics)
            return;
        if (diagnostics.onDiagnosticEvent && !this.diagnosticsUnsubscribe) {
            const unsubscribe = diagnostics.onDiagnosticEvent((event) => this.enqueueDiagnostic(event));
            this.diagnosticsUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
        }
        if (diagnostics.onExternalRequestDiagnosticEvent && !this.externalDiagnosticsUnsubscribe) {
            const unsubscribe = diagnostics.onExternalRequestDiagnosticEvent((event) => this.enqueueExternalRequestDiagnostic(event));
            this.externalDiagnosticsUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
        }
    }
    async handleDiagnosticEvent(event) {
        await this.handleDiagnostic(event);
    }
    enqueueDiagnostic(event) {
        const task = this.handleDiagnosticEvent(objectRecord(event)).finally(() => {
            this.pendingDiagnostics.delete(task);
        });
        this.pendingDiagnostics.add(task);
    }
    enqueueExternalRequestDiagnostic(event) {
        const task = this.handleExternalRequestDiagnostic(objectRecord(event)).finally(() => {
            this.pendingDiagnostics.delete(task);
        });
        this.pendingDiagnostics.add(task);
    }
    async flush() {
        await this.startupScavengePromise;
        await Promise.all(this.pendingDiagnostics);
        for (const run of this.runs.values()) {
            if (run.pendingTimer) {
                clearTimeout(run.pendingTimer);
                run.pendingTimer = null;
            }
        }
        await Promise.all(Array.from(this.runs.values()).map((run) => run.finalizePromise ?? this.finalizeRun(run, { status: "ok", output: { flushed: true } })));
        this.diagnosticsUnsubscribe?.();
        this.externalDiagnosticsUnsubscribe?.();
    }
    async handleHook(hookName, event, ctx) {
        try {
            switch (hookName) {
                case "message_received":
                    await this.handleMessageReceived(event, ctx);
                    break;
                case "session_start":
                    this.rememberSessionContext(event, ctx);
                    break;
                case "before_model_resolve":
                    this.handleBeforeModelResolve(event, ctx);
                    break;
                case "before_prompt_build":
                    await this.handlePromptBuild(event, ctx);
                    break;
                case "llm_input":
                    await this.handleLlmInput(event, ctx);
                    break;
                case "llm_output":
                    await this.handleLlmOutput(event, ctx);
                    break;
                case "before_tool_call":
                    await this.handleBeforeToolCall(event, ctx);
                    break;
                case "after_tool_call":
                    await this.handleAfterToolCall(event, ctx);
                    break;
                case "external_request_diagnostic":
                    await this.handleExternalRequestDiagnostic(event);
                    break;
                case "message_sending":
                case "message_sent":
                    await this.handleMessageLifecycle(hookName, event, ctx);
                    break;
                case "agent_end":
                    await this.handleAgentEnd(event, ctx);
                    break;
                case "session_end":
                    await this.handleSessionEnd(event, ctx);
                    break;
                case "before_compaction":
                case "after_compaction":
                    await this.handleCompaction(hookName, event, ctx);
                    break;
                case "run.started":
                case "run.completed":
                case "run.error":
                    await this.handleRunLifecycle(hookName, event, ctx);
                    break;
                case "model_call_started":
                case "model.call.started":
                    await this.handleModelCallStarted(hookName, event, ctx);
                    break;
                case "model_call_ended":
                case "model.call.completed":
                case "model.call.error":
                    await this.handleModelCallEnded(hookName, event, ctx);
                    break;
                case "tool.execution.started":
                case "tool.execution.completed":
                case "tool.execution.error":
                case "tool.execution.blocked":
                    await this.handleToolExecution(hookName, event, ctx);
                    break;
                case "context.assembled":
                    await this.handleContextAssembled(event, ctx);
                    break;
                case "subagent_spawning":
                case "subagent_delivery_target":
                case "subagent_spawned":
                case "subagent_ended":
                    await this.handleSubagent(hookName, event, ctx);
                    break;
                case "tool_result_persist":
                case "before_message_write":
                    await this.handleTranscriptHook(hookName, event, ctx);
                    break;
            }
        }
        catch (error) {
            this.log("warn", `trajectory hook ${hookName} failed: ${errorMessage(error)}`);
        }
    }
    async handleMessageReceived(event, ctx) {
        const sessionKey = stringFrom(ctx.sessionKey ?? event.sessionKey);
        if (!sessionKey)
            return;
        const prebound = this.traceRegistry.prebindMessage(event, ctx);
        this.pendingModelResolveBySession.set(sessionKey, {
            event: {
                ...event,
                "openclaw.ingress_fingerprint": prebound.fingerprint ?? null,
                "openclaw.ingress_route_key": prebound.routeKey ?? null,
                "openclaw.trace_alias_mode": prebound.mode
            },
            ctx,
            eventAtMs: eventTimeMs(event, this.now())
        });
    }
    rememberSessionContext(event, ctx) {
        const sessionKey = stringFrom(event.sessionKey ?? ctx.sessionKey);
        if (!sessionKey)
            return;
        const existing = this.pendingModelResolveBySession.get(sessionKey);
        this.pendingModelResolveBySession.set(sessionKey, {
            event: { ...(existing?.event ?? {}), ...event },
            ctx,
            eventAtMs: eventTimeMs(event, this.now())
        });
    }
    handleBeforeModelResolve(event, ctx) {
        const sessionKey = stringFrom(ctx.sessionKey ?? event.sessionKey);
        if (!sessionKey)
            return;
        const existing = this.pendingModelResolveBySession.get(sessionKey);
        this.pendingModelResolveBySession.set(sessionKey, {
            event: { ...(existing?.event ?? {}), ...event },
            ctx,
            eventAtMs: eventTimeMs(event, this.now())
        });
    }
    async handlePromptBuild(event, ctx) {
        const run = this.latestForSession(ctx, event);
        if (!run)
            return;
        await this.recordInstant(run, {
            kind: "prompt.build",
            actor: "state",
            timestampMs: eventTimeMs(event, this.now()),
            input: {
                prompt: event.prompt ?? null,
                messages: event.messages ?? null
            },
            attrs: {
                "state.operation": "snapshot",
                "openclaw.hook": "before_prompt_build",
                messages_count: Array.isArray(event.messages) ? event.messages.length : null
            }
        });
    }
    async handleLlmInput(event, ctx) {
        const openclawRunId = requireString(event.runId, "llm_input.runId");
        const run = await this.ensureRun(openclawRunId, event, ctx, "llm_input");
        const eventAt = eventTimeMs(event, this.now());
        const span = this.modelSpan(openclawRunId, eventAt, run.recorder.rootSpanId);
        run.modelSpan = span;
        run.lastEventAtMs = eventAt;
        const contextSnapshot = this.contextSnapshotForLlmInput(run, event);
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: "model.call",
            actor: "model",
            phase: "start",
            status: "running",
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            attrs: {
                ...baseAttrs(event, ctx, "llm_input"),
                "gen_ai.request.model": stringFrom(event.model) ?? "unknown",
                "gen_ai.provider.name": stringFrom(event.provider) ?? null,
                "openclaw.llm_hook_scope": "agent_run",
                "openclaw.duration_includes_tools": true,
                images_count: numberOrNull(event.imagesCount)
            },
            input: {
                systemPrompt: contextSnapshot.systemPrompt,
                prompt: event.prompt ?? null,
                historyMessages: contextSnapshot.historyMessages,
                historyMessagesRef: contextSnapshot.historyMessagesRef,
                imagesCount: event.imagesCount ?? null,
                context: contextSnapshot.context
            }
        });
    }
    async handleLlmOutput(event, ctx) {
        const openclawRunId = requireString(event.runId, "llm_output.runId");
        const run = await this.ensureRun(openclawRunId, event, ctx, "llm_output");
        const eventAt = eventTimeMs(event, this.now());
        const span = run.modelSpan ?? this.modelSpan(openclawRunId, eventAt, run.recorder.rootSpanId);
        run.modelSpan = span;
        run.lastEventAtMs = eventAt;
        const usage = objectRecord(event.usage);
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: "model.call",
            actor: "model",
            phase: "end",
            status: event.lastAssistantErrorMessage ? "error" : "ok",
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            attrs: {
                ...baseAttrs(event, ctx, "llm_output"),
                "gen_ai.request.model": stringFrom(event.model) ?? "unknown",
                "gen_ai.provider.name": stringFrom(event.provider) ?? null,
                "gen_ai.usage.input_tokens": numberOrUndefined(usage?.input ?? usage?.promptTokens),
                "gen_ai.usage.output_tokens": numberOrUndefined(usage?.output),
                "gen_ai.usage.cache_read_tokens": numberOrUndefined(usage?.cacheRead),
                "gen_ai.usage.cache_write_tokens": numberOrUndefined(usage?.cacheWrite),
                "gen_ai.usage.total_tokens": numberOrUndefined(usage?.total),
                "openclaw.stop_reason": stopReason(event),
                "openclaw.llm_hook_scope": "agent_run",
                "openclaw.duration_includes_tools": true
            },
            output: {
                assistantTexts: event.assistantTexts ?? null,
                lastAssistant: event.lastAssistant ?? null,
                usage: event.usage ?? null,
                stopReason: stopReason(event)
            },
            error: event.lastAssistantErrorMessage ? { message: String(event.lastAssistantErrorMessage) } : null
        });
        this.traceRegistry.finalizePendingEnd(event, ctx);
        if (run.pendingFinalize) {
            this.scheduleFinalize(run, { status: "ok", output: { reason: "llm_output_after_agent_end" } });
        }
    }
    async handleBeforeToolCall(event, ctx) {
        const openclawRunId = requireString(event.runId ?? ctx.runId, "before_tool_call.runId");
        const toolName = requireString(toolNameFrom(event, ctx), "before_tool_call.toolName");
        const run = await this.ensureRun(openclawRunId, event, ctx, "before_tool_call");
        const toolCallId = stringFrom(event.toolCallId ?? event.tool_call_id ?? ctx.toolCallId ?? ctx.tool_call_id) ?? stableKey("tool", toolName, eventTimeMs(event, this.now()));
        const kindActor = kindActorForTool(toolName, event.params);
        const eventAt = eventTimeMs(event, this.now());
        const span = this.toolSpan(openclawRunId, toolCallId, kindActor.kind, kindActor.actor, eventAt, run.recorder.rootSpanId);
        run.toolSpans.set(toolCallId, span);
        run.lastEventAtMs = eventAt;
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: kindActor.kind,
            actor: kindActor.actor,
            phase: "start",
            status: "running",
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            tool_call_id: toolCallId,
            attrs: {
                ...baseAttrs(event, ctx, "before_tool_call"),
                "tool.name": toolName,
                ...kindActor.attrs
            },
            input: event.params ?? null
        });
        await this.drainExternalDiagnostics(run);
        if (toolName === "message") {
            this.pendingMessageTools.push({
                run,
                span,
                toolCallId,
                beforeAtMs: eventAt,
                afterAtMs: null,
                target: stringFrom(objectRecord(event.params)?.target ?? objectRecord(event.params)?.to),
                channel: stringFrom(objectRecord(event.params)?.channel),
                content: stringFrom(objectRecord(event.params)?.message ?? objectRecord(event.params)?.content)
            });
            this.cleanupMessageTools();
        }
    }
    async handleAfterToolCall(event, ctx) {
        const openclawRunId = requireString(event.runId ?? ctx.runId, "after_tool_call.runId");
        const toolName = requireString(toolNameFrom(event, ctx), "after_tool_call.toolName");
        const run = await this.ensureRun(openclawRunId, event, ctx, "after_tool_call");
        const toolCallId = stringFrom(event.toolCallId ?? event.tool_call_id ?? ctx.toolCallId ?? ctx.tool_call_id) ?? stableKey("tool", toolName, eventTimeMs(event, this.now()));
        const kindActor = kindActorForTool(toolName, event.params);
        const eventAt = eventTimeMs(event, this.now());
        const span = run.toolSpans.get(toolCallId) ?? this.toolSpan(openclawRunId, toolCallId, kindActor.kind, kindActor.actor, eventAt, run.recorder.rootSpanId);
        run.toolSpans.set(toolCallId, span);
        run.lastEventAtMs = eventAt;
        const status = toolStatus(event);
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: span.kind,
            actor: span.actor,
            phase: "end",
            status,
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            tool_call_id: toolCallId,
            attrs: {
                ...baseAttrs(event, ctx, "after_tool_call"),
                "tool.name": toolName,
                ...kindActor.attrs,
                duration_ms: numberOrUndefined(event.durationMs)
            },
            output: {
                result: event.result ?? null,
                durationMs: event.durationMs ?? null
            },
            error: status === "ok" ? null : toTrajectoryError(event.error ?? resultError(event.result) ?? "tool failed")
        });
        await this.drainExternalDiagnostics(run);
        const pendingMessage = this.pendingMessageTools.find((item) => item.run === run && item.toolCallId === toolCallId);
        if (pendingMessage) {
            pendingMessage.afterAtMs = eventAt;
        }
    }
    async handleMessageLifecycle(hookName, event, ctx) {
        if (!this.captureMessageEvents)
            return;
        const eventAt = eventTimeMs(event, this.now());
        const match = this.correlateMessage(event, eventAt);
        const run = match?.run ?? this.latestForSession(ctx, event);
        if (!run)
            return;
        const content = stringFrom(event.content);
        const to = stringFrom(event.to);
        await this.recordInstant(run, {
            kind: hookName === "message_sending" ? "message.sending" : "message.sent",
            actor: "state",
            timestampMs: eventAt,
            parentSpanId: match?.span.spanId ?? run.recorder.rootSpanId,
            input: {
                to,
                content,
                metadata: event.metadata ?? null
            },
            output: hookName === "message_sent" ? { success: event.success ?? null, error: event.error ?? null } : null,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "state.operation": "snapshot",
                "message.to": to,
                "message.channel": event.channelId ?? objectRecord(event.metadata)?.channel ?? null,
                "message.conversation_id": event.conversationId ?? null,
                "message.correlated_tool_call_id": match?.toolCallId ?? null,
                "message.correlation_strategy": match ? "target_content_time_window" : "none"
            },
            status: event.success === false || event.error ? "error" : "ok",
            error: event.error ? toTrajectoryError(event.error) : null
        });
    }
    async handleAgentEnd(event, ctx) {
        const run = this.latestForSession(ctx, event);
        if (!run)
            return;
        const eventAt = eventTimeMs(event, this.now());
        this.traceRegistry.markPendingEnd(event, ctx);
        run.pendingFinalize = true;
        run.lastEventAtMs = eventAt;
        await this.recordInstant(run, {
            kind: "agent.end",
            actor: "agent",
            timestampMs: eventAt,
            attrs: {
                ...baseAttrs(event, ctx, "agent_end"),
                "agent.name": stringFrom(ctx.agentId ?? event.agentId) ?? run.agentId,
                duration_ms: numberOrUndefined(event.durationMs),
                success: event.success ?? null,
                messages_count: Array.isArray(event.messages) ? event.messages.length : numberOrNull(event.messagesCount)
            },
            output: {
                success: event.success ?? null,
                error: event.error ?? null,
                messages: event.messages ?? null
            },
            status: event.success === false || event.error ? "error" : "ok",
            error: event.error ? toTrajectoryError(event.error) : null
        });
        this.scheduleFinalize(run, {
            status: event.success === false || event.error ? "error" : "ok",
            output: {
                hook: "agent_end",
                success: event.success ?? null,
                error: event.error ?? null
            },
            ...(event.error ? { error: toTrajectoryError(event.error) } : {})
        });
    }
    async handleSessionEnd(event, ctx) {
        const sessionKey = stringFrom(event.sessionKey ?? ctx.sessionKey);
        const runs = Array.from(this.runs.values()).filter((run) => (sessionKey ? run.sessionKey === sessionKey : run.sessionId === event.sessionId));
        for (const run of runs) {
            await this.recordInstant(run, {
                kind: "session.end",
                actor: "state",
                timestampMs: eventTimeMs(event, this.now()),
                attrs: {
                    ...baseAttrs(event, ctx, "session_end"),
                    "state.operation": "snapshot",
                    message_count: numberOrNull(event.messageCount)
                },
                status: "ok"
            });
            this.scheduleFinalize(run, { status: "ok", output: { hook: "session_end" } }, 0);
        }
    }
    async handleCompaction(hookName, event, ctx) {
        const run = this.latestForSession(ctx, event);
        if (!run)
            return;
        await this.recordInstant(run, {
            kind: "context.fold",
            actor: "state",
            timestampMs: eventTimeMs(event, this.now()),
            input: event.messages ?? null,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "state.operation": hookName === "before_compaction" ? "snapshot" : "update",
                "context.fold.phase": hookName === "before_compaction" ? "before" : "after",
                "quality": Array.isArray(event.messages) ? "context_snapshot_complete" : "context_snapshot_partial",
                message_count: numberOrNull(event.messageCount),
                compacting_count: numberOrNull(event.compactingCount),
                compacted_count: numberOrNull(event.compactedCount),
                token_count: numberOrNull(event.tokenCount),
                session_file: event.sessionFile ?? null
            },
            status: "ok"
        });
    }
    async handleRunLifecycle(hookName, event, ctx) {
        const openclawRunId = requireString(event.runId ?? ctx.runId, `${hookName}.runId`);
        const run = await this.ensureRun(openclawRunId, event, ctx, hookName);
        const eventAt = eventTimeMs(event, this.now());
        const status = hookName === "run.error" || event.error ? "error" : event.success === false ? "error" : "ok";
        await this.recordInstant(run, {
            kind: "run.lifecycle",
            actor: "agent",
            timestampMs: eventAt,
            input: hookName === "run.started" ? event.input ?? event : undefined,
            output: hookName === "run.started" ? undefined : event.output ?? event,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "run.lifecycle.phase": hookName.split(".").at(-1) ?? hookName,
                "agent.name": stringFrom(ctx.agentId ?? event.agentId) ?? run.agentId,
                duration_ms: numberOrUndefined(event.durationMs)
            },
            status,
            error: status === "ok" ? null : toTrajectoryError(event.error ?? "run failed")
        });
        if (hookName === "run.completed" || hookName === "run.error") {
            this.scheduleFinalize(run, {
                status,
                output: event.output ?? { hook: hookName, success: event.success ?? null },
                ...(status === "ok" ? {} : { error: toTrajectoryError(event.error ?? "run failed") })
            }, 0);
        }
    }
    async handleModelCallStarted(hookName, event, ctx) {
        const openclawRunId = requireString(event.runId ?? ctx.runId, `${hookName}.runId`);
        const run = await this.ensureRun(openclawRunId, event, ctx, hookName);
        const eventAt = eventTimeMs(event, this.now());
        const span = this.modelSpan(openclawRunId, eventAt, run.recorder.rootSpanId);
        run.modelSpan = span;
        run.lastEventAtMs = eventAt;
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: "model.call",
            actor: "model",
            phase: "start",
            status: "running",
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "gen_ai.request.model": stringFrom(event.model ?? event.modelName) ?? "unknown",
                "gen_ai.provider.name": stringFrom(event.provider) ?? null
            },
            input: event.input ?? event.prompt ?? null
        });
    }
    async handleModelCallEnded(hookName, event, ctx) {
        const openclawRunId = requireString(event.runId ?? ctx.runId, `${hookName}.runId`);
        const run = await this.ensureRun(openclawRunId, event, ctx, hookName);
        const eventAt = eventTimeMs(event, this.now());
        const span = run.modelSpan ?? this.modelSpan(openclawRunId, eventAt, run.recorder.rootSpanId);
        run.modelSpan = span;
        run.lastEventAtMs = eventAt;
        const usage = objectRecord(event.usage);
        const status = hookName === "model.call.error" || event.error ? "error" : "ok";
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: "model.call",
            actor: "model",
            phase: "end",
            status,
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "gen_ai.request.model": stringFrom(event.model ?? event.modelName) ?? "unknown",
                "gen_ai.provider.name": stringFrom(event.provider) ?? null,
                "gen_ai.usage.input_tokens": numberOrUndefined(event.inputTokens ?? event.input_tokens ?? usage?.input ?? usage?.promptTokens ?? usage?.prompt_tokens),
                "gen_ai.usage.output_tokens": numberOrUndefined(event.outputTokens ?? event.output_tokens ?? usage?.output ?? usage?.completionTokens ?? usage?.completion_tokens),
                "gen_ai.usage.cache_read_tokens": numberOrUndefined(usage?.cacheRead ?? usage?.cache_read_tokens),
                "gen_ai.usage.cache_write_tokens": numberOrUndefined(usage?.cacheWrite ?? usage?.cache_write_tokens),
                "gen_ai.usage.total_tokens": numberOrUndefined(usage?.total ?? event.totalTokens ?? event.total_tokens),
                duration_ms: numberOrUndefined(event.durationMs)
            },
            output: event.output ?? event.result ?? event,
            error: status === "ok" ? null : toTrajectoryError(event.error ?? "model call failed")
        });
    }
    async handleToolExecution(hookName, event, ctx) {
        const openclawRunId = requireString(event.runId ?? ctx.runId, `${hookName}.runId`);
        const toolName = requireString(toolNameFrom(event, ctx), `${hookName}.toolName`);
        const run = await this.ensureRun(openclawRunId, event, ctx, hookName);
        const toolCallId = stringFrom(event.toolCallId ?? event.tool_call_id ?? ctx.toolCallId ?? ctx.tool_call_id) ?? stableKey("tool", toolName, eventTimeMs(event, this.now()));
        const kindActor = kindActorForTool(toolName, event.input ?? event.params ?? event.arguments);
        const eventAt = eventTimeMs(event, this.now());
        const phase = hookName === "tool.execution.started" ? "start" : "end";
        const status = hookName === "tool.execution.started"
            ? "running"
            : hookName === "tool.execution.blocked"
                ? "cancelled"
                : hookName === "tool.execution.error" || event.error
                    ? "error"
                    : "ok";
        const span = run.toolSpans.get(toolCallId) ?? this.toolSpan(openclawRunId, toolCallId, kindActor.kind, kindActor.actor, eventAt, run.recorder.rootSpanId);
        run.toolSpans.set(toolCallId, span);
        run.lastEventAtMs = eventAt;
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: span.kind,
            actor: span.actor,
            phase,
            status,
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            tool_call_id: toolCallId,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "tool.name": toolName,
                ...kindActor.attrs,
                duration_ms: numberOrUndefined(event.durationMs)
            },
            input: phase === "start" ? event.input ?? event.params ?? event.arguments ?? null : undefined,
            output: phase === "end" ? event.output ?? event.result ?? event : undefined,
            error: status === "error" || status === "cancelled" ? toTrajectoryError(event.error ?? event.reason ?? "tool execution did not complete") : null
        });
        await this.drainExternalDiagnostics(run);
    }
    async handleContextAssembled(event, ctx) {
        const run = await this.runForTelemetry(event, ctx, "context.assembled");
        if (!run)
            return;
        await this.recordInstant(run, {
            kind: "context.assembled",
            actor: "state",
            timestampMs: eventTimeMs(event, this.now()),
            input: event.context ?? event.messages ?? null,
            output: event.summary ?? null,
            attrs: {
                ...baseAttrs(event, ctx, "context.assembled"),
                "state.operation": "snapshot",
                "context.message_count": numberOrUndefined(event.messageCount ?? event.message_count),
                "context.token_count": numberOrUndefined(event.tokenCount ?? event.token_count),
                "context.quality": event.quality ?? (event.partial === true ? "context_snapshot_partial" : "context_snapshot_complete")
            },
            status: "ok"
        });
    }
    async handleSubagent(hookName, event, ctx) {
        const openclawRunId = stringFrom(event.runId ?? ctx.runId);
        const parentRun = this.latestForSession({ sessionKey: ctx.requesterSessionKey }, event);
        const run = openclawRunId ? await this.ensureRun(openclawRunId, event, ctx, hookName) : parentRun;
        if (!run)
            return;
        const childKey = stringFrom(event.childSessionKey ?? ctx.childSessionKey ?? event.targetSessionKey) ?? "subagent";
        const eventAt = eventTimeMs(event, this.now());
        const spanId = stableSpanId("subagent", run.openclawRunId, childKey);
        const stepId = stableStepId("subagent", run.openclawRunId, childKey);
        const span = {
            spanId,
            stepId,
            kind: "agent.subagent",
            actor: "agent",
            parentSpanId: run.recorder.rootSpanId,
            startedAtMs: eventAt
        };
        if (hookName === "subagent_spawning" || hookName === "subagent_delivery_target") {
            await this.recordInstant(run, {
                kind: "agent.subagent",
                actor: "agent",
                timestampMs: eventAt,
                attrs: {
                    ...baseAttrs(event, ctx, hookName),
                    "agent.name": stringFrom(event.agentId) ?? "subagent",
                    "agent.operation": hookName === "subagent_spawning" ? "spawn_prepare" : "delivery_target",
                    "subagent.child_session_key": childKey,
                    "openclaw.child_session_id": stringFrom(event.childSessionId ?? event.child_session_id ?? event.targetSessionId ?? event.target_session_id) ?? null,
                    "openclaw.child_agent_id": stringFrom(event.childAgentId ?? event.child_agent_id ?? event.agentId) ?? null,
                    "openclaw.requester_session_id": stringFrom(event.requesterSessionId ?? event.requester_session_id ?? ctx.requesterSessionId) ?? null,
                    "openclaw.delivery_origin": event.origin ?? event.deliveryOrigin ?? null
                },
                input: event,
                status: "ok"
            });
            return;
        }
        if (hookName === "subagent_spawned") {
            run.subagentSpans.set(childKey, span);
            await run.recorder.record({
                timestamp: toIso(eventAt),
                kind: "agent.subagent",
                actor: "agent",
                phase: "start",
                status: "running",
                span_id: span.spanId,
                step_id: span.stepId,
                parent_span_id: span.parentSpanId,
                attrs: {
                    ...baseAttrs(event, ctx, hookName),
                    "agent.name": stringFrom(event.agentId) ?? "subagent",
                    "subagent.child_session_key": childKey,
                    "openclaw.child_session_id": stringFrom(event.childSessionId ?? event.child_session_id ?? event.targetSessionId ?? event.target_session_id) ?? null,
                    "openclaw.child_agent_id": stringFrom(event.childAgentId ?? event.child_agent_id ?? event.agentId) ?? null,
                    "openclaw.requester_session_id": stringFrom(event.requesterSessionId ?? event.requester_session_id ?? ctx.requesterSessionId) ?? null,
                    "openclaw.delivery_origin": event.origin ?? event.deliveryOrigin ?? null,
                    "subagent.mode": event.mode ?? null,
                    "subagent.label": event.label ?? null
                },
                input: event
            });
            return;
        }
        const existing = run.subagentSpans.get(childKey) ?? span;
        const status = subagentStatus(event);
        await run.recorder.record({
            timestamp: toIso(eventAt),
            kind: existing.kind,
            actor: existing.actor,
            phase: "end",
            status,
            span_id: existing.spanId,
            step_id: existing.stepId,
            parent_span_id: existing.parentSpanId,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "agent.name": "subagent",
                "subagent.child_session_key": childKey,
                "openclaw.child_session_id": stringFrom(event.childSessionId ?? event.child_session_id ?? event.targetSessionId ?? event.target_session_id) ?? null,
                "openclaw.child_agent_id": stringFrom(event.childAgentId ?? event.child_agent_id ?? event.agentId) ?? null,
                "openclaw.requester_session_id": stringFrom(event.requesterSessionId ?? event.requester_session_id ?? ctx.requesterSessionId) ?? null,
                "openclaw.delivery_origin": event.origin ?? event.deliveryOrigin ?? null,
                "subagent.outcome": event.outcome ?? null,
                "subagent.reason": event.reason ?? null
            },
            output: event,
            error: status === "ok" ? null : toTrajectoryError(event.error ?? event.outcome ?? "subagent failed")
        });
    }
    async handleTranscriptHook(hookName, event, ctx) {
        const run = this.latestForSession(ctx, event);
        if (!run)
            return;
        await this.recordInstant(run, {
            kind: hookName,
            actor: "state",
            timestampMs: eventTimeMs(event, this.now()),
            input: event.message ?? event,
            attrs: {
                ...baseAttrs(event, ctx, hookName),
                "state.operation": "write",
                "tool.name": event.toolName ?? ctx.toolName ?? null,
                "tool_call_id": event.toolCallId ?? ctx.toolCallId ?? null
            },
            status: "ok"
        });
    }
    async handleDiagnostic(event) {
        const type = stringFrom(event.type) ?? stringFrom(event.hookType)?.replaceAll("_", ".");
        if (!type)
            return;
        if (externalRequestTypes.has(type)) {
            await this.handleExternalRequestDiagnostic({ ...event, type });
            return;
        }
        if (type === "model.call.started") {
            await this.handleModelCallStarted(`diagnostic.${type}`, event, event);
            return;
        }
        if (type === "model.call.completed" || type === "model.call.error") {
            await this.handleModelCallEnded(`diagnostic.${type}`, event, event);
            return;
        }
        if (type === "tool.execution.started" || type === "tool.execution.completed" || type === "tool.execution.error" || type === "tool.execution.blocked") {
            await this.handleToolExecution(`diagnostic.${type}`, event, event);
            return;
        }
        if (type === "context.assembled") {
            await this.handleContextAssembled({ ...event, type }, event);
            return;
        }
        if (type === "run.started" || type === "run.completed" || type === "run.error" || type.startsWith("harness.run.")) {
            const run = await this.runForTelemetry(event, event, `diagnostic.${type}`);
            if (!run)
                return;
            await this.recordDiagnostic(run, type, "agent", "run.lifecycle", event, {
                "run.lifecycle.phase": type.split(".").at(-1) ?? type,
                status: event.status ?? null,
                duration_ms: numberOrUndefined(event.durationMs)
            });
            return;
        }
        if (type === "session.long_running" || type === "session.stalled" || type === "session.stuck") {
            const run = await this.runForTelemetry(event, event, `diagnostic.${type}`);
            if (!run)
                return;
            await this.recordDiagnostic(run, type, "state", "session.health", event, {
                "session.health": type.slice("session.".length),
                reason: event.reason ?? null,
                duration_ms: numberOrUndefined(event.durationMs),
                idle_ms: numberOrUndefined(event.idleMs)
            });
            return;
        }
        if (type === "model.usage") {
            const run = this.latestForSession(event, event);
            if (!run)
                return;
            await this.recordInstant(run, {
                kind: "model.usage",
                actor: "model",
                timestampMs: numberFrom(event.ts, this.now()),
                attrs: {
                    "openclaw.hook": "diagnostic.model.usage",
                    "gen_ai.provider.name": event.provider ?? null,
                    "gen_ai.request.model": event.model ?? null,
                    "gen_ai.usage.input_tokens": numberOrUndefined(objectRecord(event.usage)?.input ?? objectRecord(event.usage)?.promptTokens),
                    "gen_ai.usage.output_tokens": numberOrUndefined(objectRecord(event.usage)?.output),
                    "gen_ai.usage.cache_read_tokens": numberOrUndefined(objectRecord(event.usage)?.cacheRead),
                    "gen_ai.usage.cache_write_tokens": numberOrUndefined(objectRecord(event.usage)?.cacheWrite),
                    "gen_ai.cost.usd": numberOrUndefined(event.costUsd),
                    duration_ms: numberOrUndefined(event.durationMs)
                },
                output: event,
                status: "ok"
            });
        }
        if (type === "tool.loop") {
            const run = this.latestForSession(event, event);
            if (!run)
                return;
            await this.recordInstant(run, {
                kind: "tool.loop",
                actor: "tool",
                timestampMs: numberFrom(event.ts, this.now()),
                attrs: {
                    "openclaw.hook": "diagnostic.tool.loop",
                    "tool.name": event.toolName ?? null,
                    level: event.level ?? null,
                    action: event.action ?? null,
                    detector: event.detector ?? null,
                    count: event.count ?? null
                },
                output: event,
                status: event.level === "critical" ? "error" : "ok",
                error: event.level === "critical" ? toTrajectoryError(event.message ?? "tool loop detected") : null
            });
        }
        if (type === "session.state") {
            const run = this.latestForSession(event, event);
            if (!run)
                return;
            await this.recordDiagnostic(run, type, "state", "session.state", event, {
                "state.previous": event.prevState ?? null,
                "state.current": event.state ?? null,
                "state.reason": event.reason ?? null,
                queue_depth: numberOrUndefined(event.queueDepth)
            });
        }
        if (type === "message.queued" || type === "message.processed") {
            const run = this.latestForSession(event, event);
            if (!run)
                return;
            await this.recordDiagnostic(run, type, "state", type, event, {
                "message.queue_depth": numberOrUndefined(event.queueDepth),
                "queue.lane": event.lane ?? null,
                duration_ms: numberOrUndefined(event.durationMs)
            });
        }
        if (type?.startsWith("queue.lane.")) {
            const run = this.latestForSession(event, event);
            if (!run)
                return;
            await this.recordDiagnostic(run, type, "state", type, event, {
                "queue.lane": event.lane ?? null,
                "queue.action": type.slice("queue.lane.".length),
                queue_size: numberOrUndefined(event.queueSize),
                wait_ms: numberOrUndefined(event.waitMs)
            });
        }
        if (type === "run.attempt") {
            const run = this.latestForSession(event, event);
            if (!run)
                return;
            await this.recordDiagnostic(run, type, "agent", "run.attempt", event, {
                attempt: numberOrUndefined(event.attempt),
                max_attempts: numberOrUndefined(event.maxAttempts),
                reason: event.reason ?? null
            });
        }
    }
    async recordDiagnostic(run, type, actor, kind, event, attrs) {
        await this.recordInstant(run, {
            kind,
            actor,
            timestampMs: numberFrom(event.ts ?? event.eventAt, this.now()),
            attrs: {
                "openclaw.hook": `diagnostic.${type}`,
                "openclaw.diagnostic_type": type,
                ...attrs
            },
            output: event,
            status: event.error ? "error" : "ok",
            error: event.error ? toTrajectoryError(event.error) : null
        });
    }
    async handleExternalRequestDiagnostic(event) {
        const safe = sanitizeExternalRequestDiagnosticEvent(event);
        const run = this.findRunForExternalDiagnostic(safe);
        if (!run) {
            this.bufferExternalDiagnostic(safe);
            return;
        }
        await this.recordExternalRequestDiagnostic(run, safe);
    }
    findRunForExternalDiagnostic(safe) {
        if (safe.runId) {
            const byRunId = this.runs.get(safe.runId);
            if (byRunId && !byRunId.finalized)
                return byRunId;
        }
        const traceId = safe.trace?.traceId;
        if (traceId) {
            const byTrace = Array.from(this.runs.values()).find((run) => run.traceId === traceId && !run.finalized);
            if (byTrace)
                return byTrace;
        }
        if (safe.sessionKey) {
            const byKey = this.latestRunBySession.get(`key:${safe.sessionKey}`);
            if (byKey && !byKey.finalized)
                return byKey;
        }
        if (safe.sessionId) {
            const byId = this.latestRunBySession.get(`id:${safe.sessionId}`);
            if (byId && !byId.finalized)
                return byId;
        }
        const parentToolCallId = safe.parentToolCallId;
        if (parentToolCallId) {
            const matches = Array.from(this.runs.values()).filter((run) => !run.finalized && run.toolSpans.has(parentToolCallId));
            if (matches.length === 1)
                return matches[0] ?? null;
        }
        return null;
    }
    bufferExternalDiagnostic(safe) {
        const key = this.externalDiagnosticRunKey(safe);
        if (!key) {
            this.externalDiagnosticsDropped += 1;
            return;
        }
        const bucket = this.pendingExternalDiagnostics.get(key) ?? [];
        bucket.push({ safe, bufferedAtMs: this.now() });
        this.pendingExternalDiagnostics.set(key, bucket.slice(-100));
    }
    async drainExternalDiagnostics(run) {
        for (const key of this.externalDiagnosticKeysForRun(run)) {
            const bucket = this.pendingExternalDiagnostics.get(key);
            if (!bucket)
                continue;
            this.pendingExternalDiagnostics.delete(key);
            for (const item of bucket) {
                if (this.now() - item.bufferedAtMs > this.externalDiagnosticBufferTtlMs) {
                    this.externalDiagnosticsDropped += 1;
                    continue;
                }
                await this.recordExternalRequestDiagnostic(run, item.safe);
            }
        }
    }
    externalDiagnosticRunKey(safe) {
        if (safe.runId)
            return `run:${safe.runId}`;
        if (safe.sessionKey)
            return `key:${safe.sessionKey}`;
        if (safe.sessionId)
            return `id:${safe.sessionId}`;
        if (safe.parentToolCallId)
            return `tool:${safe.parentToolCallId}`;
        return null;
    }
    externalDiagnosticKeysForRun(run) {
        return [
            `run:${run.openclawRunId}`,
            ...(run.sessionKey ? [`key:${run.sessionKey}`] : []),
            ...(run.sessionId ? [`id:${run.sessionId}`] : []),
            ...Array.from(run.toolSpans.keys(), (toolCallId) => `tool:${toolCallId}`)
        ];
    }
    async recordExternalRequestDiagnostic(run, safe) {
        const timestampMs = numberFrom(safe.ts, this.now());
        const spanId = safe.diagnosticSpanId ?? stableSpanId("external_request", run.openclawRunId, safe.externalRequestId);
        const stepId = safe.diagnosticStepId ?? stableStepId("external_request", run.openclawRunId, safe.externalRequestId);
        const key = `${run.openclawRunId}:${safe.externalRequestId}`;
        const hasStart = this.activeExternalRequests.has(key);
        const phase = safe.type === "external.request.started" ? "start" : hasStart ? "end" : "event";
        const status = safe.type === "external.request.started" ? "running" : safe.type === "external.request.failed" ? "error" : "ok";
        const parentToolSpan = safe.parentToolCallId ? run.toolSpans.get(safe.parentToolCallId) : undefined;
        const parentSpanId = safe.parentSpanId ?? parentToolSpan?.spanId ?? run.recorder.rootSpanId;
        if (phase === "start")
            this.activeExternalRequests.add(key);
        if (phase === "end")
            this.activeExternalRequests.delete(key);
        run.lastEventAtMs = timestampMs;
        await run.recorder.record({
            timestamp: toIso(timestampMs),
            kind: safe.type,
            actor: "state",
            phase,
            status,
            span_id: spanId,
            step_id: stepId,
            parent_span_id: parentSpanId,
            tool_call_id: null,
            attrs: {
                "openclaw.hook": `diagnostic.${safe.type}`,
                "openclaw.diagnostic_type": safe.type,
                "openclaw.diagnostic_only": true,
                "state.operation": "snapshot",
                "external.request_id": safe.externalRequestId,
                "external.parent_step_id": safe.parentStepId ?? parentToolSpan?.stepId ?? null,
                "external.parent_tool_call_id": safe.parentToolCallId ?? null,
                "external.boundary": safe.boundary,
                "external.provider": safe.provider ?? null,
                "external.model": safe.model ?? null,
                "external.tool": safe.toolName ?? null,
                "external.connector": safe.connectorName ?? null,
                "external.operation": safe.operation ?? null,
                "http.method": safe.method,
                "http.endpoint": safe.endpoint,
                "http.status_code": safe.http?.status ?? null,
                "http.request_id": safe.http?.request_id ?? null,
                "http.retry_count": safe.http?.retry_count ?? null,
                "auth.scheme": safe.auth.scheme,
                "auth.source.type": safe.auth.source.type,
                "auth.source.id": safe.auth.source.id ?? null,
                "auth.present": safe.auth.present,
                "auth.status": safe.auth.status ?? null,
                "auth.fingerprint": safe.auth.fingerprint ?? null,
                "diagnostic.external_dropped_count": this.externalDiagnosticsDropped
            },
            output: phase === "start" ? undefined : safe,
            error: safe.type === "external.request.failed" ? { message: safe.error_summary?.message ?? "external request failed" } : null
        });
    }
    async ensureRun(openclawRunId, event, ctx, sourceHook) {
        const existing = this.runs.get(openclawRunId);
        if (existing) {
            this.indexRun(existing);
            return existing;
        }
        const toolkitRunId = toolkitRunIdFor(openclawRunId);
        const sessionKey = stringFrom(ctx.sessionKey ?? event.sessionKey);
        const sessionId = stringFrom(event.sessionId ?? ctx.sessionId);
        const agentId = stringFrom(ctx.agentId ?? event.agentId) ?? "main";
        const pending = sessionKey ? this.pendingModelResolveBySession.get(sessionKey) : undefined;
        const trace = this.traceRegistry.startOrAttachRun(event, ctx);
        const input = rootInputFor(event, ctx, pending, sourceHook);
        const startOptions = {
            baseDir: this.baseDir,
            runId: toolkitRunId,
            traceId: trace.traceId,
            input,
            metadata: {
                source: "openclaw-native-plugin",
                "capture.source": "openclaw_native_plugin",
                "agent.name": agentId,
                "openclaw.run_id": openclawRunId,
                "openclaw.session_key": sessionKey,
                "openclaw.session_id": sessionId,
                "openclaw.source_hook": sourceHook,
                "openclaw.bridge_trace_id": stringFrom(event.bridgeTraceId ?? pending?.event.bridgeTraceId),
                "openclaw.trace_alias_mode": trace.mode,
                "openclaw.ingress_fingerprint": trace.ingressFingerprint ?? pending?.event["openclaw.ingress_fingerprint"] ?? null,
                "openclaw.ingress_route_key": trace.ingressRouteKey ?? pending?.event["openclaw.ingress_route_key"] ?? null
            }
        };
        if (sessionId !== null) {
            startOptions.sessionId = sessionId;
        }
        if (this.options.artifactStore) {
            startOptions.artifactStore = this.options.artifactStore;
        }
        const recorder = await TrajectoryRecorder.start(startOptions);
        const run = {
            openclawRunId,
            toolkitRunId,
            recorder,
            sessionKey,
            sessionId,
            agentId,
            finalized: false,
            finalizePromise: null,
            pendingFinalize: false,
            pendingTimer: null,
            lastEventAtMs: eventTimeMs(event, this.now()),
            toolSpans: new Map(),
            subagentSpans: new Map(),
            traceId: trace.traceId,
            traceAliasMode: trace.mode
        };
        this.runs.set(openclawRunId, run);
        this.indexRun(run);
        await this.drainExternalDiagnostics(run);
        return run;
    }
    indexRun(run) {
        if (run.sessionKey)
            this.latestRunBySession.set(`key:${run.sessionKey}`, run);
        if (run.sessionId)
            this.latestRunBySession.set(`id:${run.sessionId}`, run);
    }
    latestForSession(ctx, event) {
        const runId = stringFrom(ctx.runId ?? event.runId);
        if (runId) {
            const byRunId = this.runs.get(runId);
            if (byRunId && !byRunId.finalized)
                return byRunId;
        }
        const traceId = this.traceRegistry.resolveTraceId(event, ctx);
        if (traceId) {
            const byTrace = Array.from(this.runs.values()).find((run) => run.traceId === traceId && !run.finalized);
            if (byTrace)
                return byTrace;
        }
        const sessionKey = stringFrom(ctx.sessionKey ?? event.sessionKey ?? ctx.requesterSessionKey ?? event.requesterSessionKey);
        const sessionId = stringFrom(ctx.sessionId ?? event.sessionId);
        if (sessionKey) {
            const byKey = this.latestRunBySession.get(`key:${sessionKey}`);
            if (byKey && !byKey.finalized)
                return byKey;
        }
        if (sessionId) {
            const byId = this.latestRunBySession.get(`id:${sessionId}`);
            if (byId && !byId.finalized)
                return byId;
        }
        const active = Array.from(this.runs.values()).filter((run) => !run.finalized);
        return active.sort((left, right) => right.lastEventAtMs - left.lastEventAtMs)[0] ?? null;
    }
    async runForTelemetry(event, ctx, sourceHook) {
        const openclawRunId = stringFrom(event.runId ?? event.run_id ?? ctx.runId ?? ctx.run_id);
        if (openclawRunId) {
            return this.ensureRun(openclawRunId, event, ctx, sourceHook);
        }
        return this.latestForSession(ctx, event);
    }
    modelSpan(openclawRunId, eventAt, parentSpanId) {
        return {
            spanId: stableSpanId("model", openclawRunId),
            stepId: stableStepId("model", openclawRunId),
            kind: "model.call",
            actor: "model",
            parentSpanId,
            startedAtMs: eventAt
        };
    }
    toolSpan(openclawRunId, toolCallId, kind, actor, eventAt, parentSpanId) {
        return {
            spanId: stableSpanId("tool", openclawRunId, toolCallId),
            stepId: stableStepId("tool", openclawRunId, toolCallId),
            kind,
            actor,
            parentSpanId,
            toolCallId,
            startedAtMs: eventAt
        };
    }
    contextSnapshotForLlmInput(run, event) {
        const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : null;
        const systemPromptHash = systemPrompt ? stableKey("systemPrompt", systemPrompt) : null;
        const systemPromptAlreadyStored = systemPromptHash ? this.systemPromptHashes.has(systemPromptHash) : false;
        if (systemPromptHash && !systemPromptAlreadyStored) {
            this.systemPromptHashes.add(systemPromptHash);
        }
        const historyMessages = Array.isArray(event.historyMessages) ? event.historyMessages : null;
        const historyHash = historyMessages ? stableKey("historyMessages", stableString(historyMessages)) : null;
        const previousHistoryHash = this.historySnapshotHashesByRun.get(run.openclawRunId);
        const historyAlreadyStored = historyHash !== null && previousHistoryHash === historyHash;
        if (historyHash) {
            this.historySnapshotHashesByRun.set(run.openclawRunId, historyHash);
        }
        const partial = systemPromptAlreadyStored || historyAlreadyStored;
        return {
            systemPrompt: systemPromptAlreadyStored ? null : event.systemPrompt ?? null,
            historyMessages: historyAlreadyStored ? null : event.historyMessages ?? null,
            historyMessagesRef: historyHash
                ? {
                    hash: historyHash,
                    count: historyMessages?.length ?? null,
                    strategy: historyAlreadyStored ? "deduplicated" : "inline_snapshot"
                }
                : null,
            context: {
                quality: partial ? "context_snapshot_partial" : "context_snapshot_complete",
                systemPromptHash,
                systemPromptStored: Boolean(systemPromptHash && !systemPromptAlreadyStored),
                historyMessagesHash: historyHash,
                historyMessagesStored: Boolean(historyHash && !historyAlreadyStored)
            }
        };
    }
    async recordInstant(run, options) {
        run.lastEventAtMs = options.timestampMs;
        await run.recorder.record({
            timestamp: toIso(options.timestampMs),
            kind: options.kind,
            actor: options.actor,
            phase: "event",
            status: options.status ?? "ok",
            span_id: stableSpanId("event", run.openclawRunId, options.kind, String(options.timestampMs), stableString(options.input)),
            step_id: stableStepId("event", run.openclawRunId, options.kind, String(options.timestampMs), stableString(options.input)),
            parent_span_id: options.parentSpanId ?? run.recorder.rootSpanId,
            attrs: options.attrs ?? {},
            input: options.input,
            output: options.output,
            error: options.error ?? null
        });
    }
    correlateMessage(event, eventAt) {
        this.cleanupMessageTools();
        const to = stringFrom(event.to);
        const content = stringFrom(event.content);
        const candidates = this.pendingMessageTools
            .filter((item) => eventAt >= item.beforeAtMs - 1000 && eventAt <= (item.afterAtMs ?? item.beforeAtMs + 30_000) + 2000)
            .filter((item) => targetMatches(item.target, to))
            .filter((item) => contentMatches(item.content, content))
            .sort((left, right) => Math.abs(eventAt - left.beforeAtMs) - Math.abs(eventAt - right.beforeAtMs));
        return candidates[0] ?? null;
    }
    cleanupMessageTools() {
        const cutoff = this.now() - 120_000;
        for (let index = this.pendingMessageTools.length - 1; index >= 0; index -= 1) {
            const item = this.pendingMessageTools[index];
            if (item && (item.afterAtMs ?? item.beforeAtMs) < cutoff) {
                this.pendingMessageTools.splice(index, 1);
            }
        }
    }
    scheduleFinalize(run, options, overrideDelayMs) {
        if (run.finalized)
            return;
        if (run.pendingTimer) {
            clearTimeout(run.pendingTimer);
        }
        const delay = overrideDelayMs ?? this.finalizeDelayMs;
        run.pendingTimer = setTimeout(() => {
            run.pendingTimer = null;
            void this.finalizeRun(run, options);
        }, delay);
    }
    async finalizeRun(run, options) {
        if (run.finalizePromise)
            return run.finalizePromise;
        if (run.finalized)
            return;
        run.finalized = true;
        run.finalizePromise = (async () => {
            try {
                await run.recorder.finalize(options);
                if (this.normalizeOnFinalize) {
                    await normalizeRun(run.recorder.runDir, { artifactMode: "safe" });
                }
            }
            catch (error) {
                run.finalized = false;
                this.log("warn", `trajectory finalize failed for ${run.openclawRunId}: ${errorMessage(error)}`);
            }
            finally {
                run.finalizePromise = null;
            }
        })();
        await run.finalizePromise;
    }
    async scavengeStartupRuns() {
        const runsDir = join(this.baseDir, "runs");
        const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const runDir = join(runsDir, entry.name);
            try {
                const runPath = join(runDir, "run.json");
                const run = JSON.parse(await readFile(runPath, "utf8"));
                if (run.status !== "running" && run.status !== "ending")
                    continue;
                const lastEventAt = Date.parse(String(run.last_event_at ?? run.started_at ?? ""));
                if (Number.isFinite(lastEventAt) && this.now() - lastEventAt <= this.startupScavengeStaleAfterMs)
                    continue;
                if (await hasActivePidFile(runDir))
                    continue;
                const recovered = await TrajectoryRecorder.recoverRunDir(runDir, { verifyTail: true }).catch((error) => {
                    this.log("warn", `startup recover failed for ${runDir}: ${errorMessage(error)}`);
                    return null;
                });
                const afterRecover = JSON.parse(await readFile(runPath, "utf8"));
                if (recovered && afterRecover.status !== "running" && afterRecover.status !== "ending") {
                    if (this.normalizeOnFinalize)
                        await normalizeRun(runDir, { artifactMode: "safe" }).catch((error) => this.log("warn", `startup normalize failed for ${runDir}: ${errorMessage(error)}`));
                    continue;
                }
                await writeFile(runPath, `${JSON.stringify({
                    ...afterRecover,
                    metadata: {
                        ...(objectRecord(afterRecover.metadata) ?? {}),
                        "openclaw.startup_scavenger": "stale_marked"
                    }
                })}\n`, "utf8");
                await finalizeRunDirectory(runDir, {
                    status: "error",
                    output: {
                        reason: "stale_marked",
                        stale_after_ms: this.startupScavengeStaleAfterMs
                    },
                    error: {
                        code: "stale_marked",
                        message: "OpenClaw trajectory run was still running when the native collector started."
                    }
                });
                if (this.normalizeOnFinalize)
                    await normalizeRun(runDir, { artifactMode: "safe" });
            }
            catch (error) {
                this.log("warn", `startup stale scan failed for ${runDir}: ${errorMessage(error)}`);
            }
        }
    }
    log(level, message) {
        const logger = this.api.logger;
        const fn = logger?.[level] ?? (level === "debug" ? undefined : console[level]);
        fn?.(`[openclaw-trajectory] ${message}`);
    }
}
function resolveBaseDir(api, options) {
    const configured = stringFrom(options.baseDir ?? api.pluginConfig?.baseDir ?? process.env.OPENCLAW_TRAJECTORY_BASE_DIR);
    if (configured)
        return configured;
    return join(homedir(), ".openclaw", "trajectory");
}
function rootInputFor(event, ctx, pending, sourceHook) {
    return {
        source: "openclaw-native-plugin",
        hook: sourceHook,
        openclaw_run_id: event.runId ?? null,
        session_id: event.sessionId ?? ctx.sessionId ?? null,
        session_key: ctx.sessionKey ?? pending?.ctx.sessionKey ?? null,
        prompt: event.prompt ?? event.input ?? pending?.event.prompt ?? null,
        provider: event.provider ?? null,
        model: event.model ?? null
    };
}
function baseAttrs(event, ctx, hook) {
    return {
        "capture.source": "openclaw_native_plugin",
        "capture.adapter": "openclaw_plugin_sdk",
        "openclaw.hook": hook,
        "openclaw.run_id": event.runId ?? ctx.runId ?? null,
        "openclaw.session_id": event.sessionId ?? ctx.sessionId ?? null,
        "openclaw.session_key": event.sessionKey ?? ctx.sessionKey ?? null,
        "openclaw.bridge_trace_id": event.bridgeTraceId ?? ctx.bridgeTraceId ?? null,
        "openclaw.trace_seq": event.traceSeq ?? null,
        "openclaw.import_source": event["openclaw.import_source"] ?? ctx["openclaw.import_source"] ?? null,
        "agent.name": ctx.agentId ?? event.agentId ?? "main"
    };
}
function kindActorForTool(toolName, params) {
    const record = objectRecord(params);
    if (toolName === "exec") {
        return { kind: "shell.exec", actor: "shell", attrs: { command: record?.command ?? null } };
    }
    if (toolName === "read") {
        return { kind: "file.read", actor: "file", attrs: { "file.operation": "read", "file.path": record?.path ?? record?.file_path ?? null } };
    }
    if (toolName === "write") {
        return { kind: "file.write", actor: "file", attrs: { "file.operation": "write", "file.path": record?.path ?? record?.file_path ?? null } };
    }
    if (toolName === "edit" || toolName === "apply_patch") {
        return { kind: "file.patch", actor: "file", attrs: { "file.operation": "update", "file.path": record?.path ?? record?.file_path ?? null } };
    }
    if (toolName === "sessions_spawn" || toolName === "subagents") {
        return { kind: "agent.subagent", actor: "agent", attrs: { "agent.operation": toolName } };
    }
    return { kind: "tool.call", actor: "tool", attrs: {} };
}
function toolNameFrom(event, ctx) {
    return (stringFrom(event.toolName ?? event.tool_name ?? event.name ?? ctx.toolName ?? ctx.tool_name ?? ctx.name) ??
        stringFrom(objectRecord(event.function)?.name ?? objectRecord(ctx.function)?.name));
}
function toolStatus(event) {
    if (event.error)
        return "error";
    const result = objectRecord(event.result);
    const details = objectRecord(result?.details);
    if (details?.status === "error")
        return "error";
    if (details?.status === "timeout")
        return "timeout";
    return "ok";
}
function subagentStatus(event) {
    if (event.error)
        return "error";
    if (event.outcome === "ok")
        return "ok";
    if (event.outcome === "timeout")
        return "timeout";
    if (event.outcome === "killed" || event.outcome === "reset" || event.outcome === "deleted")
        return "cancelled";
    if (event.outcome === "error")
        return "error";
    return "ok";
}
function resultError(result) {
    const details = objectRecord(objectRecord(result)?.details);
    return details?.error;
}
function stopReason(event) {
    const lastAssistant = objectRecord(event.lastAssistant);
    return event.lastAssistantStopReason ?? lastAssistant?.stopReason ?? null;
}
function toolkitRunIdFor(openclawRunId) {
    return `run_oc_${shortHash(openclawRunId, 24)}`;
}
function stableSpanId(...parts) {
    return shortHash(parts.join("\u001f"), 16);
}
function stableStepId(...parts) {
    return `step_${sanitizeIdPart(parts[0] ?? "native")}_${shortHash(parts.join("\u001f"), 16)}`;
}
function stableKey(...parts) {
    return shortHash(parts.map((part) => String(part)).join("\u001f"), 16);
}
function shortHash(value, length) {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function sanitizeIdPart(value) {
    return value.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/^_+|_+$/g, "").slice(0, 24) || "native";
}
function eventTimeMs(event, fallback) {
    const numeric = numberOrUndefined(event.eventAt ?? event.endedAt ?? event.timestamp);
    if (numeric !== undefined)
        return numeric;
    const text = stringFrom(event.eventTime ?? event.timestamp);
    if (text) {
        const parsed = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
function toIso(ms) {
    return new Date(ms).toISOString();
}
function requireString(value, label) {
    const text = stringFrom(value);
    if (!text)
        throw new Error(`Missing ${label}`);
    return text;
}
function stringFrom(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function numberFrom(value, fallback) {
    const numeric = numberOrUndefined(value);
    return numeric ?? fallback;
}
function numberOrUndefined(value) {
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(numeric) ? numeric : undefined;
}
function numberOrNull(value) {
    return numberOrUndefined(value) ?? null;
}
function booleanFrom(value, fallback) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        if (value === "true")
            return true;
        if (value === "false")
            return false;
    }
    return fallback;
}
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toTrajectoryError(error) {
    if (error && typeof error === "object") {
        const record = error;
        return {
            message: error instanceof Error ? error.message : String(record.message ?? JSON.stringify(record)),
            ...(typeof record.code === "string" || typeof record.code === "number" ? { code: record.code } : {})
        };
    }
    return { message: String(error) };
}
async function hasActivePidFile(runDir) {
    const pidFile = await readOptionalJson(join(runDir, "run.pid.json"));
    if (!pidFile)
        return false;
    if (pidFile.hostname !== undefined && pidFile.hostname !== hostname()) {
        return false;
    }
    const pid = typeof pidFile.pid === "number" ? pidFile.pid : Number(pidFile.pid);
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function readOptionalJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
function targetMatches(target, to) {
    if (!target || !to)
        return true;
    return to.includes(target) || target.includes(to);
}
function contentMatches(expected, actual) {
    if (!expected || !actual)
        return true;
    const normalizedExpected = normalizeContent(expected);
    const normalizedActual = normalizeContent(actual);
    const prefix = normalizedExpected.slice(0, Math.min(100, normalizedExpected.length));
    return normalizedActual.startsWith(prefix) || prefix.startsWith(normalizedActual.slice(0, Math.min(100, normalizedActual.length)));
}
function normalizeContent(value) {
    return value.replaceAll(/\s+/g, " ").trim();
}
function stableString(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=openclaw-native.js.map
import { AsyncLocalStorage } from "node:async_hooks";
import { newSpanId, newStepId } from "./ids.js";
import { TrajectoryRecorder } from "./recorder.js";
const contextStorage = new AsyncLocalStorage();
export function currentTrajectoryContext() {
    return contextStorage.getStore();
}
export function runWithTrajectoryContext(context, fn) {
    return contextStorage.run(context, fn);
}
export class TrajectoryHookManager {
    recorder;
    agentName;
    captureSource;
    stepCounter = 0;
    recordingErrors = [];
    constructor(recorder, agentName, captureSource) {
        this.recorder = recorder;
        this.agentName = agentName;
        this.captureSource = captureSource;
    }
    static async startRun(options) {
        const { agentName = "default_agent", captureSource = "native_hook", ...recorderOptions } = options;
        const recorder = await TrajectoryRecorder.start({
            ...recorderOptions,
            metadata: {
                ...(recorderOptions.metadata ?? {}),
                "capture.source": captureSource,
                "agent.name": agentName
            }
        });
        return new TrajectoryHookManager(recorder, agentName, captureSource);
    }
    context(parentSpanId = this.recorder.rootSpanId) {
        return {
            recorder: this.recorder,
            runId: this.recorder.runId,
            traceId: this.recorder.traceId,
            parentSpanId,
            turnId: null,
            agentName: this.agentName,
            captureSource: this.captureSource
        };
    }
    run(fn) {
        return runWithTrajectoryContext(this.context(), fn);
    }
    async startSpan(options) {
        const active = currentTrajectoryContext() ?? this.context();
        const spanId = newSpanId();
        const stepId = newStepId(++this.stepCounter, "hook");
        const turnId = options.turnId ?? active.turnId;
        const parentSpanId = options.parentSpanId ?? active.parentSpanId ?? this.recorder.rootSpanId;
        const attrs = this.attrsFor(options.adapter, options.name, options.attrs);
        await this.recorder.record({
            kind: options.kind,
            actor: options.actor,
            phase: "start",
            status: "running",
            span_id: spanId,
            step_id: stepId,
            parent_span_id: parentSpanId,
            turn_id: turnId,
            tool_call_id: options.toolCallId ?? null,
            skill_invocation_id: options.skillInvocationId ?? null,
            attrs,
            input: options.input
        });
        return new TrajectoryHookSpan(this, options, spanId, stepId, parentSpanId, turnId, attrs);
    }
    async wrapOperation(options, operation) {
        const span = await this.startSpan(options).catch((error) => {
            this.recordingErrors.push(errorMessage(error));
            return null;
        });
        if (!span) {
            return operation();
        }
        const active = currentTrajectoryContext() ?? this.context();
        const childContext = {
            ...active,
            parentSpanId: span.spanId,
            turnId: span.turnId,
            agentName: this.agentName,
            captureSource: this.captureSource
        };
        try {
            const output = await runWithTrajectoryContext(childContext, operation);
            await this.safeEnd(span, { status: "ok", output });
            return output;
        }
        catch (error) {
            await this.safeEnd(span, { status: "error", error });
            throw error;
        }
    }
    wrapModelCall(options, operation) {
        return this.wrapOperation({
            kind: "model.call",
            actor: "model",
            adapter: "model_hook",
            name: options.model,
            input: options.input,
            attrs: {
                "gen_ai.request.model": options.model,
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    wrapToolCall(options, operation) {
        return this.wrapOperation({
            kind: "tool.call",
            actor: "tool",
            adapter: "tool_hook",
            name: options.name,
            input: options.input,
            ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
            attrs: {
                "tool.name": options.name,
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    wrapSkillCall(options, operation) {
        return this.wrapOperation({
            kind: "skill.invoke",
            actor: "skill",
            adapter: "skill_hook",
            name: options.name,
            input: options.input,
            ...(options.skillInvocationId !== undefined ? { skillInvocationId: options.skillInvocationId } : {}),
            attrs: {
                "skill.name": options.name,
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    wrapShellCall(options, operation) {
        return this.wrapOperation({
            kind: "shell.exec",
            actor: "shell",
            adapter: "shell_hook",
            name: shellCommandName(options.command),
            input: options.input ?? { command: options.command },
            attrs: {
                command: options.command,
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    wrapFileOperation(options, operation) {
        return this.wrapOperation({
            kind: `file.${options.operation}`,
            actor: "file",
            adapter: "file_hook",
            name: options.path ?? options.operation,
            input: options.input,
            attrs: {
                "file.operation": options.operation,
                ...(options.path ? { "file.path": options.path } : {}),
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    wrapMcpCall(options, operation) {
        return this.wrapOperation({
            kind: "mcp.call",
            actor: "mcp",
            adapter: "mcp_hook",
            name: options.tool ?? options.method,
            input: options.input,
            attrs: {
                "mcp.method.name": options.method,
                ...(options.server ? { "mcp.server": options.server } : {}),
                ...(options.tool ? { "mcp.tool": options.tool } : {}),
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    wrapStateOperation(options, operation) {
        return this.wrapOperation({
            kind: `state.${options.operation}`,
            actor: "state",
            adapter: "state_hook",
            name: options.key ?? options.operation,
            input: options.input,
            attrs: {
                "state.operation": options.operation,
                ...(options.scope ? { "state.scope": options.scope } : {}),
                ...(options.key ? { "state.key": options.key } : {}),
                ...(options.attrs ?? {})
            }
        }, operation);
    }
    finalize(options) {
        return this.recorder.finalize(options);
    }
    recordingHealth() {
        return {
            degraded: this.recordingErrors.length > 0 || this.recorder.health().append_failed,
            errors: [...this.recordingErrors, ...(this.recorder.health().error ? [this.recorder.health().error] : [])]
        };
    }
    async recordSpanEnd(span, options) {
        await this.recorder.record({
            kind: span.kind,
            actor: span.actor,
            phase: "end",
            status: options.status,
            span_id: span.spanId,
            step_id: span.stepId,
            parent_span_id: span.parentSpanId,
            turn_id: span.turnId,
            tool_call_id: span.toolCallId,
            skill_invocation_id: span.skillInvocationId,
            attrs: {
                ...span.startAttrs,
                ...(options.attrs ?? {})
            },
            output: options.output,
            error: options.error === undefined ? undefined : toTrajectoryError(options.error)
        });
    }
    attrsFor(adapter, name, attrs) {
        return {
            ...(attrs ?? {}),
            "capture.source": this.captureSource,
            "capture.adapter": adapter,
            "agent.name": this.agentName,
            ...(name ? { name } : {})
        };
    }
    async safeEnd(span, options) {
        await span.end(options).catch((error) => {
            this.recordingErrors.push(errorMessage(error));
        });
    }
}
export class TrajectoryHookSpan {
    manager;
    spanId;
    stepId;
    parentSpanId;
    turnId;
    startAttrs;
    ended = false;
    kind;
    actor;
    toolCallId;
    skillInvocationId;
    constructor(manager, options, spanId, stepId, parentSpanId, turnId, startAttrs) {
        this.manager = manager;
        this.spanId = spanId;
        this.stepId = stepId;
        this.parentSpanId = parentSpanId;
        this.turnId = turnId;
        this.startAttrs = startAttrs;
        this.kind = options.kind;
        this.actor = options.actor;
        this.toolCallId = options.toolCallId ?? null;
        this.skillInvocationId = options.skillInvocationId ?? null;
    }
    async end(options = {}) {
        if (this.ended)
            return;
        this.ended = true;
        await this.manager.recordSpanEnd(this, {
            ...options,
            status: options.status ?? (options.error ? "error" : "ok")
        });
    }
}
function toTrajectoryError(error) {
    if (error && typeof error === "object") {
        const record = error;
        return {
            message: error instanceof Error ? error.message : String(error),
            ...(typeof record.code === "string" || typeof record.code === "number" ? { code: record.code } : {}),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
        };
    }
    return { message: String(error) };
}
function shellCommandName(command) {
    const trimmed = command.trim();
    if (trimmed.length <= 40)
        return trimmed || "shell";
    const first = trimmed.split(/\s+/)[0] ?? "shell";
    return `${first} (${trimmed.length} chars)`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=hooks.js.map
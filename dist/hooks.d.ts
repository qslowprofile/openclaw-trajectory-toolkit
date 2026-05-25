import { TrajectoryRecorder, type FinalizeOptions, type StartRunOptions } from "./recorder.js";
import type { EventActor, EventStatus } from "./types.js";
export interface TrajectoryRuntimeContext {
    recorder: TrajectoryRecorder;
    runId: string;
    traceId: string;
    parentSpanId: string | null;
    turnId: string | null;
    agentName: string;
    captureSource: string;
}
export interface HookManagerStartOptions extends StartRunOptions {
    agentName?: string;
    captureSource?: string;
}
export interface HookSpanOptions {
    kind: string;
    actor: EventActor;
    adapter: string;
    name?: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
    parentSpanId?: string | null;
    turnId?: string | null;
    toolCallId?: string | null;
    skillInvocationId?: string | null;
}
export interface HookEndOptions {
    status?: Exclude<EventStatus, "running">;
    output?: unknown;
    attrs?: Record<string, unknown>;
    error?: unknown;
}
export interface ModelCallOptions {
    model: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
}
export interface ToolCallOptions {
    name: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
    toolCallId?: string | null;
}
export interface SkillCallOptions {
    name: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
    skillInvocationId?: string | null;
}
export interface ShellCallOptions {
    command: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
}
export interface FileOperationOptions {
    operation: string;
    path?: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
}
export interface McpCallOptions {
    method: string;
    server?: string;
    tool?: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
}
export interface StateOperationOptions {
    operation: string;
    scope?: string;
    key?: string;
    input?: unknown;
    attrs?: Record<string, unknown>;
}
export declare function currentTrajectoryContext(): TrajectoryRuntimeContext | undefined;
export declare function runWithTrajectoryContext<T>(context: TrajectoryRuntimeContext, fn: () => T): T;
export declare class TrajectoryHookManager {
    readonly recorder: TrajectoryRecorder;
    readonly agentName: string;
    readonly captureSource: string;
    private stepCounter;
    private readonly recordingErrors;
    private constructor();
    static startRun(options: HookManagerStartOptions): Promise<TrajectoryHookManager>;
    context(parentSpanId?: string | null): TrajectoryRuntimeContext;
    run<T>(fn: () => T): T;
    startSpan(options: HookSpanOptions): Promise<TrajectoryHookSpan>;
    wrapOperation<T>(options: HookSpanOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapModelCall<T>(options: ModelCallOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapToolCall<T>(options: ToolCallOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapSkillCall<T>(options: SkillCallOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapShellCall<T>(options: ShellCallOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapFileOperation<T>(options: FileOperationOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapMcpCall<T>(options: McpCallOptions, operation: () => Promise<T> | T): Promise<T>;
    wrapStateOperation<T>(options: StateOperationOptions, operation: () => Promise<T> | T): Promise<T>;
    finalize(options: FinalizeOptions): Promise<unknown>;
    recordingHealth(): {
        degraded: boolean;
        errors: string[];
    };
    recordSpanEnd(span: TrajectoryHookSpan, options: Required<Pick<HookEndOptions, "status">> & Omit<HookEndOptions, "status">): Promise<void>;
    private attrsFor;
    private safeEnd;
}
export declare class TrajectoryHookSpan {
    private readonly manager;
    readonly spanId: string;
    readonly stepId: string;
    readonly parentSpanId: string | null;
    readonly turnId: string | null;
    readonly startAttrs: Record<string, unknown>;
    private ended;
    readonly kind: string;
    readonly actor: EventActor;
    readonly toolCallId: string | null;
    readonly skillInvocationId: string | null;
    constructor(manager: TrajectoryHookManager, options: HookSpanOptions, spanId: string, stepId: string, parentSpanId: string | null, turnId: string | null, startAttrs: Record<string, unknown>);
    end(options?: HookEndOptions): Promise<void>;
}

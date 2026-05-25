import { ArtifactStore, type ArtifactStoreOptions } from "./artifact-store.js";
import type { EventActor, EventPhase, EventStatus, TrajectoryEvent } from "./types.js";
export interface StartRunOptions {
    baseDir: string;
    input: unknown;
    metadata?: Record<string, unknown>;
    sessionId?: string;
    sessionKey?: string | null;
    rootSessionId?: string | null;
    parentSessionId?: string | null;
    agentId?: string | null;
    agentName?: string | null;
    runId?: string;
    traceId?: string;
    artifactStore?: ArtifactStoreOptions;
}
export interface RecordEventOptions {
    timestamp?: string;
    kind: string;
    actor: EventActor;
    phase: EventPhase;
    status: EventStatus;
    session_id?: string | null;
    session_key?: string | null;
    agent_id?: string | null;
    agent_name?: string | null;
    invoked_by?: string | null;
    message_id?: string | null;
    parent_span_id?: string | null;
    span_id?: string;
    step_id?: string;
    tool_call_id?: string | null;
    skill_invocation_id?: string | null;
    turn_id?: string | null;
    attrs?: Record<string, unknown>;
    input?: unknown;
    output?: unknown;
    error?: TrajectoryEvent["error"];
}
export interface FinalizeOptions {
    output: unknown;
    status: Exclude<EventStatus, "running">;
    error?: TrajectoryEvent["error"];
    artifactStore?: ArtifactStoreOptions;
}
export interface RecoverResult {
    verified_tail: boolean;
    repaired_run_json: boolean;
}
export declare class TrajectoryRecorder {
    readonly baseDir: string;
    readonly runDir: string;
    readonly runId: string;
    readonly traceId: string;
    readonly rootSpanId: string;
    readonly sessionId: string | null;
    private readonly startedAt;
    private readonly input;
    private readonly metadata;
    readonly artifactStore: ArtifactStore;
    private stepCounter;
    private appendQueue;
    private appendFailure;
    private lastEventAt;
    private lastHeartbeatWriteAt;
    private eventsWritten;
    private artifactsWritten;
    private artifactBytesWritten;
    private readonly metaTraceRecorder;
    private constructor();
    static start(options: StartRunOptions): Promise<TrajectoryRecorder>;
    record(options: RecordEventOptions): Promise<TrajectoryEvent>;
    finalize(options: FinalizeOptions): Promise<TrajectoryEvent>;
    releasePidFile(): Promise<void>;
    health(): {
        writable: boolean;
        append_failed: boolean;
        error: string | null;
        last_event_at: string;
    };
    stats(): Promise<{
        events_written: number;
        artifacts_written: number;
        artifact_bytes: number;
        run_dir_bytes: number;
    }>;
    recover(options?: {
        verifyTail?: boolean;
    }): Promise<void>;
    static recoverRunDir(runDir: string, options?: {
        verifyTail?: boolean;
    }): Promise<RecoverResult>;
    private appendEvent;
    private assertWritable;
    private writeRunFile;
    private writeRunHeartbeat;
    private writePidFile;
    private writeConfigSnapshot;
    private writeEnvironmentSnapshot;
}
export declare function finalizeRunDirectory(runDir: string, options: FinalizeOptions): Promise<TrajectoryEvent>;
export declare function appendRunDirectoryEvent(runDir: string, options: RecordEventOptions, config?: {
    artifactStore?: ArtifactStoreOptions;
}): Promise<TrajectoryEvent>;

import { type RecordEventOptions } from "./recorder.js";
import type { ArtifactStoreOptions } from "./artifact-store.js";
import type { EventStatus } from "./types.js";
export type ManualNoteType = "model" | "tool" | "shell" | "file" | "mcp" | "skill" | "state" | "agent";
export interface ActiveManualRecording {
    schema_version: "openclaw.active-recording/v1";
    run_id: string;
    run_dir: string;
    base_dir: string;
    mode: "live_manual";
    session_id: string | null;
    session_key: string | null;
    agent_id: string | null;
    agent_name: string | null;
    input: unknown;
    started_at: string;
    updated_at: string;
    note_count: number;
    trigger: string | null;
}
export interface ManualStartOptions {
    baseDir: string;
    input: unknown;
    trigger?: string | null;
    sessionId?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
    agentName?: string | null;
    force?: boolean;
    artifactStore?: ArtifactStoreOptions;
}
export interface ManualNoteOptions {
    baseDir: string;
    text: string;
    type?: string | null;
    status?: string | null;
    stepId?: string | null;
    timestamp?: string | null;
    sessionId?: string | null;
    agentName?: string | null;
    artifactStore?: ArtifactStoreOptions;
}
export interface ManualStructuredEventOptions {
    baseDir: string;
    value: unknown;
    sessionId?: string | null;
    artifactStore?: ArtifactStoreOptions;
}
export interface ManualStopOptions {
    baseDir: string;
    finalOutput: unknown;
    status: Exclude<EventStatus, "running">;
    sessionId?: string | null;
    artifactStore?: ArtifactStoreOptions;
}
export interface ReconstructOptions {
    baseDir: string;
    transcript: string;
    input?: unknown;
    finalOutput?: unknown;
    sessionId?: string | null;
    artifactStore?: ArtifactStoreOptions;
}
export interface ReconstructSessionOptions {
    baseDir: string;
    sessionLog: string;
    input?: unknown;
    finalOutput?: unknown;
    sessionId?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    detectWindow?: boolean;
    excludeSelf?: boolean;
    finalStatus?: Exclude<EventStatus, "running">;
    taskCompleted?: boolean | null;
    artifactStore?: ArtifactStoreOptions;
}
export declare function activeRecordingPath(baseDir: string): string;
export declare function activeSessionRecordingPath(baseDir: string, sessionId: string): string;
export declare function startManualRecording(options: ManualStartOptions): Promise<ActiveManualRecording>;
export declare function appendManualStructuredEvent(options: ManualStructuredEventOptions): Promise<{
    active: ActiveManualRecording;
    event: Record<string, unknown>;
    event_type: ManualNoteType;
}>;
export declare function readActiveManualRecording(baseDir: string, sessionId?: string | null): Promise<ActiveManualRecording>;
export declare function manualRecordingStatus(baseDir: string, sessionId?: string | null): Promise<Record<string, unknown>>;
export declare function appendManualNote(options: ManualNoteOptions): Promise<{
    active: ActiveManualRecording;
    event: Record<string, unknown>;
    note_type: ManualNoteType;
}>;
export declare function stopManualRecording(options: ManualStopOptions): Promise<ActiveManualRecording>;
export declare function recoverManualRecording(options: ManualStopOptions): Promise<ActiveManualRecording | null>;
export declare function reconstructManualRecording(options: ReconstructOptions): Promise<{
    run_id: string;
    run_dir: string;
    step_count: number;
}>;
export declare function reconstructSessionRecording(options: ReconstructSessionOptions): Promise<{
    run_id: string;
    run_dir: string;
    step_count: number;
}>;
export declare function structuredInputToRecordEvent(value: unknown, options?: {
    defaultStepId?: string;
    defaultAgentName?: string;
    extraAttrs?: Record<string, unknown>;
}): RecordEventOptions;

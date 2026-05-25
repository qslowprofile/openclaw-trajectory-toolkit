export type EventPhase = "start" | "end" | "event";
export type EventStatus = "ok" | "error" | "cancelled" | "timeout" | "running";
export type EventActor = "runtime" | "agent" | "model" | "skill" | "tool" | "mcp" | "file" | "shell" | "state" | "artifact" | "evaluator";
export type StepType = "agent" | "model" | "skill" | "tool" | "mcp" | "file" | "shell" | "state" | "graph" | "artifact" | "eval";
export interface ArtifactMetadata {
    schema_version: "openclaw.artifact/v1";
    artifact_id: string;
    uri: string;
    kind: string;
    mime_type: string;
    sha256: string;
    size_bytes: number;
    created_at: string;
    summary: string | null;
    redacted: boolean;
    redacted_keys: string[];
    metadata: Record<string, unknown>;
}
export interface TraceIds {
    trace_id: string;
    span_id: string;
    parent_span_id?: string | null;
    run_id: string;
    session_id?: string | null;
    turn_id?: string | null;
    step_id?: string | null;
    tool_call_id?: string | null;
    skill_invocation_id?: string | null;
    artifact_id?: string | null;
}
export interface TrajectoryError {
    code?: string | number;
    message: string;
    stack?: string;
    [key: string]: unknown;
}
export interface TrajectoryEvent {
    schema_version: "openclaw.event/v1";
    event_id: string;
    timestamp: string;
    phase: EventPhase;
    kind: string;
    actor: EventActor;
    status: EventStatus;
    ids: TraceIds;
    attrs: Record<string, unknown>;
    input_ref?: string | null;
    output_ref?: string | null;
    error?: TrajectoryError | null;
}
export interface EventPair {
    span_id: string;
    correlation_key: string;
    start: TrajectoryEvent | null;
    end: TrajectoryEvent | null;
    events: TrajectoryEvent[];
}
export interface NormalizationWarning {
    code: string;
    message: string;
    step_id?: string | null;
    span_id?: string | null;
    event_id?: string | null;
    metadata: Record<string, unknown>;
}
export interface NormalizationReport {
    schema_version: "openclaw.normalization-report/v1";
    run_id: string;
    generated_at: string;
    warnings: NormalizationWarning[];
    coverage?: {
        schema_version: "openclaw.normalization-coverage/v1";
        sources: Record<string, {
            captured: number;
            missing: number;
            inferred: number;
            lossy: number;
            invalid: number;
            redacted: number;
        }>;
        lossy: string[];
        invalid: string[];
        redacted: string[];
    };
    summary: {
        event_count: number;
        step_count: number;
        diagnostic_step_count: number;
        warning_count: number;
    };
}
export interface BasicInfo {
    started_at: string;
    duration_ms: number;
    status: EventStatus;
    error?: TrajectoryError | null;
}
export interface MetricsInfo {
    llm_duration_ms: number;
    tool_duration_ms: number;
    skill_duration_ms: number;
    shell_duration_ms: number;
    file_duration_ms: number;
    mcp_duration_ms: number;
    state_duration_ms: number;
    other_duration_ms: number;
    instant_step_count: number;
    tool_errors: Record<string, string[]>;
    tool_error_rate: number;
    model_errors: Record<string, string[]>;
    model_error_rate: number;
    tool_step_proportion: number;
    input_tokens: number;
    output_tokens: number;
    total_cost_usd: number;
    [key: string]: unknown;
}
export interface AtomicStep {
    id: string;
    parent_id: string | null;
    type: StepType;
    name: string;
    input: unknown;
    output: unknown;
    basic_info: BasicInfo;
    metadata: Record<string, unknown>;
    model_info?: Record<string, unknown>;
}
export interface AgentStep {
    id: string;
    parent_id: string | null;
    name: string;
    input: unknown;
    output: unknown;
    basic_info: BasicInfo;
    metrics_info: MetricsInfo;
    metadata: Record<string, unknown>;
    steps: AtomicStep[];
}
export interface RootStep {
    id: string;
    name: string;
    input: unknown;
    output: unknown;
    basic_info: BasicInfo;
    metrics_info: MetricsInfo;
    metadata: Record<string, unknown>;
}
export interface OpenClawTrajectory {
    schema_version: "openclaw.trajectory/v1";
    id: string;
    trace_id: string;
    run_id: string;
    root_step: RootStep;
    agent_steps: AgentStep[];
    meta_steps?: AtomicStep[];
    diagnostic_steps?: AtomicStep[];
    links?: TrajectoryLink[];
    session_tree?: TrajectorySessionTree;
}
export interface TrajectoryLink {
    type: "waits_for" | "polls" | "depends_on" | "delegates_to" | "returns_to";
    from_step_id: string;
    to_step_id?: string | null;
    to_session_id?: string | null;
    metadata: Record<string, unknown>;
}
export interface TrajectorySessionTree {
    root_session_id: string | null;
    children: Array<{
        session_id: string;
        agent_id?: string | null;
        parent_step_id: string;
    }>;
}
export interface EvaluationResult {
    evaluator: string;
    score: number;
    reason: string;
    labels: string[];
    metadata: Record<string, unknown>;
}
export interface ReplayPlan {
    mode: "read_only" | "mock";
    run_id: string;
    steps: Array<{
        step_id: string;
        type: StepType;
        name: string;
        action: "inspect" | "mock";
        input_ref?: string | null;
        output_ref?: string | null;
        missing_artifacts: string[];
    }>;
    missing_artifacts: string[];
}

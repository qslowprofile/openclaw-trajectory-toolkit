export type CorrelationIdKind = "span_id" | "step_id" | "tool_call_id" | "skill_invocation_id" | "turn_id";
export interface CanonicalCorrelationId {
    id: string;
    raw: string;
    changed: boolean;
    metadataKey: string;
}
export declare function newTraceId(): string;
export declare function newSpanId(): string;
export declare function newRunId(): string;
export declare function newEventId(): string;
export declare function newTurnId(index: number): string;
export declare function newStepId(index: number, scope?: string): string;
export declare function makeTraceparent(traceId: string, spanId: string, sampled?: boolean): string;
export declare function canonicalCorrelationId(kind: CorrelationIdKind, value: string): CanonicalCorrelationId;

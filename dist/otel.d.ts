import type { TrajectoryEvent } from "./types.js";
export interface OtelSpanRecord {
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    name: string;
    kind: "INTERNAL" | "CLIENT";
    start_time: string;
    end_time: string | null;
    duration_ms: number | null;
    status: {
        code: "OK" | "ERROR" | "UNSET";
        message?: string;
    };
    attributes: Record<string, unknown>;
    events: Array<{
        name: string;
        timestamp: string;
        attributes: Record<string, unknown>;
    }>;
}
export declare function exportOtelSpans(runDir: string): Promise<OtelSpanRecord[]>;
export declare function eventToSpan(event: TrajectoryEvent): OtelSpanRecord;

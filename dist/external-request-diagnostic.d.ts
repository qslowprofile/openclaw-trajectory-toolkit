export declare const externalRequestTypes: Set<string>;
export type ExternalRequestDiagnosticType = "external.request.started" | "external.request.completed" | "external.request.failed";
export interface ExternalRequestDiagnosticEvent {
    schema_version: "openclaw.diagnostic.external-request/v1";
    type: ExternalRequestDiagnosticType;
    externalRequestId: string;
    ts?: number | undefined;
    runId?: string | null | undefined;
    sessionId?: string | null | undefined;
    sessionKey?: string | null | undefined;
    diagnosticStepId?: string | null | undefined;
    diagnosticSpanId?: string | null | undefined;
    parentStepId?: string | null | undefined;
    parentSpanId?: string | null | undefined;
    parentToolCallId?: string | null | undefined;
    trace?: {
        traceId?: string | null | undefined;
        spanId?: string | null | undefined;
        parentSpanId?: string | null | undefined;
        traceFlags?: string | null | undefined;
    } | undefined;
    boundary: "model_provider" | "model_harness" | "model_proxy" | "tool_gateway" | "connector" | "unknown";
    provider?: string | null | undefined;
    model?: string | null | undefined;
    toolName?: string | null | undefined;
    connectorName?: string | null | undefined;
    operation?: string | null | undefined;
    attempt?: number | null | undefined;
    endpoint: string;
    method: string;
    auth: {
        scheme: "none" | "bearer" | "basic" | "api_key" | "oauth" | "aws_sigv4" | "profile" | "unknown";
        source: {
            type: "none" | "env" | "token_provider" | "credential_profile" | "config" | "connector_secret" | "unknown";
            id?: string | null | undefined;
        };
        present: boolean;
        status?: "unknown" | "valid" | "missing" | "expired" | "rejected" | undefined;
        fingerprint?: string | null | undefined;
    };
    http?: {
        status?: number | null | undefined;
        request_id?: string | null | undefined;
        trace_id?: string | null | undefined;
        retry_count?: number | null | undefined;
        headers?: Record<string, string | null> | undefined;
    } | undefined;
    usage?: {
        input_tokens?: number | undefined;
        output_tokens?: number | undefined;
        total_tokens?: number | undefined;
        cache_read_tokens?: number | undefined;
        cache_write_tokens?: number | undefined;
    } | undefined;
    stream?: {
        enabled?: boolean | undefined;
        completed?: boolean | undefined;
        finish_reason?: string | null | undefined;
        chunk_count?: number | null | undefined;
        error_summary?: string | null | undefined;
    } | undefined;
    response_summary?: {
        kind: "none" | "json" | "text" | "binary" | "stream";
        bytes?: number | null | undefined;
        safe_excerpt?: string | null | undefined;
    } | undefined;
    error_summary?: {
        code?: string | number | null | undefined;
        message?: string | null | undefined;
        provider_error_type?: string | null | undefined;
        body_summary?: string | null | undefined;
        retryable?: boolean | null | undefined;
    } | null | undefined;
    coverage?: {
        unavailable_fields?: string[] | undefined;
        reason?: string | null | undefined;
    } | undefined;
    redaction: {
        policy: "external_request_diagnostic_v1";
        secret_fields_removed: string[];
        header_allowlist: string[];
        body_truncated: boolean;
        body_max_bytes: number;
    };
}
export declare function newExternalRequestId(): string;
export declare function sanitizeExternalRequestDiagnosticEvent(raw: Record<string, unknown>): ExternalRequestDiagnosticEvent;
export declare function safeEndpoint(value: unknown): string;
export declare function redactDiagnosticText(value: string, maxChars?: number): string;

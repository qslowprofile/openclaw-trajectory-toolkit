import { randomUUID } from "node:crypto";
import { redactText } from "./artifact-store.js";
export const externalRequestTypes = new Set([
    "external.request.started",
    "external.request.completed",
    "external.request.failed"
]);
const EXTERNAL_REQUEST_HEADER_ALLOWLIST = new Set([
    "x-request-id",
    "request-id",
    "x-amzn-requestid",
    "x-ms-request-id",
    "x-github-request-id",
    "x-hf-request-id",
    "x-openai-request-id",
    "cf-ray",
    "retry-after",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "openai-processing-ms"
]);
const sensitiveQueryKey = /(?:^|[-_.])(api[-_]?key|access[-_]?token|token|secret|signature|x-amz-signature|password|credential)(?:$|[-_.])/i;
const fingerprintPattern = /^hmac-sha256:[0-9a-f]{12,32}$/;
export function newExternalRequestId() {
    return `ext_req_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
export function sanitizeExternalRequestDiagnosticEvent(raw) {
    const type = String(raw.type);
    if (!externalRequestTypes.has(type)) {
        throw new Error(`Unsupported external request diagnostic type: ${type}`);
    }
    const redaction = sanitizeRedaction(objectRecord(raw.redaction));
    const auth = sanitizeAuth(objectRecord(raw.auth), redaction.secret_fields_removed);
    return {
        schema_version: "openclaw.diagnostic.external-request/v1",
        type: type,
        externalRequestId: safeId(raw.externalRequestId, "externalRequestId"),
        ts: numberOrUndefined(raw.ts),
        runId: stringOrNull(raw.runId),
        sessionId: stringOrNull(raw.sessionId),
        sessionKey: stringOrNull(raw.sessionKey),
        diagnosticStepId: stringOrNull(raw.diagnosticStepId),
        diagnosticSpanId: stringOrNull(raw.diagnosticSpanId),
        parentStepId: stringOrNull(raw.parentStepId),
        parentSpanId: stringOrNull(raw.parentSpanId),
        parentToolCallId: stringOrNull(raw.parentToolCallId),
        trace: sanitizeTrace(objectRecord(raw.trace)),
        boundary: boundaryFrom(raw.boundary),
        provider: stringOrNull(raw.provider),
        model: stringOrNull(raw.model),
        toolName: stringOrNull(raw.toolName),
        connectorName: stringOrNull(raw.connectorName),
        operation: stringOrNull(raw.operation),
        attempt: numberOrNull(raw.attempt),
        endpoint: safeEndpoint(raw.endpoint),
        method: safeMethod(raw.method),
        auth,
        http: sanitizeHttp(objectRecord(raw.http), redaction),
        usage: sanitizeUsage(objectRecord(raw.usage)),
        stream: sanitizeStream(objectRecord(raw.stream)),
        response_summary: sanitizeResponseSummary(objectRecord(raw.response_summary)),
        error_summary: sanitizeErrorSummary(objectRecord(raw.error_summary)),
        coverage: sanitizeCoverage(objectRecord(raw.coverage)),
        redaction
    };
}
export function safeEndpoint(value) {
    const endpoint = stringOrNull(value);
    if (!endpoint)
        return "unknown";
    try {
        const url = new URL(endpoint);
        for (const key of [...url.searchParams.keys()]) {
            if (sensitiveQueryKey.test(key)) {
                url.searchParams.set(key, "[REDACTED]");
            }
        }
        return redactDiagnosticText(url.toString(), 2048);
    }
    catch {
        const redacted = endpoint.replace(/[?&]([^=]*(?:key|token|secret|signature|password|credential)[^=]*)=[^&\s]+/gi, "$1=[REDACTED]");
        return redactDiagnosticText(redacted, 2048);
    }
}
export function redactDiagnosticText(value, maxChars = 2048) {
    return redactText(value)
        .value.replaceAll(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
        .replaceAll(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]")
        .slice(0, maxChars);
}
function sanitizeAuth(raw, removed) {
    const source = objectRecord(raw?.source);
    const fingerprint = stringOrNull(raw?.fingerprint);
    const safeFingerprint = fingerprint && fingerprintPattern.test(fingerprint) ? fingerprint : null;
    if (fingerprint && !safeFingerprint) {
        removed.push("auth.fingerprint");
    }
    return {
        scheme: authScheme(raw?.scheme),
        source: {
            type: authSourceType(source?.type),
            id: stringOrNull(source?.id)
        },
        present: booleanFrom(raw?.present, false),
        status: authStatus(raw?.status),
        fingerprint: safeFingerprint
    };
}
function sanitizeHttp(raw, redaction) {
    if (!raw)
        return undefined;
    const headers = objectRecord(raw.headers ?? raw.selected_response_headers ?? raw.selectedResponseHeaders ?? raw.response_headers ?? raw.responseHeaders);
    const safeHeaders = {};
    if (headers) {
        for (const [rawKey, rawValue] of Object.entries(headers)) {
            const key = rawKey.toLowerCase();
            if (!EXTERNAL_REQUEST_HEADER_ALLOWLIST.has(key)) {
                if (/authorization|cookie|api[-_]?key|token|password|secret/i.test(key)) {
                    redaction.secret_fields_removed.push(`http.headers.${key}`);
                }
                continue;
            }
            safeHeaders[key] = rawValue === null ? null : redactDiagnosticText(String(Array.isArray(rawValue) ? rawValue.join(",") : rawValue), 512);
        }
    }
    return {
        status: numberOrNull(raw.status),
        request_id: stringOrNull(raw.request_id ?? raw.requestId),
        trace_id: stringOrNull(raw.trace_id ?? raw.traceId),
        retry_count: numberOrNull(raw.retry_count ?? raw.retryCount),
        headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined
    };
}
function sanitizeUsage(raw) {
    if (!raw)
        return undefined;
    const usage = {
        input_tokens: numberOrUndefined(raw.input_tokens ?? raw.inputTokens),
        output_tokens: numberOrUndefined(raw.output_tokens ?? raw.outputTokens),
        total_tokens: numberOrUndefined(raw.total_tokens ?? raw.totalTokens),
        cache_read_tokens: numberOrUndefined(raw.cache_read_tokens ?? raw.cacheReadTokens),
        cache_write_tokens: numberOrUndefined(raw.cache_write_tokens ?? raw.cacheWriteTokens)
    };
    return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}
function sanitizeStream(raw) {
    if (!raw)
        return undefined;
    return {
        enabled: booleanOrUndefined(raw.enabled),
        completed: booleanOrUndefined(raw.completed),
        finish_reason: stringOrNull(raw.finish_reason ?? raw.finishReason),
        chunk_count: numberOrNull(raw.chunk_count ?? raw.chunkCount),
        error_summary: raw.error_summary || raw.errorSummary ? redactDiagnosticText(String(raw.error_summary ?? raw.errorSummary), 1024) : null
    };
}
function sanitizeResponseSummary(raw) {
    if (!raw)
        return undefined;
    return {
        kind: responseKind(raw.kind),
        bytes: numberOrNull(raw.bytes),
        safe_excerpt: raw.safe_excerpt || raw.safeExcerpt ? redactDiagnosticText(String(raw.safe_excerpt ?? raw.safeExcerpt), 2048) : null
    };
}
function sanitizeErrorSummary(raw) {
    if (!raw)
        return undefined;
    return {
        code: typeof raw.code === "number" || typeof raw.code === "string" ? raw.code : null,
        message: raw.message ? redactDiagnosticText(String(raw.message), 2048) : null,
        provider_error_type: stringOrNull(raw.provider_error_type ?? raw.providerErrorType),
        body_summary: raw.body_summary || raw.bodySummary ? redactDiagnosticText(String(raw.body_summary ?? raw.bodySummary), 2048) : null,
        retryable: booleanOrNull(raw.retryable)
    };
}
function sanitizeCoverage(raw) {
    if (!raw)
        return undefined;
    const unavailableFields = arrayValue(raw.unavailable_fields ?? raw.unavailableFields);
    return {
        unavailable_fields: unavailableFields?.map((item) => String(item).slice(0, 160)),
        reason: stringOrNull(raw.reason)
    };
}
function sanitizeTrace(raw) {
    if (!raw)
        return undefined;
    return {
        traceId: stringOrNull(raw.traceId),
        spanId: stringOrNull(raw.spanId),
        parentSpanId: stringOrNull(raw.parentSpanId),
        traceFlags: stringOrNull(raw.traceFlags)
    };
}
function sanitizeRedaction(raw) {
    const headerAllowlistValues = arrayValue(raw?.header_allowlist ?? raw?.headerAllowlist);
    const secretFieldsRemoved = arrayValue(raw?.secret_fields_removed ?? raw?.secretFieldsRemoved);
    const headerAllowlist = headerAllowlistValues
        ? headerAllowlistValues.map((item) => String(item).toLowerCase()).filter((item) => EXTERNAL_REQUEST_HEADER_ALLOWLIST.has(item))
        : [...EXTERNAL_REQUEST_HEADER_ALLOWLIST];
    return {
        policy: "external_request_diagnostic_v1",
        secret_fields_removed: secretFieldsRemoved?.map((item) => String(item).slice(0, 160)) ?? [],
        header_allowlist: headerAllowlist,
        body_truncated: booleanFrom(raw?.body_truncated ?? raw?.bodyTruncated, false),
        body_max_bytes: numberOrNull(raw?.body_max_bytes ?? raw?.bodyMaxBytes) ?? 2048
    };
}
function arrayValue(value) {
    return Array.isArray(value) ? value : null;
}
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringOrNull(value) {
    if (typeof value === "string" && value.trim().length > 0)
        return redactDiagnosticText(value, 512);
    return null;
}
function numberOrUndefined(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function numberOrNull(value) {
    return numberOrUndefined(value) ?? null;
}
function booleanFrom(value, fallback) {
    if (typeof value === "boolean")
        return value;
    return fallback;
}
function booleanOrUndefined(value) {
    return typeof value === "boolean" ? value : undefined;
}
function booleanOrNull(value) {
    return typeof value === "boolean" ? value : null;
}
function safeId(value, field) {
    const id = typeof value === "string" ? value : "";
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) {
        throw new Error(`Invalid ${field}`);
    }
    return id;
}
function safeMethod(value) {
    const method = typeof value === "string" && value.trim() ? value.toUpperCase() : "UNKNOWN";
    return /^[A-Z]{2,16}$/.test(method) ? method : "UNKNOWN";
}
function boundaryFrom(value) {
    if (value === "model_provider" || value === "model_harness" || value === "model_proxy" || value === "tool_gateway" || value === "connector")
        return value;
    return "unknown";
}
function authScheme(value) {
    if (value === "none" || value === "bearer" || value === "basic" || value === "api_key" || value === "oauth" || value === "aws_sigv4" || value === "profile")
        return value;
    return "unknown";
}
function authSourceType(value) {
    if (value === "none" || value === "env" || value === "token_provider" || value === "credential_profile" || value === "config" || value === "connector_secret")
        return value;
    return "unknown";
}
function authStatus(value) {
    if (value === "unknown" || value === "valid" || value === "missing" || value === "expired" || value === "rejected")
        return value;
    return "unknown";
}
function responseKind(value) {
    if (value === "none" || value === "json" || value === "text" || value === "binary" || value === "stream")
        return value;
    return "none";
}
//# sourceMappingURL=external-request-diagnostic.js.map
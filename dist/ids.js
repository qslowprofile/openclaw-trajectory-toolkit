import { createHash, randomBytes, randomUUID } from "node:crypto";
const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
const safeCorrelationIdPattern = /^[A-Za-z0-9._-]+$/;
const safeStepIdPattern = /^step_[A-Za-z0-9._-]+$/;
export function newTraceId() {
    return randomBytes(16).toString("hex");
}
export function newSpanId() {
    return randomBytes(8).toString("hex");
}
export function newRunId() {
    return `run_${compactUuid()}`;
}
export function newEventId() {
    return `evt_${ulid()}`;
}
export function newTurnId(index) {
    return `turn_${String(index).padStart(4, "0")}`;
}
export function newStepId(index, scope = "") {
    const suffix = String(index).padStart(12, "0");
    return scope ? `step_${scope}_${suffix}` : `step_${suffix}`;
}
export function makeTraceparent(traceId, spanId, sampled = true) {
    return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}
export function canonicalCorrelationId(kind, value) {
    const raw = String(value);
    if (isValidCorrelationId(kind, raw)) {
        return { id: raw, raw, changed: false, metadataKey: rawCorrelationMetadataKey(kind) };
    }
    const prefix = canonicalPrefix(kind);
    const sanitized = raw.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/^_+|_+$/g, "");
    const withoutStepPrefix = kind === "step_id" ? sanitized.replace(/^step_/, "") : sanitized;
    const body = withoutStepPrefix.replaceAll(/_+/g, "_").slice(0, 32).replaceAll(/^_+|_+$/g, "");
    const suffix = shortHash(raw, 12);
    const id = body ? `${prefix}_${body}_${suffix}` : `${prefix}_${suffix}`;
    return { id, raw, changed: true, metadataKey: rawCorrelationMetadataKey(kind) };
}
function isValidCorrelationId(kind, value) {
    if (kind === "step_id")
        return safeStepIdPattern.test(value);
    if (kind === "span_id")
        return safeCorrelationIdPattern.test(value) && value.length >= 8;
    return safeCorrelationIdPattern.test(value);
}
function canonicalPrefix(kind) {
    if (kind === "step_id")
        return "step";
    if (kind === "tool_call_id")
        return "tc";
    if (kind === "skill_invocation_id")
        return "skill";
    if (kind === "turn_id")
        return "turn";
    return "span";
}
function rawCorrelationMetadataKey(kind) {
    if (kind === "tool_call_id")
        return "openclaw.raw_tool_call_id";
    return `openclaw.raw_${kind}`;
}
function compactUuid() {
    return randomUUID().replaceAll("-", "");
}
function ulid() {
    let time = Date.now();
    const timeChars = Array.from({ length: 10 }, () => {
        const index = time % 32;
        time = Math.floor(time / 32);
        return crockford[index] ?? "0";
    }).reverse();
    const random = randomBytes(10);
    const randomChars = [];
    for (let index = 0; index < 16; index += 1) {
        const byte = random[index % random.length] ?? 0;
        randomChars.push(crockford[byte & 31] ?? "0");
    }
    return [...timeChars, ...randomChars].join("");
}
function shortHash(value, length) {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}
//# sourceMappingURL=ids.js.map
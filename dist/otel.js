import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "./artifact-store.js";
import { pairEvents, readEvents } from "./normalizer.js";
export async function exportOtelSpans(runDir) {
    const events = await readEvents(runDir);
    const spans = pairEvents(events).map(pairToSpan).filter((span) => span !== null);
    clampChildStartsToParents(spans);
    await writeFile(join(runDir, "spans.otlp.jsonl"), spans.map((span) => stableStringify(span)).join("\n") + "\n", "utf8");
    return spans;
}
export function eventToSpan(event) {
    return pairToSpan({
        span_id: event.ids.span_id,
        correlation_key: `span:${event.ids.span_id}`,
        start: event.phase === "start" ? event : null,
        end: event.phase === "end" ? event : null,
        events: [event]
    });
}
function pairToSpan(pair) {
    const primary = pair.end ?? pair.start ?? pair.events.at(-1);
    if (!primary)
        return null;
    const start = pair.start ?? primary;
    const end = pair.end ?? (primary.phase === "end" ? primary : null);
    const attrs = { ...(pair.start?.attrs ?? {}), ...(pair.end?.attrs ?? primary.attrs) };
    const statusCode = primary.status === "error" || primary.status === "timeout" ? "ERROR" : primary.status === "ok" ? "OK" : "UNSET";
    return {
        trace_id: primary.ids.trace_id,
        span_id: primary.ids.span_id,
        parent_span_id: primary.ids.parent_span_id ?? null,
        name: primary.kind,
        kind: spanKind(primary, attrs),
        start_time: inferredStartTime(start, end).timestamp,
        end_time: end?.timestamp ?? null,
        duration_ms: end ? durationFromPair(start, end) : null,
        status: {
            code: statusCode,
            ...(primary.error?.message ? { message: primary.error.message } : {})
        },
        attributes: {
            ...attrs,
            ...inferenceAttributes(start, end),
            "openclaw.run_id": primary.ids.run_id,
            "openclaw.session_id": primary.ids.session_id ?? "",
            "openclaw.turn_id": primary.ids.turn_id ?? "",
            "openclaw.step_id": primary.ids.step_id ?? "",
            "openclaw.event_id": primary.event_id,
            "openclaw.start_event_id": start.event_id,
            "openclaw.event.phase": end ? "end" : start.phase,
            "openclaw.event.actor": primary.actor,
            "openclaw.input_ref": start.input_ref ?? end?.input_ref ?? "",
            "openclaw.output_ref": end?.output_ref ?? start.output_ref ?? ""
        },
        events: primary.error
            ? [
                {
                    name: "exception",
                    timestamp: primary.timestamp,
                    attributes: {
                        "exception.message": primary.error.message,
                        "exception.stacktrace": primary.error.stack ?? ""
                    }
                }
            ]
            : []
    };
}
const clientActors = new Set(["model", "tool", "mcp"]);
function spanKind(primary, attrs) {
    if (clientActors.has(primary.actor))
        return "CLIENT";
    if (attrs["openclaw.diagnostic_only"] === true && primary.kind.startsWith("external.request."))
        return "CLIENT";
    return "INTERNAL";
}
function durationFromPair(start, end) {
    const explicit = numberAttr(end.attrs.duration_ms);
    const inferred = inferredStartTime(start, end);
    if (inferred.inferred && explicit > 0)
        return explicit;
    return Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp));
}
function inferredStartTime(start, end) {
    if (!end)
        return { timestamp: start.timestamp, inferred: false };
    const duration = numberAttr(end.attrs.duration_ms);
    if (duration <= 0)
        return { timestamp: start.timestamp, inferred: false };
    const startGenerated = start.attrs["openclaw.timestamp.generated"] === true;
    if (start === end || startGenerated) {
        return { timestamp: new Date(Date.parse(end.timestamp) - duration).toISOString(), inferred: true };
    }
    return { timestamp: start.timestamp, inferred: false };
}
function inferenceAttributes(start, end) {
    const attrs = {};
    const inferred = inferredStartTime(start, end);
    if (inferred.inferred) {
        attrs["openclaw.start_time_inferred"] = true;
    }
    const reportedDuration = numberAttr(end?.attrs.duration_ms);
    if (reportedDuration > 0) {
        attrs["openclaw.duration_ms.reported"] = reportedDuration;
    }
    return attrs;
}
function clampChildStartsToParents(spans) {
    const startBySpan = new Map(spans.map((span) => [span.span_id, span.start_time]));
    for (const span of spans) {
        if (!span.parent_span_id || !span.end_time)
            continue;
        const parentStart = startBySpan.get(span.parent_span_id);
        if (!parentStart)
            continue;
        if (Date.parse(span.start_time) >= Date.parse(parentStart))
            continue;
        if (span.attributes["openclaw.start_time_inferred"] !== true)
            continue;
        span.start_time = parentStart;
        span.attributes["openclaw.start_time_inferred"] = true;
        span.attributes["openclaw.start_time_clamped_to_parent"] = true;
        span.duration_ms = Math.max(0, Date.parse(span.end_time) - Date.parse(span.start_time));
    }
}
function numberAttr(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
//# sourceMappingURL=otel.js.map
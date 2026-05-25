import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore, stableStringify } from "./artifact-store.js";
const EVENT_LINE_NO = Symbol("openclaw.event.line_no");
export async function normalizeRun(runDir, options = {}) {
    const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    const events = await readEvents(runDir);
    const artifactStore = new ArtifactStore(join(runDir, "artifacts"));
    const rootStart = events.find((event) => event.kind === "openclaw.request" && event.phase === "start");
    const rootEnd = [...events].reverse().find((event) => event.kind === "openclaw.request" && event.phase === "end");
    const atomicPairs = pairEvents(events.filter((event) => event.kind !== "openclaw.request"));
    const steps = [];
    const metaSteps = [];
    const diagnosticSteps = [];
    const pairWarnings = [];
    for (const pair of atomicPairs) {
        const step = await pairToStep(pair, artifactStore, options.artifactMode ?? "safe", options.inferSpecs === true);
        if (!step)
            continue;
        if (isMetaTracePair(pair)) {
            metaSteps.push(step);
        }
        else if (isDiagnosticOnlyPair(pair)) {
            diagnosticSteps.push(step);
        }
        else {
            if (isMixedDiagnosticPair(pair)) {
                const primary = pair.end ?? pair.start ?? pair.events.at(-1);
                pairWarnings.push({
                    code: "diagnostic_pair_mixed",
                    message: "diagnostic-only event shares a correlation key with a main trajectory event",
                    step_id: primary?.ids.step_id ?? null,
                    span_id: primary?.ids.span_id ?? null,
                    event_id: primary?.event_id ?? null,
                    metadata: { correlation_key: pair.correlation_key }
                });
            }
            steps.push(step);
        }
    }
    const rootBasic = makeRootBasic(run, rootStart, rootEnd, steps);
    if ((options.childClamp ?? "warn") === "root") {
        clampChildStepsToRoot(steps, rootBasic);
    }
    const metrics = buildMetrics(steps);
    if (metaSteps.length > 0) {
        metrics.meta_trace = buildMetaTraceMetrics(metaSteps);
    }
    const { agentSteps, warnings: parentWarnings } = buildAgentSteps(run, events, steps, rootBasic);
    const links = buildTrajectoryLinks(steps);
    const sessionTree = buildSessionTree(run, links);
    const report = buildNormalizationReport(run, events, atomicPairs, steps, diagnosticSteps, rootBasic, rootStart, rootEnd, [...parentWarnings, ...pairWarnings]);
    const trajectory = {
        schema_version: "openclaw.trajectory/v1",
        id: `traj_${run.run_id}`,
        trace_id: run.trace_id,
        run_id: run.run_id,
        root_step: {
            id: run.root_span_id,
            name: "openclaw_request",
            input: run.input,
            output: run.output,
            basic_info: rootBasic,
            metrics_info: metrics,
            metadata: rootMetadata(run)
        },
        agent_steps: agentSteps,
        ...(metaSteps.length > 0 ? { meta_steps: metaSteps } : {}),
        ...(diagnosticSteps.length > 0 ? { diagnostic_steps: diagnosticSteps } : {}),
        ...(links.length > 0 ? { links } : {}),
        ...(sessionTree.children.length > 0 || sessionTree.root_session_id ? { session_tree: sessionTree } : {})
    };
    await writeFile(join(runDir, "trajectory.json"), `${stableStringify(trajectory)}\n`, "utf8");
    await writeFile(join(runDir, "normalization_report.json"), `${stableStringify(report)}\n`, "utf8");
    return trajectory;
}
export async function readEvents(runDir) {
    const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
    return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
        const event = JSON.parse(line);
        event[EVENT_LINE_NO] = index + 1;
        return event;
    });
}
export function pairEvents(events) {
    const byCorrelation = new Map();
    for (const event of events) {
        const key = correlationKey(event);
        const group = byCorrelation.get(key) ?? [];
        group.push(event);
        byCorrelation.set(key, group);
    }
    return Array.from(byCorrelation.entries()).map(([key, group]) => {
        const sorted = [...group].sort(compareEvents);
        return {
            span_id: sorted.at(-1)?.ids.span_id ?? key,
            correlation_key: key,
            start: sorted.find((event) => event.phase === "start") ?? null,
            end: [...sorted].reverse().find((event) => event.phase === "end") ?? null,
            events: sorted
        };
    });
}
function compareEvents(left, right) {
    const byTimestamp = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (byTimestamp !== 0)
        return byTimestamp;
    const byLine = numberAttr(left[EVENT_LINE_NO]) - numberAttr(right[EVENT_LINE_NO]);
    if (byLine !== 0)
        return byLine;
    return left.event_id.localeCompare(right.event_id);
}
function correlationKey(event) {
    if (event.ids.step_id && event.attrs["openclaw.step_id.generated"] !== true)
        return `step:${event.ids.step_id}`;
    if (event.ids.tool_call_id)
        return `tool_call:${event.ids.tool_call_id}`;
    if (event.ids.skill_invocation_id)
        return `skill_invocation:${event.ids.skill_invocation_id}`;
    return `span:${event.ids.span_id}`;
}
async function pairToStep(pair, artifactStore, artifactMode, inferSpecs) {
    const primary = pair.end ?? pair.start ?? pair.events.at(-1);
    if (!primary)
        return null;
    const start = pair.start ?? primary;
    const end = pair.end ?? primary;
    const inputRef = start.input_ref ?? end.input_ref ?? null;
    const outputRef = end.output_ref ?? start.output_ref ?? null;
    const inputArtifact = inputRef ? await readArtifactForStep(artifactStore, inputRef, artifactMode) : null;
    const outputArtifact = outputRef ? await readArtifactForStep(artifactStore, outputRef, artifactMode) : null;
    const attrs = { ...start.attrs, ...end.attrs };
    const metadataAttrs = sanitizeStepAttrs(attrs);
    if (primary.ids.session_id && metadataAttrs["openclaw.session_id"] === undefined) {
        metadataAttrs["openclaw.session_id"] = primary.ids.session_id;
    }
    const type = stepTypeFromEvent(primary.actor, primary.kind);
    const instant = primary.phase === "event" && !pair.start && !pair.end;
    const reportedDuration = numberAttr(end.attrs.duration_ms);
    const computedDuration = start.timestamp && end.timestamp ? Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp)) : null;
    const step = {
        id: primary.ids.step_id ?? primary.ids.span_id,
        parent_id: primary.ids.parent_span_id ?? null,
        type,
        name: stepName({ ...primary, attrs }, type),
        input: inputArtifact?.value ?? null,
        output: outputArtifact?.value ?? null,
        basic_info: makeBasicInfo(start.timestamp, instant ? 0 : durationFromPair(start, end), end.status, end.error ?? null),
        metadata: {
            ...metadataAttrs,
            ...(instant ? { instant: true } : {}),
            event_id: end.event_id,
            start_event_id: start.event_id,
            trace_id: primary.ids.trace_id,
            span_id: primary.ids.span_id,
            input_ref: inputRef,
            output_ref: outputRef,
            duration_reported_ms: reportedDuration > 0 ? reportedDuration : null,
            duration_computed_ms: computedDuration,
            duration_source: instant ? "instant" : reportedDuration > 0 ? "reported" : "computed",
            artifact_inline: {
                input_ref: inputRef,
                output_ref: outputRef,
                input_summary: inputArtifact?.summary ?? null,
                output_summary: outputArtifact?.summary ?? null,
                input_redacted: inputArtifact?.redacted ?? false,
                output_redacted: outputArtifact?.redacted ?? false,
                input_redacted_keys: inputArtifact?.redactedKeys ?? [],
                output_redacted_keys: outputArtifact?.redactedKeys ?? []
            }
        }
    };
    if (inferSpecs) {
        attachInferredSpec(step);
    }
    attachStateMetadata(step);
    attachOpenClawProjection(step, end.event_id);
    if (type === "model") {
        step.model_info = {
            model: attrs["gen_ai.request.model"] ?? attrs["model.name"] ?? null,
            input_tokens: numberAttr(attrs["gen_ai.usage.input_tokens"]),
            output_tokens: numberAttr(attrs["gen_ai.usage.output_tokens"]),
            latency_first_resp_ms: numberAttr(attrs["gen_ai.latency.first_response_ms"]),
            cost_usd: roundMetric(numberAttr(attrs["gen_ai.cost.usd"]), 6)
        };
    }
    return step;
}
function attachOpenClawProjection(step, rawEventId) {
    const hook = stringAttr(step.metadata["openclaw.hook"]);
    if (!hook)
        return;
    if (step.metadata["openclaw.ui_category"] === undefined) {
        step.metadata["openclaw.ui_category"] = uiCategoryForStep(step, hook);
    }
    if (step.metadata["openclaw.raw_event_ref"] === undefined) {
        step.metadata["openclaw.raw_event_ref"] = rawEventId;
    }
    if (step.metadata["openclaw.display_title"] === undefined) {
        step.metadata["openclaw.display_title"] = displayTitleForStep(step, hook);
    }
}
function uiCategoryForStep(step, hook) {
    if (hook.startsWith("diagnostic."))
        return "diagnostic";
    if (step.type === "model")
        return "model";
    if (step.type === "tool" || step.type === "shell" || step.type === "file" || step.type === "mcp" || step.type === "skill")
        return "tool";
    if (step.type === "agent")
        return "agent";
    if (hook.includes("message"))
        return "message";
    return "state";
}
function displayTitleForStep(step, hook) {
    if (step.type === "model")
        return `Model: ${step.name}`;
    if (step.type === "tool" || step.type === "shell" || step.type === "file" || step.type === "mcp" || step.type === "skill")
        return `Tool: ${step.name}`;
    if (step.type === "agent")
        return `Agent: ${step.name}`;
    if (hook.startsWith("diagnostic."))
        return `Diagnostic: ${hook.slice("diagnostic.".length)}`;
    return step.name;
}
function rootMetadata(run) {
    return {
        ...(run.metadata ?? {}),
        ...(run.session_id ? { "openclaw.session_id": run.session_id } : {}),
        ...(run.session_key ? { "openclaw.session_key": run.session_key } : {}),
        ...(run.root_session_id ? { "openclaw.root_session_id": run.root_session_id } : {}),
        ...(run.parent_session_id ? { "openclaw.parent_session_id": run.parent_session_id } : {}),
        ...(run.agent_id ? { "openclaw.agent_id": run.agent_id } : {}),
        ...(run.agent_name ? { "openclaw.agent_name": run.agent_name, "agent.name": run.agent_name } : {})
    };
}
function isMetaTracePair(pair) {
    return pair.events.some((event) => event.attrs["openclaw.meta_trace"] === true);
}
function isDiagnosticOnlyPair(pair) {
    return pair.events.length > 0 && pair.events.every((event) => event.attrs["openclaw.diagnostic_only"] === true);
}
function isMixedDiagnosticPair(pair) {
    const diagnosticCount = pair.events.filter((event) => event.attrs["openclaw.diagnostic_only"] === true).length;
    return diagnosticCount > 0 && diagnosticCount < pair.events.length;
}
function sanitizeStepAttrs(attrs) {
    const next = {};
    for (const [key, value] of Object.entries(attrs)) {
        if (key === "openclaw.meta_trace")
            continue;
        if (key === "openclaw.meta_trace.operation") {
            next["openclaw.meta_trace.operation"] = value;
            continue;
        }
        next[key] = value;
    }
    return next;
}
function attachInferredSpec(step) {
    if (step.metadata.spec_quality || step.metadata.manifest_ref || step.metadata.tool_spec_ref || step.metadata._inferred) {
        return;
    }
    if (step.type === "skill") {
        step.metadata._inferred = {
            spec_quality: "inferred",
            schema_confidence: "low",
            spec: {
                schema_version: "openclaw.skill/v1",
                name: step.name,
                version: String(step.metadata["skill.version"] ?? "inferred"),
                input_schema: inferSchema(step.input),
                output_schema: inferSchema(step.output),
                permissions: [],
                tool_dependencies: []
            }
        };
    }
    if (step.type === "tool") {
        step.metadata._inferred = {
            spec_quality: "inferred",
            schema_confidence: "low",
            spec: {
                schema_version: "openclaw.tool/v1",
                namespace: String(step.metadata["tool.namespace"] ?? "inferred"),
                name: step.name,
                version: String(step.metadata["tool.version"] ?? "inferred"),
                input_schema: inferSchema(step.input),
                output_schema: inferSchema(step.output),
                side_effect: String(step.metadata["tool.side_effect"] ?? "unknown"),
                determinism: "unknown"
            }
        };
    }
}
function inferSchema(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { type: jsonType(value) };
    }
    const properties = {};
    for (const [key, item] of Object.entries(value)) {
        properties[key] = { type: jsonType(item) };
    }
    return {
        type: "object",
        properties,
        required: Object.keys(properties)
    };
}
function jsonType(value) {
    if (Array.isArray(value))
        return "array";
    if (value === null)
        return "null";
    return typeof value;
}
function buildMetrics(steps) {
    const metrics = {
        llm_duration_ms: 0,
        tool_duration_ms: 0,
        skill_duration_ms: 0,
        shell_duration_ms: 0,
        file_duration_ms: 0,
        mcp_duration_ms: 0,
        state_duration_ms: 0,
        other_duration_ms: 0,
        instant_step_count: 0,
        tool_errors: {},
        tool_error_rate: 0,
        model_errors: {},
        model_error_rate: 0,
        tool_step_proportion: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0
    };
    let toolCount = 0;
    let modelCount = 0;
    let toolErrorCount = 0;
    let modelErrorCount = 0;
    for (const step of steps) {
        const duration = step.basic_info.duration_ms;
        if (step.metadata.instant === true) {
            metrics.instant_step_count += 1;
        }
        if (step.type === "model") {
            modelCount += 1;
            metrics.llm_duration_ms += duration;
            metrics.input_tokens += numberAttr(step.model_info?.input_tokens);
            metrics.output_tokens += numberAttr(step.model_info?.output_tokens);
            metrics.total_cost_usd = roundMetric(metrics.total_cost_usd + numberAttr(step.model_info?.cost_usd), 6);
            if (step.basic_info.status === "error") {
                modelErrorCount += 1;
                addError(metrics.model_errors, step.basic_info.error?.code ?? "error", step.id);
            }
        }
        if (step.type === "tool") {
            toolCount += 1;
            metrics.tool_duration_ms += duration;
            if (step.basic_info.status === "error") {
                toolErrorCount += 1;
                addError(metrics.tool_errors, step.basic_info.error?.code ?? "error", step.id);
            }
        }
        if (step.type === "skill") {
            metrics.skill_duration_ms += duration;
        }
        if (step.type === "shell") {
            metrics.shell_duration_ms += duration;
        }
        if (step.type === "file") {
            metrics.file_duration_ms = numberAttr(metrics.file_duration_ms) + duration;
        }
        if (step.type === "mcp") {
            metrics.mcp_duration_ms = numberAttr(metrics.mcp_duration_ms) + duration;
        }
        if (step.type === "state") {
            metrics.state_duration_ms = numberAttr(metrics.state_duration_ms) + duration;
        }
        if (!["agent", "model", "tool", "skill", "shell", "file", "mcp", "state"].includes(step.type)) {
            metrics.other_duration_ms = numberAttr(metrics.other_duration_ms) + duration;
        }
    }
    metrics.tool_error_rate = toolCount === 0 ? 0 : toolErrorCount / toolCount;
    metrics.model_error_rate = modelCount === 0 ? 0 : modelErrorCount / modelCount;
    metrics.tool_step_proportion = steps.length === 0 ? 0 : toolCount / steps.length;
    return metrics;
}
function buildMetaTraceMetrics(steps) {
    let durationMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let errorCount = 0;
    for (const step of steps) {
        durationMs += step.basic_info.duration_ms;
        inputTokens += numberAttr(step.model_info?.input_tokens);
        outputTokens += numberAttr(step.model_info?.output_tokens);
        costUsd = roundMetric(costUsd + numberAttr(step.model_info?.cost_usd), 6);
        if (step.basic_info.status === "error" || step.basic_info.status === "timeout") {
            errorCount += 1;
        }
    }
    return {
        count: steps.length,
        duration_ms: durationMs,
        error_count: errorCount,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd
    };
}
function buildTrajectoryLinks(steps) {
    const links = [];
    const backgroundJobToStep = new Map();
    for (const step of steps) {
        const backgroundJobId = stringAttr(step.metadata["openclaw.background_job_id"] ?? step.metadata.background_job_id ?? outputField(step.output, "background_job_id"));
        if (backgroundJobId) {
            backgroundJobToStep.set(backgroundJobId, step.id);
        }
    }
    for (const step of steps) {
        const delegatedTo = stringAttr(step.metadata["openclaw.delegated_to_session_id"]) ??
            stringAttr(step.metadata["openclaw.child_session_id"]) ??
            stringAttr(outputField(step.output, "session_id")) ??
            (step.name === "sessions_spawn" ? stringAttr(outputField(step.output, "id")) : null);
        if (delegatedTo) {
            links.push({
                type: "delegates_to",
                from_step_id: step.id,
                to_session_id: delegatedTo,
                metadata: {
                    child_agent_id: stringAttr(step.metadata["openclaw.child_agent_id"]) ?? null,
                    source: "openclaw.delegation"
                }
            });
        }
        const pollTarget = stringAttr(step.metadata["openclaw.poll_target_job_id"] ?? step.metadata.poll_target_job_id ?? inputField(step.input, "job_id"));
        if (pollTarget) {
            links.push({
                type: "polls",
                from_step_id: step.id,
                to_step_id: backgroundJobToStep.get(pollTarget) ?? null,
                metadata: {
                    background_job_id: pollTarget,
                    unresolved: !backgroundJobToStep.has(pollTarget)
                }
            });
        }
    }
    return links;
}
function buildSessionTree(run, links) {
    const children = links
        .filter((link) => link.type === "delegates_to" && typeof link.to_session_id === "string" && link.to_session_id.length > 0)
        .map((link) => ({
        session_id: link.to_session_id,
        agent_id: stringAttr(link.metadata.child_agent_id) ?? null,
        parent_step_id: link.from_step_id
    }));
    return {
        root_session_id: run.root_session_id ?? run.session_id ?? null,
        children
    };
}
function inputField(value, key) {
    const object = objectValue(value);
    return object?.[key];
}
function outputField(value, key) {
    const object = objectValue(value);
    return object?.[key];
}
function stepTypeFromEvent(actor, kind) {
    if (actor === "agent")
        return "agent";
    if (actor === "model")
        return "model";
    if (actor === "skill")
        return "skill";
    if (actor === "tool")
        return "tool";
    if (actor === "mcp")
        return "mcp";
    if (actor === "file")
        return "file";
    if (actor === "shell")
        return "shell";
    if (actor === "state")
        return "state";
    if (kind.includes("graph"))
        return "graph";
    if (actor === "artifact")
        return "artifact";
    if (actor === "evaluator")
        return "eval";
    return "state";
}
function stepName(event, type) {
    if (type === "skill")
        return String(event.attrs["skill.name"] ?? event.kind);
    if (type === "tool")
        return String(event.attrs["tool.name"] ?? event.kind);
    if (type === "model")
        return String(event.attrs["gen_ai.request.model"] ?? event.kind);
    if (type === "file")
        return String(event.attrs["file.path"] ?? event.kind);
    if (type === "shell")
        return shellCommandName(event.attrs.command) ?? event.kind;
    if (type === "mcp")
        return String(event.attrs["mcp.method.name"] ?? event.kind);
    return event.kind;
}
function makeBasicInfo(startedAt, durationMs, status, error) {
    return {
        started_at: startedAt,
        duration_ms: durationMs,
        status,
        error: error ?? null
    };
}
function makeRootBasic(run, rootStart, rootEnd, steps) {
    const rootStartedAt = rootStart?.timestamp ?? run.started_at;
    const rootStartMs = Date.parse(rootStartedAt);
    const rootDuration = durationFromRoot(rootStart, rootEnd);
    return makeBasicInfo(new Date(rootStartMs).toISOString(), rootDuration, (rootEnd?.status ?? run.status), rootEnd?.error ?? null);
}
function inferAgentName(run, events) {
    const runAgentName = run.metadata?.["agent.name"];
    if (typeof runAgentName === "string" && runAgentName.trim().length > 0) {
        return runAgentName;
    }
    const eventAgentName = events
        .map((event) => event.attrs["agent.name"])
        .find((value) => typeof value === "string" && value.trim().length > 0);
    return eventAgentName ?? "default_agent";
}
function buildAgentSteps(run, events, steps, rootBasic) {
    const defaultAgentName = inferAgentName(run, events);
    const groups = new Map();
    const spanToStepId = new Map();
    const warnings = [];
    for (const step of steps) {
        const spanId = stringAttr(step.metadata.span_id);
        if (spanId) {
            spanToStepId.set(spanId, step.id);
        }
    }
    for (const step of steps) {
        const name = stringAttr(step.metadata["agent.name"]) ?? defaultAgentName;
        const group = groups.get(name) ?? [];
        group.push(step);
        groups.set(name, group);
    }
    if (groups.size === 0) {
        groups.set(defaultAgentName, []);
    }
    const agentSteps = Array.from(groups.entries()).map(([name, groupSteps]) => {
        const id = `agent_${safeAgentName(name)}_${run.run_id}`;
        for (const step of groupSteps) {
            const originalParent = step.parent_id;
            step.metadata.trace_parent_span_id = originalParent;
            if (originalParent === run.root_span_id || originalParent === null) {
                step.parent_id = id;
                continue;
            }
            const mappedParentId = spanToStepId.get(originalParent);
            if (mappedParentId && mappedParentId !== step.id) {
                step.parent_id = mappedParentId;
                continue;
            }
            step.parent_id = id;
            warnings.push({
                code: "dangling_parent",
                message: "parent_span_id does not resolve to the root span or another atomic step",
                step_id: step.id,
                span_id: stringAttr(step.metadata.span_id),
                event_id: stringAttr(step.metadata.event_id),
                metadata: {
                    parent_span_id: originalParent,
                    agent_step_id: id
                }
            });
        }
        return {
            id,
            parent_id: run.root_span_id,
            name,
            input: run.input,
            output: run.output,
            basic_info: makeAgentBasic(rootBasic, groupSteps),
            metrics_info: groupSteps.length > 0 ? buildMetrics(groupSteps) : buildMetrics([]),
            metadata: {
                ...(run.metadata ?? {}),
                source: {
                    type: "events.jsonl",
                    schema_version: "openclaw.event/v1"
                }
            },
            steps: groupSteps
        };
    });
    return { agentSteps, warnings };
}
function safeAgentName(name) {
    return name.replaceAll(/[^A-Za-z0-9_-]/g, "_").replaceAll(/^_+|_+$/g, "").slice(0, 32) || "default";
}
function makeAgentBasic(rootBasic, steps) {
    if (steps.length === 0)
        return rootBasic;
    const starts = steps.map((step) => Date.parse(step.basic_info.started_at)).filter(Number.isFinite);
    const ends = steps
        .map((step) => Date.parse(step.basic_info.started_at) + step.basic_info.duration_ms)
        .filter(Number.isFinite);
    const start = Math.min(...starts);
    const end = Math.max(...ends);
    const failed = steps.find((step) => step.basic_info.status === "error" || step.basic_info.status === "timeout");
    const allOk = steps.every((step) => step.basic_info.status === "ok");
    return makeBasicInfo(new Date(start).toISOString(), Math.max(0, end - start), failed?.basic_info.status ?? (allOk ? "ok" : rootBasic.status), failed?.basic_info.error ?? null);
}
function buildNormalizationReport(run, events, pairs, steps, diagnosticSteps, rootBasic, rootStart, rootEnd, extraWarnings = []) {
    const warnings = [...extraWarnings];
    for (const pair of pairs) {
        const primary = pair.end ?? pair.start ?? pair.events.at(-1);
        if (!primary)
            continue;
        if (pair.start && !pair.end) {
            warnings.push({
                code: "missing_end_event",
                message: "start event has no matching end event",
                step_id: primary.ids.step_id ?? null,
                span_id: primary.ids.span_id,
                event_id: primary.event_id,
                metadata: { correlation_key: pair.correlation_key, kind: primary.kind }
            });
        }
        if (!pair.start && pair.end && primary.phase === "end" && primary.attrs.duration_ms === undefined) {
            warnings.push({
                code: "missing_start_event",
                message: "end event has no matching start event and no explicit duration",
                step_id: primary.ids.step_id ?? null,
                span_id: primary.ids.span_id,
                event_id: primary.event_id,
                metadata: { correlation_key: pair.correlation_key, kind: primary.kind }
            });
        }
        if (pair.start && pair.end) {
            if (pair.events.some((event) => event.phase === "event")) {
                warnings.push({
                    code: "unexpected_phase_mix",
                    message: "start/end events share a correlation key with instant phase=event records",
                    step_id: primary.ids.step_id ?? null,
                    span_id: primary.ids.span_id,
                    event_id: primary.event_id,
                    metadata: { correlation_key: pair.correlation_key, kind: primary.kind }
                });
            }
            const reported = numberAttr(pair.end.attrs.duration_ms);
            const computed = Math.max(0, Date.parse(pair.end.timestamp) - Date.parse(pair.start.timestamp));
            const threshold = Math.max(100, Math.max(reported, computed) * 0.05);
            if (reported > 0 && Math.abs(reported - computed) > threshold) {
                warnings.push({
                    code: "duration_mismatch",
                    message: "reported duration_ms differs from start/end timestamp duration",
                    step_id: primary.ids.step_id ?? null,
                    span_id: primary.ids.span_id,
                    event_id: primary.event_id,
                    metadata: {
                        correlation_key: pair.correlation_key,
                        kind: primary.kind,
                        reported_duration_ms: reported,
                        timestamp_duration_ms: computed
                    }
                });
            }
        }
    }
    const originalRootStartedAt = rootStart?.timestamp ?? run.started_at;
    const originalRootStartMs = Date.parse(originalRootStartedAt);
    const originalRootDuration = durationFromRoot(rootStart, rootEnd);
    const originalRootEndMs = rootEnd ? Date.parse(rootEnd.timestamp) : originalRootStartMs + originalRootDuration;
    const normalizedRootEndMs = Date.parse(rootBasic.started_at) + rootBasic.duration_ms;
    let rootWindowExtended = false;
    for (const step of steps) {
        const stepStartMs = Date.parse(step.basic_info.started_at);
        const stepEndMs = Date.parse(step.basic_info.started_at) + step.basic_info.duration_ms;
        if (stepStartMs < originalRootStartMs - 5 || stepEndMs > originalRootEndMs + 5) {
            rootWindowExtended = true;
        }
    }
    if (rootWindowExtended) {
        warnings.push({
            code: "root_window_extended",
            message: "child step timestamps fall outside the root event window",
            step_id: null,
            span_id: null,
            event_id: null,
            metadata: {
                original_started_at: new Date(originalRootStartMs).toISOString(),
                original_duration_ms: Math.max(0, originalRootEndMs - originalRootStartMs),
                root_started_at: rootBasic.started_at,
                root_duration_ms: rootBasic.duration_ms,
                root_end_at: new Date(normalizedRootEndMs).toISOString()
            }
        });
    }
    return {
        schema_version: "openclaw.normalization-report/v1",
        run_id: run.run_id,
        generated_at: new Date().toISOString(),
        warnings,
        coverage: buildNormalizationCoverage(events, warnings),
        summary: {
            event_count: events.length,
            step_count: steps.length,
            diagnostic_step_count: diagnosticSteps.length,
            warning_count: warnings.length
        }
    };
}
function buildNormalizationCoverage(events, warnings) {
    const sources = {
        native_hook: emptyCoverageBucket(),
        diagnostic_event: emptyCoverageBucket(),
        session_jsonl: emptyCoverageBucket(),
        message_log_import: emptyCoverageBucket(),
        openclaw_bundle: emptyCoverageBucket()
    };
    const lossy = new Set();
    const invalid = new Set();
    const redacted = new Set();
    for (const event of events) {
        const source = coverageSource(event);
        sources[source].captured += 1;
        if (event.attrs["openclaw.timestamp.generated"] === true || event.attrs["openclaw.step_id.generated"] === true || event.attrs["openclaw.span_id.generated"] === true) {
            sources[source].inferred += 1;
        }
        const redactedKeys = event.attrs["openclaw.redacted_attr_keys"];
        if (Array.isArray(redactedKeys) && redactedKeys.length > 0) {
            sources[source].redacted += redactedKeys.length;
            for (const key of redactedKeys)
                redacted.add(String(key));
        }
    }
    for (const warning of warnings) {
        if (warning.code === "missing_start_event" || warning.code === "missing_end_event" || warning.code === "duration_mismatch") {
            lossy.add(warning.code);
        }
        if (warning.code === "unexpected_phase_mix" || warning.code === "dangling_parent") {
            invalid.add(warning.code);
        }
    }
    for (const code of lossy) {
        for (const source of Object.values(sources))
            source.lossy += 1;
    }
    for (const code of invalid) {
        for (const source of Object.values(sources))
            source.invalid += 1;
    }
    return {
        schema_version: "openclaw.normalization-coverage/v1",
        sources,
        lossy: Array.from(lossy).sort(),
        invalid: Array.from(invalid).sort(),
        redacted: Array.from(redacted).sort()
    };
}
function emptyCoverageBucket() {
    return {
        captured: 0,
        missing: 0,
        inferred: 0,
        lossy: 0,
        invalid: 0,
        redacted: 0
    };
}
function coverageSource(event) {
    if (event.attrs["openclaw.import_source"] === "message_log")
        return "message_log_import";
    if (event.attrs["openclaw.import_source"] === "openclaw_bundle")
        return "openclaw_bundle";
    if (String(event.attrs["openclaw.hook"] ?? "").startsWith("diagnostic."))
        return "diagnostic_event";
    if (event.attrs["evidence.source"] === "openclaw_session_log" || event.attrs["recording.source"] === "session-log")
        return "session_jsonl";
    return "native_hook";
}
function clampChildStepsToRoot(steps, rootBasic) {
    const rootStartMs = Date.parse(rootBasic.started_at);
    const rootEndMs = rootStartMs + rootBasic.duration_ms;
    for (const step of steps) {
        const stepStartMs = Date.parse(step.basic_info.started_at);
        const stepEndMs = stepStartMs + step.basic_info.duration_ms;
        if (!Number.isFinite(stepStartMs) || !Number.isFinite(stepEndMs))
            continue;
        if (stepStartMs < rootStartMs) {
            const nextDuration = Math.max(0, Math.min(stepEndMs, rootEndMs) - rootStartMs);
            step.basic_info.started_at = rootBasic.started_at;
            step.basic_info.duration_ms = nextDuration;
            step.metadata.duration_clamped = true;
            continue;
        }
        if (stepEndMs > rootEndMs) {
            step.basic_info.duration_ms = Math.max(0, rootEndMs - stepStartMs);
            step.metadata.duration_clamped = true;
        }
    }
}
function durationFromRoot(start, end) {
    const explicit = numberAttr(end?.attrs.duration_ms);
    if (explicit > 0)
        return explicit;
    if (!start || !end)
        return 0;
    return Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp));
}
function durationFromPair(start, end) {
    const explicit = numberAttr(end.attrs.duration_ms);
    if (explicit > 0)
        return explicit;
    return Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp));
}
function numberAttr(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
function roundMetric(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
function stringAttr(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function addError(target, code, stepId) {
    const key = String(code);
    target[key] ??= [];
    target[key].push(stepId);
}
function shellCommandName(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    if (trimmed.length <= 40)
        return trimmed;
    const head = trimmed.split(/\s+/)[0] ?? "shell";
    return `${head} ... (${trimmed.length} chars)`;
}
async function readArtifactForStep(artifactStore, uri, mode) {
    const metadata = await artifactStore.readMetadata(uri);
    if (mode === "ref" || mode === "summary" || (mode === "safe" && metadata.redacted)) {
        return {
            value: null,
            summary: metadata.summary,
            redacted: metadata.redacted,
            redactedKeys: metadata.redacted_keys
        };
    }
    return {
        value: await artifactStore.readJson(uri),
        summary: metadata.summary,
        redacted: metadata.redacted,
        redactedKeys: metadata.redacted_keys
    };
}
function attachStateMetadata(step) {
    if (step.type !== "state")
        return;
    const rawOperation = stringAttr(step.metadata["state.operation"]) ?? stateOperationFromKind(step.name).raw;
    if (rawOperation) {
        const operation = stateOperationFromKind(rawOperation);
        if (operation.operation !== "unknown") {
            step.metadata["state.operation"] = operation.operation;
        }
        else {
            step.metadata["state.operation"] = "unknown";
            step.metadata["state.operation_raw"] = operation.raw;
        }
    }
    const input = objectValue(step.input);
    const output = objectValue(step.output);
    for (const [source, key] of [
        [input, "scope"],
        [input, "key"],
        [input, "before_hash"],
        [output, "after_hash"]
    ]) {
        if (source?.[key] !== undefined && step.metadata[key === "scope" || key === "key" ? `state.${key}` : key] === undefined) {
            step.metadata[key === "scope" || key === "key" ? `state.${key}` : key] = source[key];
        }
    }
}
function stateOperationFromKind(kind) {
    const raw = kind.split(".").at(-1) ?? null;
    if (raw && isKnownStateOperation(raw)) {
        return { operation: raw, raw };
    }
    return { operation: "unknown", raw };
}
function isKnownStateOperation(value) {
    return ["read", "write", "snapshot", "delete", "update", "list", "keys", "scan", "touch", "expire", "clear", "get", "set", "unknown"].includes(value);
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
//# sourceMappingURL=normalizer.js.map
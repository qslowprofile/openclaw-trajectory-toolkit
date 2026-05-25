import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { ArtifactStore, redactJson, stableStringify } from "./artifact-store.js";
import { canonicalCorrelationId, newEventId, newRunId, newSpanId, newStepId, newTraceId } from "./ids.js";
export class TrajectoryRecorder {
    baseDir;
    runDir;
    runId;
    traceId;
    rootSpanId;
    sessionId;
    startedAt;
    input;
    metadata;
    artifactStore;
    stepCounter = 0;
    appendQueue = Promise.resolve();
    appendFailure = null;
    lastEventAt;
    lastHeartbeatWriteAt = 0;
    eventsWritten = 0;
    artifactsWritten = 0;
    artifactBytesWritten = 0;
    metaTraceRecorder;
    constructor(baseDir, runDir, runId, traceId, rootSpanId, sessionId, startedAt, input, metadata, artifactStoreOptions = {}) {
        this.baseDir = baseDir;
        this.runDir = runDir;
        this.runId = runId;
        this.traceId = traceId;
        this.rootSpanId = rootSpanId;
        this.sessionId = sessionId;
        this.startedAt = startedAt;
        this.input = input;
        this.metadata = metadata;
        this.metaTraceRecorder = {
            record: async (options) => this.record(options)
        };
        this.artifactStore = new ArtifactStore(join(runDir, "artifacts"), {
            ...artifactStoreOptions,
            metaRecorder: artifactStoreOptions.metaRecorder ?? this.metaTraceRecorder
        });
        this.lastEventAt = startedAt;
    }
    static async start(options) {
        const runId = options.runId ?? newRunId();
        if (!isValidGeneratedId(runId, "run")) {
            throw new Error(`Invalid runId: ${runId}`);
        }
        const traceId = options.traceId ?? newTraceId();
        const rootSpanId = newSpanId();
        const runDir = join(options.baseDir, "runs", runId);
        const startedAt = new Date().toISOString();
        const recorder = new TrajectoryRecorder(options.baseDir, runDir, runId, traceId, rootSpanId, options.sessionId ?? null, startedAt, options.input, redactRecord({
            ...(options.metadata ?? {}),
            ...(options.sessionId ? { "openclaw.session_id": options.sessionId } : {}),
            ...(options.sessionKey ? { "openclaw.session_key": options.sessionKey } : {}),
            ...(options.rootSessionId ? { "openclaw.root_session_id": options.rootSessionId } : {}),
            ...(options.parentSessionId ? { "openclaw.parent_session_id": options.parentSessionId } : {}),
            ...(options.agentId ? { "openclaw.agent_id": options.agentId } : {}),
            ...(options.agentName ? { "openclaw.agent_name": options.agentName, "agent.name": options.agentName } : {})
        }), options.artifactStore ?? {});
        await mkdir(runDir, { recursive: true });
        await mkdir(join(runDir, "artifacts"), { recursive: true });
        await mkdir(join(runDir, "state"), { recursive: true });
        await mkdir(join(runDir, "state", "snapshots"), { recursive: true });
        await writeFile(join(runDir, "events.jsonl"), "", "utf8");
        await recorder.writePidFile();
        await recorder.writeRunFile({ output: null, status: "running", ended_at: null });
        await recorder.writeConfigSnapshot();
        await recorder.writeEnvironmentSnapshot();
        await recorder.appendEvent({
            schema_version: "openclaw.event/v1",
            event_id: newEventId(),
            timestamp: startedAt,
            phase: "start",
            kind: "openclaw.request",
            actor: "runtime",
            status: "running",
            ids: {
                trace_id: traceId,
                span_id: rootSpanId,
                parent_span_id: null,
                run_id: runId,
                session_id: options.sessionId ?? null,
                turn_id: null,
                step_id: null
            },
            attrs: {
                ...recorder.metadata,
                "openclaw.run_id": runId
            },
            input_ref: null,
            output_ref: null,
            error: null
        });
        return recorder;
    }
    async record(options) {
        this.assertWritable();
        options = canonicalizeRecordEventOptions(options);
        validateRecordEventOptions(options);
        try {
            const safeKind = sanitizePathPart(options.kind);
            const inputArtifact = options.input === undefined
                ? null
                : await this.artifactStore.writeJson(`${safeKind}_inputs`, options.input, artifactMetadataForEvent(options));
            const outputArtifact = options.output === undefined
                ? null
                : await this.artifactStore.writeJson(`${safeKind}_outputs`, options.output, artifactMetadataForEvent(options));
            for (const artifact of [inputArtifact, outputArtifact]) {
                if (!artifact)
                    continue;
                this.artifactsWritten += 1;
                this.artifactBytesWritten += artifact.size_bytes;
            }
            const timestampGenerated = options.timestamp === undefined;
            const spanIdGenerated = options.span_id === undefined;
            const stepIdGenerated = options.step_id === undefined;
            const redactedAttrs = redactAttrs(options.attrs ?? {});
            const attrs = {
                ...redactedAttrs.value,
                ...(this.sessionId ? { "openclaw.session_id": this.sessionId } : {}),
                ...(options.session_id ? { "openclaw.event_session_id": options.session_id } : {}),
                ...(options.session_key ? { "openclaw.session_key": options.session_key } : {}),
                ...(options.agent_id ? { "openclaw.agent_id": options.agent_id } : {}),
                ...(options.agent_name ? { "openclaw.agent_name": options.agent_name, "agent.name": options.agent_name } : {}),
                ...(options.invoked_by ? { "openclaw.invoked_by": options.invoked_by } : {}),
                ...(options.message_id ? { "openclaw.message_id": options.message_id } : {}),
                ...(timestampGenerated ? { "openclaw.timestamp.generated": true } : {}),
                ...(spanIdGenerated ? { "openclaw.span_id.generated": true } : {}),
                ...(stepIdGenerated ? { "openclaw.step_id.generated": true } : {}),
                ...(redactedAttrs.redactedKeys.length > 0 ? { "openclaw.redacted_attr_keys": redactedAttrs.redactedKeys } : {})
            };
            const event = {
                schema_version: "openclaw.event/v1",
                event_id: newEventId(),
                timestamp: options.timestamp ?? new Date().toISOString(),
                phase: options.phase,
                kind: options.kind,
                actor: options.actor,
                status: options.status,
                ids: {
                    trace_id: this.traceId,
                    span_id: options.span_id ?? newSpanId(),
                    parent_span_id: options.parent_span_id ?? this.rootSpanId,
                    run_id: this.runId,
                    session_id: options.session_id ?? this.sessionId,
                    turn_id: options.turn_id ?? null,
                    step_id: options.step_id ?? newStepId(++this.stepCounter, this.rootSpanId.slice(0, 6)),
                    tool_call_id: options.tool_call_id ?? null,
                    skill_invocation_id: options.skill_invocation_id ?? null,
                    artifact_id: outputArtifact?.artifact_id ?? inputArtifact?.artifact_id ?? null
                },
                attrs,
                input_ref: inputArtifact?.uri ?? null,
                output_ref: outputArtifact?.uri ?? null,
                error: options.error ?? null
            };
            await this.appendEvent(event);
            return event;
        }
        catch (error) {
            this.appendFailure ??= error;
            throw error;
        }
    }
    async finalize(options) {
        this.assertWritable();
        const endedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(this.startedAt));
        const outputArtifact = await this.artifactStore.writeJson("root_outputs", options.output);
        this.artifactsWritten += 1;
        this.artifactBytesWritten += outputArtifact.size_bytes;
        const event = {
            schema_version: "openclaw.event/v1",
            event_id: newEventId(),
            timestamp: endedAt,
            phase: "end",
            kind: "openclaw.request",
            actor: "runtime",
            status: options.status,
            ids: {
                trace_id: this.traceId,
                span_id: this.rootSpanId,
                parent_span_id: null,
                run_id: this.runId,
                session_id: this.sessionId,
                turn_id: null,
                step_id: null,
                artifact_id: outputArtifact.artifact_id
            },
            attrs: {
                ...this.metadata,
                duration_ms: durationMs,
                "openclaw.run_id": this.runId
            },
            input_ref: null,
            output_ref: outputArtifact.uri,
            error: options.error ?? null
        };
        await this.appendEvent(event, {
            forceRunWrite: true,
            runExtra: { output: options.output, status: options.status, ended_at: endedAt }
        });
        await this.releasePidFile();
        return event;
    }
    async releasePidFile() {
        await rm(join(this.runDir, "run.pid.json"), { force: true }).catch(() => undefined);
    }
    health() {
        return {
            writable: this.appendFailure === null,
            append_failed: this.appendFailure !== null,
            error: this.appendFailure ? errorMessage(this.appendFailure) : null,
            last_event_at: this.lastEventAt
        };
    }
    async stats() {
        return {
            events_written: this.eventsWritten,
            artifacts_written: this.artifactsWritten,
            artifact_bytes: this.artifactBytesWritten,
            run_dir_bytes: await dirBytes(this.runDir)
        };
    }
    async recover(options = {}) {
        if (options.verifyTail ?? true) {
            const raw = await readFile(join(this.runDir, "events.jsonl"), "utf8");
            const lastLine = raw
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .at(-1);
            if (lastLine) {
                JSON.parse(lastLine);
            }
        }
        this.appendFailure = null;
        this.appendQueue = Promise.resolve();
    }
    static async recoverRunDir(runDir, options = {}) {
        let verifiedTail = false;
        if (options.verifyTail ?? true) {
            await verifyJsonlTail(join(runDir, "events.jsonl"));
            verifiedTail = true;
        }
        const repairedRunJson = await repairRunJsonFromEvents(runDir);
        await rm(join(runDir, "run.pid.json"), { force: true }).catch(() => undefined);
        return { verified_tail: verifiedTail, repaired_run_json: repairedRunJson };
    }
    async appendEvent(event, options = {}) {
        this.assertWritable();
        const write = this.appendQueue.then(async () => {
            await appendFile(join(this.runDir, "events.jsonl"), `${stableStringify(event)}\n`, "utf8");
            this.lastEventAt = event.timestamp;
            this.eventsWritten += 1;
            const now = Date.now();
            if (options.forceRunWrite) {
                await this.writeRunFile(options.runExtra ?? {});
                this.lastHeartbeatWriteAt = now;
                return;
            }
            if (now - this.lastHeartbeatWriteAt >= 500) {
                await this.writeRunHeartbeat(event.timestamp);
                this.lastHeartbeatWriteAt = now;
            }
        });
        this.appendQueue = write.catch((error) => {
            this.appendFailure ??= error;
        });
        try {
            await write;
        }
        catch (error) {
            this.appendFailure ??= error;
            throw error;
        }
    }
    assertWritable() {
        if (this.appendFailure) {
            throw new Error(`Recorder previous append failed; refusing to write more events: ${errorMessage(this.appendFailure)}`);
        }
    }
    async writeRunFile(extra) {
        const run = {
            schema_version: "openclaw.run/v1",
            run_id: this.runId,
            trace_id: this.traceId,
            root_span_id: this.rootSpanId,
            session_id: this.sessionId,
            session_key: stringOrNull(this.metadata["openclaw.session_key"]),
            root_session_id: stringOrNull(this.metadata["openclaw.root_session_id"]),
            parent_session_id: stringOrNull(this.metadata["openclaw.parent_session_id"]),
            agent_id: stringOrNull(this.metadata["openclaw.agent_id"]),
            agent_name: stringOrNull(this.metadata["openclaw.agent_name"] ?? this.metadata["agent.name"]),
            input: this.input,
            started_at: this.startedAt,
            last_event_at: this.lastEventAt,
            metadata: this.metadata,
            ...extra
        };
        await withRunFileLock(this.runDir, () => atomicWriteFile(join(this.runDir, "run.json"), `${stableStringify(run)}\n`));
    }
    async writeRunHeartbeat(lastEventAt) {
        const runPath = join(this.runDir, "run.json");
        await withRunFileLock(this.runDir, async () => {
            const run = JSON.parse(await readFile(runPath, "utf8"));
            await atomicWriteFile(runPath, `${stableStringify({ ...run, last_event_at: lastEventAt })}\n`);
        });
    }
    async writePidFile() {
        await atomicWriteFile(join(this.runDir, "run.pid.json"), `${stableStringify({
            schema_version: "openclaw.run-pid/v1",
            pid: process.pid,
            hostname: hostname(),
            started_at: this.startedAt,
            run_id: this.runId
        })}\n`);
    }
    async writeConfigSnapshot() {
        const snapshot = {
            schema_version: "openclaw.config-snapshot/v1",
            captured_at: new Date().toISOString(),
            trajectory: {
                mode: "capture",
                local_dir: this.baseDir
            }
        };
        await atomicWriteFile(join(this.runDir, "config.snapshot.json"), `${stableStringify(snapshot)}\n`);
    }
    async writeEnvironmentSnapshot() {
        const snapshot = {
            schema_version: "openclaw.environment-snapshot/v1",
            captured_at: new Date().toISOString(),
            toolkit: {
                name: "openclaw-trajectory-toolkit",
                version: await readPackageVersion()
            },
            node: {
                version: process.version,
                platform: process.platform,
                arch: process.arch
            },
            process: {
                pid: process.pid,
                cwd: process.cwd(),
                hostname: hostname()
            },
            openclaw: {
                version: process.env.OPENCLAW_VERSION ?? null,
                instance_id: process.env.OPENCLAW_INSTANCE_ID ?? null
            }
        };
        await atomicWriteFile(join(this.runDir, "environment.snapshot.json"), `${stableStringify(snapshot)}\n`);
    }
}
export async function finalizeRunDirectory(runDir, options) {
    const runPath = join(runDir, "run.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    if (basename(runDir) !== run.run_id) {
        throw new Error(`Run directory basename ${basename(runDir)} does not match run_id ${run.run_id}.`);
    }
    if (run.status !== "running") {
        throw new Error(`Run already finalized with status ${run.status}. Use a new run directory for another capture.`);
    }
    const artifactStore = new ArtifactStore(join(runDir, "artifacts"), options.artifactStore ?? {});
    const endedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(run.started_at));
    const outputArtifact = await artifactStore.writeJson("root_outputs", options.output);
    const metadata = redactRecord(run.metadata ?? {});
    const event = {
        schema_version: "openclaw.event/v1",
        event_id: newEventId(),
        timestamp: endedAt,
        phase: "end",
        kind: "openclaw.request",
        actor: "runtime",
        status: options.status,
        ids: {
            trace_id: run.trace_id,
            span_id: run.root_span_id,
            parent_span_id: null,
            run_id: run.run_id,
            session_id: run.session_id ?? null,
            turn_id: null,
            step_id: null,
            artifact_id: outputArtifact.artifact_id
        },
        attrs: {
            ...metadata,
            duration_ms: durationMs,
            "openclaw.run_id": run.run_id
        },
        input_ref: null,
        output_ref: outputArtifact.uri,
        error: options.error ?? null
    };
    const nextRun = {
        ...run,
        output: options.output,
        status: options.status,
        ended_at: endedAt,
        last_event_at: endedAt
    };
    const endingRun = {
        ...run,
        status: "ending",
        pending_final_status: options.status,
        pending_ended_at: endedAt,
        pending_output: options.output,
        last_event_at: endedAt
    };
    await withRunFileLock(runDir, () => atomicWriteFile(runPath, `${stableStringify(endingRun)}\n`));
    await appendFile(join(runDir, "events.jsonl"), `${stableStringify(event)}\n`, "utf8");
    await withRunFileLock(runDir, () => atomicWriteFile(runPath, `${stableStringify(nextRun)}\n`));
    await rm(join(runDir, "run.pid.json"), { force: true }).catch(() => undefined);
    return event;
}
export async function appendRunDirectoryEvent(runDir, options, config = {}) {
    options = canonicalizeRecordEventOptions(options);
    validateRecordEventOptions(options);
    const runPath = join(runDir, "run.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    if (basename(runDir) !== run.run_id) {
        throw new Error(`Run directory basename ${basename(runDir)} does not match run_id ${run.run_id}.`);
    }
    if (run.status !== "running") {
        throw new Error(`Run already finalized with status ${run.status}. Use a new run directory for another capture.`);
    }
    const artifactStore = new ArtifactStore(join(runDir, "artifacts"), config.artifactStore ?? {});
    const safeKind = sanitizePathPart(options.kind);
    const inputArtifact = options.input === undefined
        ? null
        : await artifactStore.writeJson(`${safeKind}_inputs`, options.input, artifactMetadataForEvent(options));
    const outputArtifact = options.output === undefined
        ? null
        : await artifactStore.writeJson(`${safeKind}_outputs`, options.output, artifactMetadataForEvent(options));
    const timestampGenerated = options.timestamp === undefined;
    const spanIdGenerated = options.span_id === undefined;
    const stepIdGenerated = options.step_id === undefined;
    const redactedAttrs = redactAttrs(options.attrs ?? {});
    const attrs = {
        ...redactedAttrs.value,
        ...(run.session_id ? { "openclaw.session_id": run.session_id } : {}),
        ...(options.session_id ? { "openclaw.event_session_id": options.session_id } : {}),
        ...(options.session_key ?? run.session_key ? { "openclaw.session_key": options.session_key ?? run.session_key } : {}),
        ...(options.agent_id ? { "openclaw.agent_id": options.agent_id } : {}),
        ...(options.agent_name ? { "openclaw.agent_name": options.agent_name, "agent.name": options.agent_name } : {}),
        ...(options.invoked_by ? { "openclaw.invoked_by": options.invoked_by } : {}),
        ...(options.message_id ? { "openclaw.message_id": options.message_id } : {}),
        ...(timestampGenerated ? { "openclaw.timestamp.generated": true } : {}),
        ...(spanIdGenerated ? { "openclaw.span_id.generated": true } : {}),
        ...(stepIdGenerated ? { "openclaw.step_id.generated": true } : {}),
        ...(redactedAttrs.redactedKeys.length > 0 ? { "openclaw.redacted_attr_keys": redactedAttrs.redactedKeys } : {})
    };
    const event = {
        schema_version: "openclaw.event/v1",
        event_id: newEventId(),
        timestamp: options.timestamp ?? new Date().toISOString(),
        phase: options.phase,
        kind: options.kind,
        actor: options.actor,
        status: options.status,
        ids: {
            trace_id: run.trace_id,
            span_id: options.span_id ?? newSpanId(),
            parent_span_id: options.parent_span_id ?? run.root_span_id,
            run_id: run.run_id,
            session_id: options.session_id ?? run.session_id ?? null,
            turn_id: options.turn_id ?? null,
            step_id: options.step_id ?? newStepId(Date.now(), run.root_span_id.slice(0, 6)),
            tool_call_id: options.tool_call_id ?? null,
            skill_invocation_id: options.skill_invocation_id ?? null,
            artifact_id: outputArtifact?.artifact_id ?? inputArtifact?.artifact_id ?? null
        },
        attrs,
        input_ref: inputArtifact?.uri ?? null,
        output_ref: outputArtifact?.uri ?? null,
        error: options.error ?? null
    };
    await appendFile(join(runDir, "events.jsonl"), `${stableStringify(event)}\n`, "utf8");
    await withRunFileLock(runDir, async () => {
        const currentRun = JSON.parse(await readFile(runPath, "utf8"));
        await atomicWriteFile(runPath, `${stableStringify({ ...currentRun, last_event_at: event.timestamp })}\n`);
    });
    return event;
}
function sanitizePathPart(value) {
    const sanitized = value.replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : "event";
}
function canonicalizeRecordEventOptions(options) {
    const next = { ...options };
    const attrs = { ...(options.attrs ?? {}) };
    let changed = false;
    for (const key of ["span_id", "step_id", "tool_call_id", "skill_invocation_id", "turn_id"]) {
        const value = next[key];
        if (typeof value !== "string" || value.length === 0)
            continue;
        const canonical = canonicalCorrelationId(key, value);
        if (!canonical.changed)
            continue;
        next[key] = canonical.id;
        if (attrs[canonical.metadataKey] === undefined) {
            attrs[canonical.metadataKey] = canonical.raw;
        }
        changed = true;
    }
    if (changed || options.attrs) {
        next.attrs = attrs;
    }
    return next;
}
function isValidGeneratedId(value, prefix) {
    return new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);
}
const validActors = new Set(["runtime", "agent", "model", "skill", "tool", "mcp", "file", "shell", "state", "artifact", "evaluator"]);
const validPhases = new Set(["start", "end", "event"]);
const validStatuses = new Set(["ok", "error", "cancelled", "timeout", "running"]);
function validateRecordEventOptions(options) {
    if (!validActors.has(options.actor)) {
        throw new Error(`Invalid event actor: ${options.actor}`);
    }
    if (!validPhases.has(options.phase)) {
        throw new Error(`Invalid event phase: ${options.phase}`);
    }
    if (!validStatuses.has(options.status)) {
        throw new Error(`Invalid event status: ${options.status}`);
    }
}
function artifactMetadataForEvent(options) {
    const metaTrace = options.attrs?.["openclaw.meta_trace"] === true;
    return {
        source_kind: options.kind,
        ...(metaTrace ? { "openclaw.summary.skip": true } : {})
    };
}
function redactAttrs(attrs) {
    const redacted = redactJson(attrs);
    return {
        value: redacted.value && typeof redacted.value === "object" && !Array.isArray(redacted.value) ? redacted.value : {},
        redactedKeys: redacted.redactedKeys
    };
}
function redactRecord(value) {
    return redactAttrs(value).value;
}
async function atomicWriteFile(path, content) {
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    const parent = dirname(path);
    await assertSafeDirectory(parent);
    const handle = await open(tmpPath, "wx");
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await assertSafeDirectory(parent);
    await rename(tmpPath, path);
    const dirHandle = await open(parent, "r");
    try {
        await dirHandle.sync();
    }
    finally {
        await dirHandle.close();
    }
}
async function withRunFileLock(runDir, fn) {
    const lockDir = join(runDir, ".run-json.lock");
    const started = Date.now();
    while (true) {
        try {
            await mkdir(lockDir);
            break;
        }
        catch (error) {
            if (!isFileExistsError(error) || Date.now() - started > 5_000) {
                throw error;
            }
            await sleep(25);
        }
    }
    try {
        return await fn();
    }
    finally {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
async function assertSafeDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Unsafe directory for atomic write: ${path}`);
    }
}
function isFileExistsError(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function verifyJsonlTail(path) {
    const raw = await readFile(path, "utf8");
    const lastLine = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
    if (lastLine) {
        JSON.parse(lastLine);
    }
}
async function repairRunJsonFromEvents(runDir) {
    const runPath = join(runDir, "run.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    const cleanRun = withoutPendingFinalizeFields(run);
    if (run.status !== "running" && run.status !== "ending") {
        return false;
    }
    const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8");
    const events = eventsRaw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    const rootEnd = [...events]
        .reverse()
        .find((event) => event.kind === "openclaw.request" &&
        event.phase === "end" &&
        event.ids.run_id === run.run_id &&
        event.ids.span_id === run.root_span_id);
    if (!rootEnd) {
        if (run.status === "ending") {
            await withRunFileLock(runDir, () => atomicWriteFile(runPath, `${stableStringify({
                ...cleanRun,
                status: "running",
                ended_at: null,
                metadata: {
                    ...(objectRecord(run.metadata) ?? {}),
                    recovered_incomplete_finalize: true
                }
            })}\n`));
            return true;
        }
        return false;
    }
    let output = run.output ?? null;
    if (rootEnd.output_ref) {
        output = await new ArtifactStore(join(runDir, "artifacts")).readJson(rootEnd.output_ref).catch(() => output);
    }
    await withRunFileLock(runDir, () => atomicWriteFile(runPath, `${stableStringify({
        ...cleanRun,
        output,
        status: rootEnd.status,
        ended_at: rootEnd.timestamp,
        last_event_at: rootEnd.timestamp,
        metadata: {
            ...(objectRecord(run.metadata) ?? {}),
            recovered_from_events: true
        }
    })}\n`));
    return true;
}
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringOrNull(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function withoutPendingFinalizeFields(run) {
    const { pending_final_status: _pendingFinalStatus, pending_ended_at: _pendingEndedAt, pending_output: _pendingOutput, ...cleanRun } = run;
    return cleanRun;
}
async function dirBytes(path) {
    const info = await lstat(path).catch(() => null);
    if (!info)
        return 0;
    if (!info.isDirectory())
        return info.size;
    let total = 0;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const child = join(path, entry.name);
        const childInfo = await lstat(child).catch(() => null);
        if (!childInfo)
            continue;
        if (childInfo.isDirectory()) {
            total += await dirBytes(child);
        }
        else {
            total += childInfo.size;
        }
    }
    return total;
}
async function readPackageVersion() {
    try {
        const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        return pkg.version ?? null;
    }
    catch {
        return null;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=recorder.js.map
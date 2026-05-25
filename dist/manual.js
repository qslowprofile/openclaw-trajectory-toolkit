import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendRunDirectoryEvent, finalizeRunDirectory, TrajectoryRecorder } from "./recorder.js";
import { parseDuration, stableStringify } from "./utils.js";
export function activeRecordingPath(baseDir) {
    return join(baseDir, "active-recording.json");
}
export function activeSessionRecordingPath(baseDir, sessionId) {
    return join(baseDir, "active", `${safeSessionFilePart(sessionId)}.json`);
}
function activeRecordingFilePath(active) {
    return active.session_id ? activeSessionRecordingPath(active.base_dir, active.session_id) : activeRecordingPath(active.base_dir);
}
function safeSessionFilePart(sessionId) {
    const safe = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/^_+|_+$/g, "");
    return safe || "session";
}
function normalizeActiveRecording(active, baseDir) {
    return {
        ...active,
        base_dir: active.base_dir ?? baseDir,
        session_id: active.session_id ?? null,
        session_key: active.session_key ?? null,
        agent_id: active.agent_id ?? null,
        agent_name: active.agent_name ?? null
    };
}
function activeRecordingLabel(active) {
    return active.session_id ? `session ${active.session_id}` : `run ${active.run_id}`;
}
function openClawIdentityMetadata(options) {
    return {
        ...(options.sessionId ? { "openclaw.session_id": options.sessionId } : {}),
        ...(options.sessionKey ? { "openclaw.session_key": options.sessionKey } : {}),
        ...(options.agentId ? { "openclaw.agent_id": options.agentId } : {}),
        ...(options.agentName ? { "openclaw.agent_name": options.agentName } : {})
    };
}
function activeIdentityAttrs(active) {
    return openClawIdentityMetadata({
        sessionId: active.session_id,
        sessionKey: active.session_key,
        agentId: active.agent_id,
        agentName: active.agent_name
    });
}
export async function startManualRecording(options) {
    await mkdir(options.baseDir, { recursive: true });
    if (options.sessionId) {
        await mkdir(join(options.baseDir, "active"), { recursive: true });
    }
    if (!options.force) {
        const existing = await readActiveManualRecording(options.baseDir, options.sessionId ?? null).catch(() => null);
        if (existing) {
            throw new Error(`Manual recording is already active for ${activeRecordingLabel(existing)}. Stop it before starting another one.`);
        }
    }
    const identityMetadata = openClawIdentityMetadata({
        sessionId: options.sessionId ?? null,
        sessionKey: options.sessionKey ?? null,
        agentId: options.agentId ?? null,
        agentName: options.agentName ?? null
    });
    const recorder = await TrajectoryRecorder.start({
        baseDir: options.baseDir,
        input: options.input,
        metadata: {
            source: "manual-recording",
            "recording.mode": "live_manual",
            "recording.fidelity": "low",
            "recording.confidence": "low",
            "evidence.source": "manual_note",
            ...identityMetadata,
            ...(options.trigger ? { "recording.trigger": options.trigger } : {}),
            ...(options.agentName ? { "agent.name": options.agentName } : {})
        },
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.artifactStore ? { artifactStore: options.artifactStore } : {})
    });
    await recorder.releasePidFile();
    const now = new Date().toISOString();
    const active = {
        schema_version: "openclaw.active-recording/v1",
        run_id: recorder.runId,
        run_dir: recorder.runDir,
        base_dir: options.baseDir,
        mode: "live_manual",
        session_id: options.sessionId ?? null,
        session_key: options.sessionKey ?? null,
        agent_id: options.agentId ?? null,
        agent_name: options.agentName ?? null,
        input: options.input,
        started_at: now,
        updated_at: now,
        note_count: 0,
        trigger: options.trigger ?? null
    };
    await writeActiveManualRecording(active);
    return active;
}
export async function appendManualStructuredEvent(options) {
    const active = await readActiveManualRecording(options.baseDir, options.sessionId ?? null);
    const event = structuredInputToRecordEvent(options.value, {
        defaultStepId: nextManualStepId(active),
        defaultAgentName: active.agent_name ?? "manual",
        extraAttrs: {
            "recording.mode": active.mode,
            "recording.source": "structured-event",
            "recording.fidelity": "medium",
            "evidence.source": "structured_event",
            ...activeIdentityAttrs(active)
        }
    });
    const recorded = await appendRunDirectoryEvent(active.run_dir, event, options.artifactStore ? { artifactStore: options.artifactStore } : {});
    const nextActive = {
        ...active,
        updated_at: recorded.timestamp,
        note_count: active.note_count + 1
    };
    await writeActiveManualRecording(nextActive);
    return { active: nextActive, event: recorded, event_type: manualTypeForRecordEvent(event) };
}
export async function readActiveManualRecording(baseDir, sessionId = null) {
    if (sessionId) {
        return JSON.parse(await readFile(activeSessionRecordingPath(baseDir, sessionId), "utf8"));
    }
    const global = await readFile(activeRecordingPath(baseDir), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(async (error) => {
        const activeDir = join(baseDir, "active");
        const entries = await readdir(activeDir).catch(() => []);
        const jsonEntries = entries.filter((entry) => entry.endsWith(".json"));
        if (jsonEntries.length === 1 && jsonEntries[0]) {
            return JSON.parse(await readFile(join(activeDir, jsonEntries[0]), "utf8"));
        }
        if (jsonEntries.length > 1) {
            throw new Error("Multiple active session recordings exist. Provide --session-id.");
        }
        throw error;
    });
    return normalizeActiveRecording(global, baseDir);
}
export async function manualRecordingStatus(baseDir, sessionId = null) {
    const active = await readActiveManualRecording(baseDir, sessionId).catch(() => null);
    const path = sessionId ? activeSessionRecordingPath(baseDir, sessionId) : activeRecordingPath(baseDir);
    if (!active) {
        return { active: false, base_dir: baseDir, session_id: sessionId, active_path: path };
    }
    return {
        active: true,
        base_dir: baseDir,
        active_path: activeRecordingFilePath(active),
        run_id: active.run_id,
        run_dir: active.run_dir,
        session_id: active.session_id,
        session_key: active.session_key,
        agent_id: active.agent_id,
        agent_name: active.agent_name,
        mode: active.mode,
        started_at: active.started_at,
        updated_at: active.updated_at,
        note_count: active.note_count,
        trigger: active.trigger
    };
}
export async function appendManualNote(options) {
    const active = await readActiveManualRecording(options.baseDir, options.sessionId ?? null);
    const parsed = parseManualText(options.text);
    const noteType = normalizeManualType(options.type ?? parsed.fields.type ?? parsed.fields["类型"] ?? inferManualType(parsed, options.text));
    const status = normalizeManualStatus(options.status ?? parsed.fields.status ?? parsed.fields["状态"] ?? inferManualStatus(options.text));
    const stepId = normalizeStepId(options.stepId ?? parsed.fields.step_id ?? parsed.fields.step ?? parsed.fields["步骤"]) ?? nextManualStepId(active);
    const event = manualTextToRecordEvent({
        active,
        parsed,
        noteType,
        status,
        stepId,
        text: options.text,
        timestamp: options.timestamp ?? parsed.fields.timestamp ?? null,
        agentName: options.agentName
    });
    const recorded = await appendRunDirectoryEvent(active.run_dir, event, options.artifactStore ? { artifactStore: options.artifactStore } : {});
    const nextActive = {
        ...active,
        updated_at: recorded.timestamp,
        note_count: active.note_count + 1
    };
    await writeActiveManualRecording(nextActive);
    return { active: nextActive, event: recorded, note_type: noteType };
}
export async function stopManualRecording(options) {
    const active = await readActiveManualRecording(options.baseDir, options.sessionId ?? null);
    await finalizeRunDirectory(active.run_dir, {
        output: options.finalOutput,
        status: options.status,
        ...(options.artifactStore ? { artifactStore: options.artifactStore } : {})
    });
    await rm(activeRecordingFilePath(active), { force: true });
    return active;
}
export async function recoverManualRecording(options) {
    const active = await readActiveManualRecording(options.baseDir, options.sessionId ?? null).catch(() => null);
    if (!active)
        return null;
    await TrajectoryRecorder.recoverRunDir(active.run_dir, { verifyTail: true });
    const run = JSON.parse(await readFile(join(active.run_dir, "run.json"), "utf8"));
    if (run.status === "running") {
        await finalizeRunDirectory(active.run_dir, {
            output: options.finalOutput,
            status: options.status,
            ...(options.artifactStore ? { artifactStore: options.artifactStore } : {})
        });
    }
    await rm(activeRecordingFilePath(active), { force: true });
    return active;
}
export async function reconstructManualRecording(options) {
    const parsed = parseTranscript(options.transcript);
    const recorder = await TrajectoryRecorder.start({
        baseDir: options.baseDir,
        input: options.input ?? parsed.input,
        metadata: {
            source: "manual-reconstruct",
            "recording.mode": "reconstructed",
            "recording.fidelity": "low",
            "recording.confidence": "low",
            "evidence.source": "manual_transcript"
        },
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.artifactStore ? { artifactStore: options.artifactStore } : {})
    });
    for (let index = 0; index < parsed.steps.length; index += 1) {
        const step = parsed.steps[index];
        if (!step)
            continue;
        const parsedText = parseManualText(step.text);
        await recorder.record(manualTextToRecordEvent({
            active: {
                schema_version: "openclaw.active-recording/v1",
                run_id: recorder.runId,
                run_dir: recorder.runDir,
                base_dir: options.baseDir,
                mode: "live_manual",
                session_id: options.sessionId ?? null,
                session_key: null,
                agent_id: null,
                agent_name: null,
                input: options.input ?? parsed.input,
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                note_count: index,
                trigger: null
            },
            parsed: parsedText,
            noteType: step.type,
            status: step.status,
            stepId: step.stepId ?? `step_reconstructed_${String(index + 1).padStart(6, "0")}`,
            text: step.text,
            timestamp: null,
            agentName: null
        }));
    }
    await recorder.finalize({ output: options.finalOutput ?? parsed.finalOutput, status: "ok" });
    return { run_id: recorder.runId, run_dir: recorder.runDir, step_count: parsed.steps.length };
}
export async function reconstructSessionRecording(options) {
    const parsed = parseOpenClawSessionLog(options.sessionLog, {
        startTime: options.startTime ?? null,
        endTime: options.endTime ?? null,
        detectWindow: options.detectWindow !== false,
        excludeSelf: options.excludeSelf !== false
    });
    const sessionId = options.sessionId ?? parsed.sessionId;
    const finalOutput = options.finalOutput ?? parsed.finalOutput;
    const finalStatus = options.finalStatus ?? inferFinalStatus(finalOutput);
    const taskCompleted = options.taskCompleted ?? (finalStatus === "ok" ? null : false);
    const recorder = await TrajectoryRecorder.start({
        baseDir: options.baseDir,
        input: options.input ?? parsed.input,
        metadata: {
            source: "session-log-reconstruct",
            "recording.mode": "session_log_reconstruct",
            "recording.fidelity": "medium",
            "recording.confidence": "medium",
            "evidence.source": "openclaw_session_log",
            "reconstruction.start_time": parsed.report.time_window.start_time,
            "reconstruction.end_time": parsed.report.time_window.end_time,
            "reconstruction.window_source": parsed.report.time_window.source,
            "reconstruction.exclude_self": options.excludeSelf !== false,
            ...(taskCompleted !== null && taskCompleted !== undefined ? { "task.completed": taskCompleted } : {})
        },
        ...(sessionId ? { sessionId } : {}),
        ...(options.artifactStore ? { artifactStore: options.artifactStore } : {})
    });
    for (const event of parsed.events) {
        await recorder.record(event);
    }
    await recorder.finalize({ output: finalOutput, status: finalStatus });
    await writeFile(join(recorder.runDir, "reconstruction_report.json"), `${stableStringify(parsed.report)}\n`, "utf8");
    return { run_id: recorder.runId, run_dir: recorder.runDir, step_count: parsed.events.length };
}
function writeActiveManualRecording(active) {
    const path = activeRecordingFilePath(active);
    return mkdir(join(active.base_dir, "active"), { recursive: true })
        .catch(() => undefined)
        .then(() => writeFile(path, `${stableStringify(active)}\n`, "utf8"));
}
function parseManualText(text) {
    const fields = {};
    const sections = {};
    const body = [];
    let section = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        const sectionMatch = line.match(/^(输入|输出|错误|input|output|error)\s*[:：]\s*(.*)$/i);
        if (sectionMatch) {
            section = normalizeFieldKey(sectionMatch[1] ?? "");
            const rest = sectionMatch[2]?.trim();
            if (rest)
                sections[section] = appendSection(sections[section], rest);
            continue;
        }
        const fieldMatch = line.match(/^([A-Za-z0-9_.-]+|[\u4e00-\u9fa5]+)\s*[:：]\s*(.+)$/);
        if (fieldMatch && !section) {
            fields[normalizeFieldKey(fieldMatch[1] ?? "")] = (fieldMatch[2] ?? "").trim();
            continue;
        }
        if (fieldMatch && section && isKnownField(fieldMatch[1] ?? "")) {
            fields[normalizeFieldKey(fieldMatch[1] ?? "")] = (fieldMatch[2] ?? "").trim();
            continue;
        }
        if (section) {
            sections[section] = appendSection(sections[section], line);
        }
        else if (line.trim().length > 0) {
            body.push(line.trim());
        }
    }
    return { fields, sections: trimSections(sections), body: body.join("\n") };
}
function manualTextToRecordEvent(options) {
    const fields = options.parsed.fields;
    const durationMs = parseDurationField(fields.duration ?? fields["耗时"]);
    const agentName = options.agentName ?? fields.agent ?? fields["agent.name"] ?? fields["代理"] ?? "manual";
    const attrs = {
        "agent.name": agentName,
        "recording.mode": options.active.mode,
        "recording.source": "manual-note",
        ...activeIdentityAttrs(options.active),
        ...(durationMs !== null ? { duration_ms: durationMs } : {})
    };
    const inputText = options.parsed.sections.input ?? fields.input ?? null;
    const outputText = (options.parsed.sections.output ?? fields.output ?? options.parsed.body) || options.text;
    const errorText = options.parsed.sections.error ?? fields.error ?? null;
    const event = {
        kind: kindForManualType(options.noteType),
        actor: actorForManualType(options.noteType),
        phase: "end",
        status: options.status,
        step_id: options.stepId,
        attrs
    };
    if (options.timestamp)
        event.timestamp = options.timestamp;
    if (inputText)
        event.input = { text: inputText };
    if (outputText)
        event.output = { text: outputText };
    if (options.status !== "ok" && errorText)
        event.error = { message: errorText };
    enrichEventByType(event, options.noteType, fields, outputText);
    return event;
}
export function structuredInputToRecordEvent(value, options = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Structured event must be a JSON object.");
    }
    const data = value;
    const type = normalizeManualType(stringValue(data.type ?? data.step_type ?? data.actor ?? data.kind) ?? "state");
    const attrs = recordValue(data.attrs) ?? {};
    const nextAttrs = {
        "agent.name": stringValue(data.agent ?? data.agent_name ?? attrs["agent.name"]) ?? options.defaultAgentName ?? "manual",
        ...options.extraAttrs,
        ...attrs
    };
    const sessionId = stringValue(data.session_id ?? data.sessionId ?? attrs["openclaw.session_id"]);
    if (sessionId)
        nextAttrs["openclaw.session_id"] = sessionId;
    const sessionKey = stringValue(data.session_key ?? data.sessionKey ?? attrs["openclaw.session_key"]);
    if (sessionKey)
        nextAttrs["openclaw.session_key"] = sessionKey;
    const agentId = stringValue(data.agent_id ?? data.agentId ?? attrs["openclaw.agent_id"]);
    if (agentId)
        nextAttrs["openclaw.agent_id"] = agentId;
    const agentName = stringValue(data.agent_name ?? data.agentName ?? attrs["openclaw.agent_name"]);
    if (agentName) {
        nextAttrs["openclaw.agent_name"] = agentName;
        nextAttrs["agent.name"] = agentName;
    }
    const invokedBy = stringValue(data.invoked_by ?? data.invokedBy ?? attrs["openclaw.invoked_by"]);
    if (invokedBy)
        nextAttrs["openclaw.invoked_by"] = invokedBy;
    const messageId = stringValue(data.message_id ?? data.messageId ?? attrs["openclaw.message_id"]);
    if (messageId)
        nextAttrs["openclaw.message_id"] = messageId;
    for (const [sourceKey, targetKey] of [
        ["background_job_id", "openclaw.background_job_id"],
        ["backgroundJobId", "openclaw.background_job_id"],
        ["poll_target_job_id", "openclaw.poll_target_job_id"],
        ["pollTargetJobId", "openclaw.poll_target_job_id"],
        ["delegated_to_session_id", "openclaw.delegated_to_session_id"],
        ["delegatedToSessionId", "openclaw.delegated_to_session_id"],
        ["child_session_id", "openclaw.child_session_id"],
        ["childSessionId", "openclaw.child_session_id"],
        ["child_agent_id", "openclaw.child_agent_id"],
        ["childAgentId", "openclaw.child_agent_id"]
    ]) {
        const value = stringValue(data[sourceKey] ?? attrs[targetKey]);
        if (value)
            nextAttrs[targetKey] = value;
    }
    const durationMs = numberValue(data.duration_ms ?? data.durationMs ?? attrs.duration_ms);
    if (durationMs !== null)
        nextAttrs.duration_ms = durationMs;
    enrichStructuredAttrs(type, data, nextAttrs);
    const status = normalizeManualStatus(stringValue(data.status) ?? "ok");
    const kind = stringValue(data.kind) ?? kindForManualType(type);
    const actor = (stringValue(data.actor) ?? actorForManualType(type));
    const event = {
        kind,
        actor,
        phase: (stringValue(data.phase) ?? "end"),
        status,
        attrs: nextAttrs,
        ...(normalizeStepId(stringValue(data.step_id ?? data.stepId)) ?? options.defaultStepId
            ? { step_id: normalizeStepId(stringValue(data.step_id ?? data.stepId)) ?? options.defaultStepId }
            : {}),
        ...(stringValue(data.span_id ?? data.spanId) ? { span_id: stringValue(data.span_id ?? data.spanId) } : {}),
        ...(stringValue(data.parent_span_id ?? data.parentSpanId) ? { parent_span_id: stringValue(data.parent_span_id ?? data.parentSpanId) } : {}),
        ...(stringValue(data.tool_call_id ?? data.toolCallId) ? { tool_call_id: stringValue(data.tool_call_id ?? data.toolCallId) } : {}),
        ...(stringValue(data.skill_invocation_id ?? data.skillInvocationId)
            ? { skill_invocation_id: stringValue(data.skill_invocation_id ?? data.skillInvocationId) }
            : {}),
        ...(stringValue(data.turn_id ?? data.turnId) ? { turn_id: stringValue(data.turn_id ?? data.turnId) } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(sessionKey ? { session_key: sessionKey } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
        ...(agentName ? { agent_name: agentName } : {}),
        ...(invokedBy ? { invoked_by: invokedBy } : {}),
        ...(messageId ? { message_id: messageId } : {}),
        ...(stringValue(data.timestamp) ? { timestamp: stringValue(data.timestamp) } : {}),
        ...(data.input !== undefined ? { input: data.input } : {}),
        ...(data.output !== undefined ? { output: data.output } : {}),
        ...(errorValue(data.error) ? { error: errorValue(data.error) } : {})
    };
    if (event.input === undefined && type === "shell" && typeof nextAttrs.command === "string") {
        event.input = { command: nextAttrs.command };
    }
    if (event.output === undefined && data.result !== undefined) {
        event.output = data.result;
    }
    return event;
}
function enrichStructuredAttrs(type, data, attrs) {
    if (type === "tool") {
        const name = stringValue(data.tool_name ?? data.toolName ?? data.tool ?? data.name);
        if (name)
            attrs["tool.name"] = name;
        const namespace = stringValue(data.tool_namespace ?? data.namespace);
        if (namespace)
            attrs["tool.namespace"] = namespace;
    }
    else if (type === "model") {
        const model = stringValue(data.model ?? data.model_name ?? data.modelName);
        if (model)
            attrs["gen_ai.request.model"] = model;
        const provider = stringValue(data.provider);
        if (provider)
            attrs["gen_ai.system"] = provider;
        const usage = recordValue(data.usage);
        const inputTokens = numberValue(data.input_tokens ?? data.inputTokens ?? usage?.input_tokens ?? usage?.inputTokens ?? usage?.input ?? usage?.prompt_tokens ?? usage?.promptTokens);
        const outputTokens = numberValue(data.output_tokens ?? data.outputTokens ?? usage?.output_tokens ?? usage?.outputTokens ?? usage?.output ?? usage?.completion_tokens ?? usage?.completionTokens);
        if (inputTokens !== null)
            attrs["gen_ai.usage.input_tokens"] = inputTokens;
        if (outputTokens !== null)
            attrs["gen_ai.usage.output_tokens"] = outputTokens;
    }
    else if (type === "shell") {
        const command = stringValue(data.command);
        if (command)
            attrs.command = command;
        const exitCode = numberValue(data.exit_code ?? data.exitCode);
        if (exitCode !== null)
            attrs.exit_code = exitCode;
    }
    else if (type === "file") {
        const path = stringValue(data.path ?? data.file);
        if (path)
            attrs["file.path"] = path;
        const operation = stringValue(data.operation);
        if (operation)
            attrs.operation = operation;
    }
    else if (type === "mcp") {
        const server = stringValue(data.server ?? data.mcp_server);
        if (server)
            attrs["mcp.server.name"] = server;
        const method = stringValue(data.method ?? data.mcp_method);
        if (method)
            attrs["mcp.method.name"] = method;
    }
    else if (type === "skill") {
        const skill = stringValue(data.skill ?? data.name);
        if (skill)
            attrs["skill.name"] = skill;
    }
    else if (type === "state") {
        const state = stringValue(data.state ?? data.name);
        if (state)
            attrs["state.name"] = state;
    }
}
function parseOpenClawSessionLog(raw, options) {
    const entries = [];
    let sourceEventCount = 0;
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const entry = parseJsonObject(line);
        if (!entry)
            continue;
        sourceEventCount += 1;
        const message = recordValue(entry.message) ?? entry;
        const timestamp = stringValue(entry.timestamp ?? message.timestamp);
        const role = stringValue(message.role)?.toLowerCase() ?? "";
        const text = contentText(contentItems(message.content));
        entries.push({ entry, timestamp, role, text });
    }
    const window = resolveSessionWindow(entries, options);
    const events = [];
    const pendingTools = new Map();
    let sessionId = null;
    let firstUserText = "";
    let latestUserText = "";
    let finalOutput = "";
    let modelIndex = 0;
    let toolIndex = 0;
    let includedEventCount = 0;
    let outOfWindowFilteredCount = 0;
    let selfStepFilteredCount = 0;
    let controlMessageFilteredCount = 0;
    for (const item of entries) {
        const entry = item.entry;
        sessionId ??= stringValue(entry.sessionId ?? entry.session_id);
        if (!isWithinWindow(item.timestamp, window.startTime, window.endTime)) {
            outOfWindowFilteredCount += 1;
            continue;
        }
        includedEventCount += 1;
        if (entry.type === "session")
            continue;
        if (entry.type !== "message" && !recordValue(entry.message))
            continue;
        const message = recordValue(entry.message) ?? entry;
        sessionId ??= stringValue(message.sessionId ?? message.session_id);
        const timestamp = stringValue(entry.timestamp ?? message.timestamp);
        const role = stringValue(message.role)?.toLowerCase() ?? "";
        const content = contentItems(message.content);
        const text = contentText(content);
        if (role === "user" && isRecordingControlText(text)) {
            controlMessageFilteredCount += 1;
            continue;
        }
        if (role === "user" && text) {
            latestUserText = text;
            if (!firstUserText)
                firstUserText = text;
            continue;
        }
        if (role === "assistant") {
            const toolUses = content.map(toolUseFromContent).filter((item) => item !== null);
            const model = stringValue(message.model) ?? stringValue(entry.model) ?? "openclaw-model";
            const provider = stringValue(message.provider ?? entry.provider);
            const usage = recordValue(message.usage ?? entry.usage);
            const output = toolUses.length > 0 ? { tool_calls: toolUses.map((tool) => ({ id: tool.id, name: tool.name, input: tool.input })) } : { text };
            const modelEvent = structuredInputToRecordEvent({
                type: "model",
                step_id: `step_session_model_${String(++modelIndex).padStart(6, "0")}`,
                timestamp,
                model,
                provider,
                usage,
                input: latestUserText ? { messages: [{ role: "user", content: latestUserText }] } : undefined,
                output
            }, {
                defaultAgentName: stringValue(message.agentName ?? message.agent_name ?? entry.agentName ?? entry.agent_name) ?? "session",
                extraAttrs: sessionEvidenceAttrs(message, entry, sessionId)
            });
            if (options.excludeSelf && isSelfTrajectoryEvent(modelEvent)) {
                selfStepFilteredCount += 1;
            }
            else {
                events.push(modelEvent);
            }
            for (const tool of toolUses) {
                pendingTools.set(tool.id, { ...tool, timestamp });
            }
            if (text)
                finalOutput = text;
            continue;
        }
        const toolResult = toolResultFromMessage(message, content);
        if (toolResult) {
            const pending = pendingTools.get(toolResult.id);
            const name = pending?.name ?? toolResult.name ?? "session_tool";
            const input = pending?.input ?? toolResult.input;
            const durationMs = pending?.timestamp && timestamp ? Math.max(0, Date.parse(timestamp) - Date.parse(pending.timestamp)) : undefined;
            const toolEvent = structuredInputToRecordEvent({
                type: "tool",
                step_id: `step_session_tool_${String(++toolIndex).padStart(6, "0")}`,
                timestamp,
                tool_call_id: toolResult.id,
                tool_name: name,
                duration_ms: durationMs,
                input,
                output: toolResult.output
            }, {
                defaultAgentName: stringValue(message.agentName ?? message.agent_name ?? entry.agentName ?? entry.agent_name) ?? "session",
                extraAttrs: sessionEvidenceAttrs(message, entry, sessionId)
            });
            if (options.excludeSelf && isSelfTrajectoryEvent(toolEvent)) {
                selfStepFilteredCount += 1;
            }
            else {
                events.push(toolEvent);
            }
            pendingTools.delete(toolResult.id);
        }
    }
    const report = buildReconstructionReport(events, {
        sourceEventCount,
        includedEventCount,
        outOfWindowFilteredCount,
        selfStepFilteredCount,
        controlMessageFilteredCount,
        startTime: window.startTime,
        endTime: window.endTime,
        windowSource: window.source,
        excludeSelf: options.excludeSelf
    });
    return {
        sessionId,
        input: firstUserText || "OpenClaw session log",
        finalOutput: finalOutput || "reconstructed from OpenClaw session log",
        events,
        report
    };
}
function enrichEventByType(event, noteType, fields, outputText) {
    const attrs = event.attrs ?? {};
    if (noteType === "shell") {
        const command = fields.command ?? fields["命令"] ?? outputText.match(/(?:运行|执行)\s+`?([^`\n，。]+)`?/)?.[1]?.trim();
        if (command) {
            attrs.command = command;
            event.input = { ...(recordOrNull(event.input) ?? {}), command };
        }
        const exitCode = numberField(fields.exit_code ?? fields.exitCode ?? fields["退出码"]);
        if (exitCode !== null)
            attrs.exit_code = exitCode;
        event.output = { ...(recordOrNull(event.output) ?? {}), ...(exitCode !== null ? { exit_code: exitCode } : {}) };
    }
    else if (noteType === "file") {
        const path = fields.path ?? fields.file ?? fields["文件"];
        if (path) {
            attrs["file.path"] = path;
            event.input = { ...(recordOrNull(event.input) ?? {}), path };
        }
        const operation = fields.operation ?? fields["操作"] ?? "write";
        attrs.operation = operation;
        event.input = { ...(recordOrNull(event.input) ?? {}), operation };
    }
    else if (noteType === "model") {
        const model = fields.model ?? fields["模型"];
        if (model)
            attrs["gen_ai.request.model"] = model;
    }
    else if (noteType === "tool") {
        const toolName = fields.tool ?? fields.name ?? fields["工具"] ?? "manual_tool";
        attrs["tool.name"] = toolName;
        if (fields.namespace)
            attrs["tool.namespace"] = fields.namespace;
    }
    else if (noteType === "mcp") {
        if (fields.server)
            attrs["mcp.server.name"] = fields.server;
        attrs["mcp.method.name"] = fields.method ?? fields["方法"] ?? "manual";
    }
    else if (noteType === "skill") {
        attrs["skill.name"] = fields.skill ?? fields.name ?? fields["技能"] ?? "manual_skill";
    }
    else if (noteType === "state") {
        attrs["state.name"] = fields.state ?? fields.name ?? fields["状态名"] ?? "manual_state";
    }
    event.attrs = attrs;
}
function parseTranscript(transcript) {
    const lines = transcript.split(/\r?\n/);
    let currentSection = null;
    let currentStep = null;
    const input = [];
    const finalOutput = [];
    const steps = [];
    for (const line of lines) {
        const top = line.match(/^#\s+(.+?)\s*$/);
        if (top) {
            if (currentStep) {
                steps.push(currentStep);
                currentStep = null;
            }
            const title = top[1] ?? "";
            currentSection = /最终|结果|final/i.test(title) ? "final" : /任务|input/i.test(title) ? "input" : null;
            continue;
        }
        const stepHeading = line.match(/^##\s+(.+?)\s*$/);
        if (stepHeading) {
            if (currentStep)
                steps.push(currentStep);
            currentSection = null;
            currentStep = parseStepHeading(stepHeading[1] ?? "");
            continue;
        }
        if (currentStep) {
            currentStep.text = appendSection(currentStep.text, line);
        }
        else if (currentSection === "input") {
            input.push(line);
        }
        else if (currentSection === "final") {
            finalOutput.push(line);
        }
    }
    if (currentStep)
        steps.push(currentStep);
    return {
        input: input.join("\n").trim() || "reconstructed trajectory",
        finalOutput: finalOutput.join("\n").trim() || "reconstructed",
        steps: steps.length > 0 ? steps : [{ type: "state", stepId: "step_reconstructed_000001", status: "ok", text: transcript }]
    };
}
function parseStepHeading(heading) {
    const tokens = heading.trim().split(/\s+/);
    const typeToken = tokens.shift() ?? "状态";
    const statusToken = [...tokens].reverse().find((token) => ["ok", "error", "cancelled", "timeout"].includes(token));
    const stepToken = tokens.find((token) => token.startsWith("step_")) ?? null;
    return {
        type: normalizeManualType(typeToken),
        stepId: normalizeStepId(stepToken),
        status: normalizeManualStatus(statusToken ?? "ok"),
        text: ""
    };
}
function normalizeManualType(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (["model", "模型", "llm"].includes(text))
        return "model";
    if (["tool", "工具"].includes(text))
        return "tool";
    if (["shell", "command", "cmd", "命令", "终端"].includes(text))
        return "shell";
    if (["file", "文件", "patch"].includes(text))
        return "file";
    if (["mcp"].includes(text))
        return "mcp";
    if (["skill", "技能"].includes(text))
        return "skill";
    if (["agent", "代理"].includes(text))
        return "agent";
    return "state";
}
function inferManualType(parsed, text) {
    const fields = parsed.fields;
    if (fields.command || fields["命令"] || /运行|执行|exit_code|退出码|npm |pnpm |pytest|cargo |go test/.test(text))
        return "shell";
    if (fields.path || fields.file || fields["文件"] || /修改文件|写入文件|patch/.test(text))
        return "file";
    if (fields.tool || fields["工具"])
        return "tool";
    if (fields.model || fields["模型"])
        return "model";
    if (fields.skill || fields["技能"])
        return "skill";
    if (fields.server || fields.method || /\bmcp\b/i.test(text))
        return "mcp";
    return "state";
}
function normalizeManualStatus(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (["ok", "success", "成功", "通过"].includes(text))
        return "ok";
    if (["error", "failed", "fail", "失败", "错误"].includes(text))
        return "error";
    if (["timeout", "超时"].includes(text))
        return "timeout";
    if (["cancelled", "canceled", "取消"].includes(text))
        return "cancelled";
    if (["running", "进行中"].includes(text))
        return "running";
    return "ok";
}
function inferManualStatus(text) {
    if (/超时|timeout/i.test(text))
        return "timeout";
    if (/失败|错误|error|failed|assertion failed/i.test(text))
        return "error";
    return "ok";
}
function inferFinalStatus(value) {
    const text = stringifyLoose(value).toLowerCase();
    if (/超时|timeout/.test(text))
        return "timeout";
    if (/取消|cancelled|canceled/.test(text))
        return "cancelled";
    if (/未完成|失败|错误|认证失败|无权限|只读|需要.*认证|error|failed|permission denied|unauthorized/.test(text))
        return "error";
    return "ok";
}
function normalizeStepId(value) {
    const text = String(value ?? "").trim();
    return /^step_[A-Za-z0-9._-]+$/.test(text) ? text : null;
}
function nextManualStepId(active) {
    return `step_manual_${String(active.note_count + 1).padStart(6, "0")}`;
}
function kindForManualType(type) {
    if (type === "model")
        return "model.call";
    if (type === "tool")
        return "tool.call";
    if (type === "shell")
        return "shell.exec";
    if (type === "file")
        return "file.write";
    if (type === "mcp")
        return "mcp.call";
    if (type === "skill")
        return "skill.invoke";
    if (type === "agent")
        return "agent.event";
    return "state.snapshot";
}
function actorForManualType(type) {
    if (type === "model")
        return "model";
    if (type === "tool")
        return "tool";
    if (type === "shell")
        return "shell";
    if (type === "file")
        return "file";
    if (type === "mcp")
        return "mcp";
    if (type === "skill")
        return "skill";
    if (type === "agent")
        return "agent";
    return "state";
}
function manualTypeForRecordEvent(event) {
    if (event.actor === "model")
        return "model";
    if (event.actor === "tool")
        return "tool";
    if (event.actor === "shell")
        return "shell";
    if (event.actor === "file")
        return "file";
    if (event.actor === "mcp")
        return "mcp";
    if (event.actor === "skill")
        return "skill";
    if (event.actor === "agent")
        return "agent";
    return "state";
}
function normalizeFieldKey(key) {
    const lower = key.trim().toLowerCase();
    const aliases = {
        输入: "input",
        输出: "output",
        错误: "error",
        命令: "command",
        退出码: "exit_code",
        耗时: "duration",
        文件: "path",
        操作: "operation",
        模型: "model",
        工具: "tool",
        技能: "skill",
        代理: "agent",
        方法: "method"
    };
    return aliases[lower] ?? aliases[key.trim()] ?? lower;
}
function isKnownField(key) {
    return [
        "agent",
        "agent.name",
        "command",
        "duration",
        "exit_code",
        "exitCode",
        "path",
        "file",
        "operation",
        "model",
        "tool",
        "namespace",
        "server",
        "method",
        "skill",
        "name",
        "state",
        "step_id",
        "timestamp",
        "命令",
        "退出码",
        "耗时",
        "文件",
        "操作",
        "模型",
        "工具",
        "技能",
        "代理",
        "方法"
    ].includes(key.trim());
}
function appendSection(current, line) {
    const next = line.trimEnd();
    if (!current)
        return next;
    return `${current}\n${next}`;
}
function trimSections(sections) {
    const next = {};
    for (const [key, value] of Object.entries(sections)) {
        next[key] = value.trim();
    }
    return next;
}
function parseDurationField(value) {
    if (!value)
        return null;
    try {
        return parseDuration(value.replace(/\s+/g, ""));
    }
    catch {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }
}
function numberField(value) {
    if (!value)
        return null;
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : null;
}
function recordOrNull(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function recordValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringValue(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return null;
}
function numberValue(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function errorValue(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === "string")
        return { message: value };
    const record = recordValue(value);
    if (!record)
        return { message: String(value) };
    return {
        ...record,
        message: stringValue(record.message) ?? stringValue(record.error) ?? "structured event error"
    };
}
function parseJsonObject(line) {
    try {
        return recordValue(JSON.parse(line));
    }
    catch {
        return null;
    }
}
function contentItems(value) {
    if (Array.isArray(value))
        return value.map(recordValue).filter((item) => item !== null);
    const record = recordValue(value);
    if (record)
        return [record];
    if (typeof value === "string")
        return [{ type: "text", text: value }];
    return [];
}
function contentText(items) {
    return items
        .map((item) => stringValue(item.text ?? item.content))
        .filter((item) => item !== null && item.length > 0)
        .join("\n")
        .trim();
}
function toolUseFromContent(item) {
    const type = stringValue(item.type)?.toLowerCase() ?? "";
    const name = stringValue(item.name ?? item.toolName ?? item.tool_name);
    if (!name || !["tool_use", "tool-call", "tool_call", "function_call"].includes(type))
        return null;
    return {
        id: stringValue(item.id ?? item.tool_use_id ?? item.toolCallId ?? item.call_id) ?? `tool_${name}`,
        name,
        input: item.input ?? item.arguments ?? item.args ?? {},
        timestamp: stringValue(item.timestamp)
    };
}
function toolResultFromMessage(message, content) {
    const directId = stringValue(message.tool_call_id ?? message.toolCallId ?? message.tool_use_id);
    const directName = stringValue(message.name ?? message.toolName ?? message.tool_name);
    if (directId) {
        return {
            id: directId,
            name: directName,
            input: message.input ?? message.args ?? message.arguments ?? inferToolInputFromOutput(message.output ?? message.result ?? content),
            output: message.output ?? message.result ?? (content.length > 0 ? content : message.content)
        };
    }
    for (const item of content) {
        const type = stringValue(item.type)?.toLowerCase() ?? "";
        if (!["tool_result", "tool-result", "function_result"].includes(type))
            continue;
        const id = stringValue(item.tool_use_id ?? item.toolCallId ?? item.id ?? item.call_id);
        if (!id)
            continue;
        const output = item.content ?? item.output ?? item.result ?? item;
        return {
            id,
            name: stringValue(item.name ?? item.toolName ?? item.tool_name),
            input: item.input ?? item.args ?? item.arguments ?? inferToolInputFromOutput(output),
            output
        };
    }
    const role = stringValue(message.role)?.toLowerCase();
    if (role === "tool" && content.length > 0) {
        const output = content.length === 1 ? content[0] : content;
        return { id: directName ?? "tool_result", name: directName, input: inferToolInputFromOutput(output), output };
    }
    return null;
}
function sessionEvidenceAttrs(message, entry, sessionId) {
    const agentId = stringValue(message.agentId ?? message.agent_id ?? entry.agentId ?? entry.agent_id);
    const agentName = stringValue(message.agentName ?? message.agent_name ?? entry.agentName ?? entry.agent_name);
    const sessionKey = stringValue(message.sessionKey ?? message.session_key ?? entry.sessionKey ?? entry.session_key);
    const turnId = stringValue(message.turnId ?? message.turn_id ?? entry.turnId ?? entry.turn_id);
    return {
        "recording.source": "session-log",
        "recording.fidelity": "medium",
        "evidence.source": "openclaw_session_log",
        "openclaw.message_id": message.id ?? null,
        ...(sessionId ? { "openclaw.session_id": sessionId } : {}),
        ...(sessionKey ? { "openclaw.session_key": sessionKey } : {}),
        ...(agentId ? { "openclaw.agent_id": agentId } : {}),
        ...(agentName ? { "openclaw.agent_name": agentName, "agent.name": agentName } : {}),
        ...(turnId ? { "openclaw.turn_id": turnId } : {})
    };
}
function isWithinWindow(timestamp, startTime, endTime) {
    if (!timestamp)
        return true;
    const value = Date.parse(timestamp);
    if (!Number.isFinite(value))
        return true;
    if (startTime && value < Date.parse(startTime))
        return false;
    if (endTime && value > Date.parse(endTime))
        return false;
    return true;
}
function resolveSessionWindow(entries, options) {
    if (!options.detectWindow) {
        return {
            startTime: options.startTime,
            endTime: options.endTime,
            source: options.startTime || options.endTime ? "explicit" : "none"
        };
    }
    let startTime = options.startTime;
    let endTime = options.endTime;
    let markerStart = null;
    let markerEnd = null;
    const userMarkers = entries.filter((entry) => entry.role === "user" && entry.timestamp && isRecordingControlText(entry.text));
    const stopMarkers = userMarkers.filter((entry) => isStopRecordingText(entry.text));
    const startMarkers = userMarkers.filter((entry) => isStartRecordingText(entry.text));
    if (!endTime && stopMarkers.length > 0) {
        markerEnd = stopMarkers.at(-1)?.timestamp ?? null;
        endTime = markerEnd;
    }
    if (!startTime && startMarkers.length > 0) {
        const endMs = endTime ? Date.parse(endTime) : Number.POSITIVE_INFINITY;
        markerStart =
            [...startMarkers]
                .reverse()
                .find((entry) => {
                const value = Date.parse(entry.timestamp ?? "");
                return Number.isFinite(value) && value <= endMs;
            })?.timestamp ?? startMarkers.at(-1)?.timestamp ?? null;
        startTime = markerStart;
    }
    if (!endTime && startTime && stopMarkers.length > 0) {
        const startMs = Date.parse(startTime);
        markerEnd =
            stopMarkers.find((entry) => {
                const value = Date.parse(entry.timestamp ?? "");
                return Number.isFinite(value) && value >= startMs;
            })?.timestamp ?? null;
        endTime = markerEnd;
    }
    return {
        startTime,
        endTime,
        source: options.startTime || options.endTime ? "explicit" : markerStart || markerEnd ? "recording_markers" : "none"
    };
}
function isRecordingControlText(text) {
    return isStartRecordingText(text) || isStopRecordingText(text);
}
function isStartRecordingText(text) {
    const value = text.trim().toLowerCase();
    return /(?:开始|启动|开启).*(?:录制|记录|trace|trajectory|轨迹)/i.test(value);
}
function isStopRecordingText(text) {
    const value = text.trim().toLowerCase();
    return /(?:停止|结束|终止|关闭).*(?:录制|记录|trace|trajectory|轨迹)/i.test(value);
}
function isSelfTrajectoryEvent(event) {
    const text = JSON.stringify({ input: event.input, output: event.output, attrs: event.attrs }).toLowerCase();
    return [
        "openclaw-trajectory",
        "manual-start",
        "manual-stop",
        "manual-note",
        "record-event",
        "reconstruct-session",
        "active-recording.json"
    ].some((marker) => text.includes(marker));
}
function inferToolInputFromOutput(output) {
    const text = stringifyLoose(output);
    const command = text.match(/(?:^|["'`\n\r ])((?:edi|npm|pnpm|node|python|pytest|cat|ls|grep|rg)\s+[^"`\n\r]+)/)?.[1]?.trim();
    if (command)
        return { command };
    const path = text.match(/(?:path|file|access|read)['":\s]+([/~A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/)?.[1];
    if (path)
        return { path };
    return undefined;
}
function buildReconstructionReport(events, context) {
    const modelStepCount = events.filter((event) => event.actor === "model").length;
    const toolEvents = events.filter((event) => event.actor === "tool");
    const toolInputMissingCount = toolEvents.filter((event) => event.input === undefined || event.input === null).length;
    const summaryOnlyToolOutputCount = toolEvents.filter((event) => isSummaryOnlyToolOutput(event.output)).length;
    const zeroDurationStepCount = events.filter((event) => numberValue(event.attrs?.duration_ms) === null || numberValue(event.attrs?.duration_ms) === 0).length;
    const modelTextEmptyCount = events.filter((event) => event.actor === "model" && outputTextEmpty(event.output)).length;
    const warnings = [];
    if (toolInputMissingCount > 0)
        warnings.push({ code: "tool_input_missing", message: `${toolInputMissingCount} tool steps have no structured input.` });
    if (summaryOnlyToolOutputCount > 0)
        warnings.push({ code: "summary_only_tool_output", message: `${summaryOnlyToolOutputCount} tool steps only have summary output.` });
    if (zeroDurationStepCount > 0)
        warnings.push({ code: "zero_duration_steps", message: `${zeroDurationStepCount} steps have zero or missing duration.` });
    if (modelTextEmptyCount > 0)
        warnings.push({ code: "model_output_empty", message: `${modelTextEmptyCount} model steps have empty text output.` });
    const readinessReasons = reconstructionReadinessReasons({
        stepCount: events.length,
        modelStepCount,
        toolStepCount: toolEvents.length,
        toolInputMissingCount,
        summaryOnlyToolOutputCount,
        zeroDurationStepCount
    });
    const evaluationReadiness = readinessReasons.length === 0
        ? "ready"
        : readinessReasons.includes("empty_trajectory") || readinessReasons.includes("missing_model_steps") || readinessReasons.includes("tool_input_missing")
            ? "not_ready"
            : "limited";
    const quality = toolInputMissingCount === 0 && events.length > 0 ? "medium" : events.length > 0 ? "low" : "low";
    return {
        schema_version: "openclaw.reconstruction-report/v1",
        generated_at: new Date().toISOString(),
        source_event_count: context.sourceEventCount,
        included_event_count: context.includedEventCount,
        out_of_window_filtered_count: context.outOfWindowFilteredCount,
        self_step_filtered_count: context.selfStepFilteredCount,
        control_message_filtered_count: context.controlMessageFilteredCount,
        step_count: events.length,
        model_step_count: modelStepCount,
        tool_step_count: toolEvents.length,
        tool_input_missing_count: toolInputMissingCount,
        summary_only_tool_output_count: summaryOnlyToolOutputCount,
        zero_duration_step_count: zeroDurationStepCount,
        model_text_empty_count: modelTextEmptyCount,
        evaluation_readiness: evaluationReadiness,
        readiness_reasons: readinessReasons,
        time_window: {
            start_time: context.startTime,
            end_time: context.endTime,
            source: context.windowSource
        },
        exclude_self: context.excludeSelf,
        quality,
        warnings
    };
}
function reconstructionReadinessReasons(context) {
    const reasons = [];
    if (context.stepCount === 0)
        reasons.push("empty_trajectory");
    if (context.modelStepCount === 0)
        reasons.push("missing_model_steps");
    if (context.toolStepCount === 0)
        reasons.push("missing_tool_steps");
    if (context.toolInputMissingCount > 0)
        reasons.push("tool_input_missing");
    if (context.summaryOnlyToolOutputCount > 0)
        reasons.push("summary_only_tool_output");
    if (context.zeroDurationStepCount > 0)
        reasons.push("zero_duration_steps");
    return reasons;
}
function isSummaryOnlyToolOutput(output) {
    const record = recordValue(output);
    if (!record)
        return false;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined && record[key] !== null);
    return keys.length === 1 && keys[0] === "summary";
}
function outputTextEmpty(output) {
    const record = recordValue(output);
    if (record && "text" in record)
        return stringValue(record.text)?.trim().length === 0;
    return false;
}
function stringifyLoose(value) {
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=manual.js.map
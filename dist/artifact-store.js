import { createHash } from "node:crypto";
import { access, appendFile, lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import safeRegex from "safe-regex2";
import { stableStringify } from "./utils.js";
export class MemorySummaryCache {
    maxEntries;
    entries = new Map();
    constructor(maxEntries = 1_000) {
        this.maxEntries = maxEntries;
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error("MemorySummaryCache maxEntries must be a positive integer.");
        }
    }
    async get(sha256) {
        validateSha256(sha256);
        const value = this.entries.get(sha256);
        if (value === undefined)
            return null;
        this.entries.delete(sha256);
        this.entries.set(sha256, value);
        return value;
    }
    async set(sha256, summary) {
        validateSha256(sha256);
        this.entries.delete(sha256);
        this.entries.set(sha256, summary);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.entries.delete(oldest);
        }
    }
}
export class FsSummaryCache {
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    async get(sha256) {
        validateSha256(sha256);
        const path = await this.safePath(sha256);
        try {
            const payload = JSON.parse(await readFile(path, "utf8"));
            return typeof payload.summary === "string" ? payload.summary : null;
        }
        catch {
            return null;
        }
    }
    async set(sha256, summary) {
        validateSha256(sha256);
        await mkdir(this.rootDir, { recursive: true });
        const path = await this.safePath(sha256);
        await atomicWriteFile(path, `${stableStringify({ sha256, summary })}\n`);
    }
    async safePath(sha256) {
        const root = resolve(this.rootDir);
        const absolute = resolve(root, `${sha256}.json`);
        const back = relative(root, absolute);
        if (back.startsWith("..") || isAbsolute(back)) {
            throw new Error(`Unsafe summary cache key: ${sha256}`);
        }
        return absolute;
    }
}
export function summaryCacheFromUri(uri) {
    if (uri === "cache://memory") {
        return new MemorySummaryCache();
    }
    if (uri.startsWith("cache:///")) {
        return new FsSummaryCache(uri.slice("cache://".length));
    }
    throw new Error(`Unsupported summary cache URI: ${uri}`);
}
export class ArtifactStore {
    rootDir;
    redactSecrets;
    summarize;
    llm;
    summaryMaxChars;
    summaryBudget;
    summaryCache;
    metaRecorder;
    summaryModelName;
    metaTraceCounter = 0;
    summaryCalls = 0;
    summaryBytes = 0;
    constructor(rootDir, options = {}) {
        this.rootDir = rootDir;
        this.redactSecrets = options.redactSecrets ?? true;
        this.summarize = options.summarize ?? "deterministic";
        this.llm = options.llm ?? null;
        if (this.summarize === "llm" && !this.llm) {
            throw new Error("ArtifactStore summarize=llm requires an llm client.");
        }
        this.summaryMaxChars = options.summaryMaxChars ?? 8000;
        this.summaryBudget = options.summaryBudget ?? {};
        this.summaryCache = options.summaryCache ?? null;
        this.metaRecorder = options.metaRecorder ?? null;
        this.summaryModelName = options.summaryModelName ?? "openclaw-runtime";
    }
    async writeJson(kind, value, metadata = {}) {
        const redacted = this.redactSecrets ? redactJson(value) : { value, redacted: false, redactedKeys: [] };
        const content = `${JSON.stringify(redacted.value)}\n`;
        return this.writeBytes(kind, Buffer.from(content, "utf8"), "application/json", {
            ...metadata,
            ...(redacted.cycleDetected ? { cycle_detected: true, cycle_paths: redacted.cyclePaths } : {})
        }, redacted.redacted, redacted.redactedKeys);
    }
    async writeText(kind, value, metadata = {}) {
        const redacted = this.redactSecrets ? redactText(value) : { value, redacted: false, redactedKeys: [] };
        return this.writeBytes(kind, Buffer.from(redacted.value, "utf8"), "text/plain; charset=utf-8", metadata, redacted.redacted, redacted.redactedKeys);
    }
    async readJson(uri) {
        const content = await this.readText(uri);
        return JSON.parse(content);
    }
    async readText(uri) {
        const path = await this.safePathFromUri(uri);
        return readFile(path, "utf8");
    }
    async readMetadata(uri) {
        const path = await this.safePathFromUri(uri);
        return JSON.parse(await readFile(`${path}.meta.json`, "utf8"));
    }
    pathFromUri(uri) {
        const prefix = "artifact://";
        if (!uri.startsWith(prefix)) {
            throw new Error(`Unsupported artifact uri: ${uri}`);
        }
        const relativePath = uri.slice(prefix.length);
        if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) {
            throw new Error(`Unsafe artifact uri: ${uri}`);
        }
        const root = resolve(this.rootDir);
        const absolute = resolve(root, relativePath);
        const back = relative(root, absolute);
        if (back === "" || back.startsWith("..") || isAbsolute(back)) {
            throw new Error(`Unsafe artifact uri: ${uri}`);
        }
        return absolute;
    }
    async safePathFromUri(uri) {
        const guess = this.pathFromUri(uri);
        const root = await this.safeRoot();
        const resolved = await realpath(guess).catch(() => guess);
        if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
            throw new Error(`Unsafe artifact uri: ${uri}`);
        }
        return resolved;
    }
    safeRoot() {
        return realpath(this.rootDir);
    }
    async writeBytes(kind, bytes, mimeType, metadata, redacted, redactedKeys) {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const extension = extensionForMime(mimeType);
        const safeKind = artifactKindPath(kind);
        const relativeContentPath = join(safeKind, `${sha256}${extension}`);
        const absoluteContentPath = join(this.rootDir, relativeContentPath);
        const absoluteMetadataPath = `${absoluteContentPath}.meta.json`;
        await mkdir(dirname(absoluteContentPath), { recursive: true });
        const existing = await readArtifactMetadata(absoluteMetadataPath);
        if (existing)
            return existing;
        try {
            await writeFile(absoluteContentPath, bytes, { flag: "wx" });
        }
        catch (error) {
            if (!isFileExistsError(error)) {
                throw error;
            }
        }
        const metadataAfterContentRace = await readArtifactMetadata(absoluteMetadataPath);
        if (metadataAfterContentRace)
            return metadataAfterContentRace;
        const skipSummary = metadata["openclaw.summary.skip"] === true;
        const summary = skipSummary ? { value: null, source: "none" } : await this.createSummary(kind, bytes, mimeType, sha256, redacted);
        const artifact = {
            schema_version: "openclaw.artifact/v1",
            artifact_id: `art_${sha256.slice(0, 24)}`,
            uri: `artifact://${relativeContentPath}`,
            kind,
            mime_type: mimeType,
            sha256,
            size_bytes: bytes.byteLength,
            created_at: new Date().toISOString(),
            summary: summary.value,
            redacted,
            redacted_keys: redactedKeys,
            metadata: {
                original_kind: redactText(kind).value.slice(0, 160),
                ...metadata,
                summary_source: summary.source,
                ...(summary.metadata ?? {}),
                ...(summary.error ? { summary_error: summary.error } : {})
            }
        };
        await atomicWriteFile(absoluteMetadataPath, `${stableStringify(artifact)}\n`);
        await this.appendArtifactIndex(artifact).catch(() => undefined);
        return artifact;
    }
    async appendArtifactIndex(artifact) {
        await mkdir(this.rootDir, { recursive: true });
        await appendFile(join(this.rootDir, "index.jsonl"), `${stableStringify({
            artifact_id: artifact.artifact_id,
            uri: artifact.uri,
            kind: artifact.kind,
            mime_type: artifact.mime_type,
            sha256: artifact.sha256,
            size_bytes: artifact.size_bytes,
            created_at: artifact.created_at,
            summary: artifact.summary
        })}\n`, "utf8");
    }
    async createSummary(kind, bytes, mimeType, sha256, redacted) {
        if (this.summarize === "none") {
            return { value: null, source: "none" };
        }
        const text = bytes.toString("utf8");
        if (this.summarize === "llm" && this.llm && !redacted) {
            const cached = await this.summaryCache?.get(sha256);
            if (cached) {
                return { value: cached, source: "llm_cache" };
            }
            if (!this.consumeSummaryBudget(bytes.byteLength)) {
                return { value: deterministicSummary(kind, text, mimeType, bytes.byteLength), source: "deterministic_budget_exhausted" };
            }
            try {
                const sanitizedText = redactText(text).value.slice(0, this.summaryMaxChars);
                const input = {
                    kind,
                    mimeType,
                    text: sanitizedText,
                    sha256,
                    sizeBytes: bytes.byteLength,
                    sizeClass: sizeClass(bytes.byteLength),
                    maxChars: this.summaryMaxChars
                };
                const summary = await this.traceLlmSummary(kind, sha256, input, () => this.llm?.summarizeArtifact(input) ?? Promise.resolve(null));
                const parsed = parseSummaryResponse(summary);
                if (parsed.summary && parsed.summary.trim().length > 0) {
                    await this.summaryCache?.set(sha256, parsed.summary).catch(() => undefined);
                    return {
                        value: parsed.summary,
                        source: "llm",
                        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {})
                    };
                }
            }
            catch (error) {
                return {
                    value: deterministicSummary(kind, text, mimeType, bytes.byteLength),
                    source: "deterministic",
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        }
        return {
            value: deterministicSummary(kind, text, mimeType, bytes.byteLength),
            source: "deterministic"
        };
    }
    consumeSummaryBudget(sizeBytes) {
        const maxCalls = this.summaryBudget.maxCalls;
        if (maxCalls !== undefined && this.summaryCalls >= maxCalls) {
            return false;
        }
        const maxBytes = this.summaryBudget.maxBytes;
        if (maxBytes !== undefined && this.summaryBytes + sizeBytes > maxBytes) {
            return false;
        }
        this.summaryCalls += 1;
        this.summaryBytes += sizeBytes;
        return true;
    }
    async traceLlmSummary(kind, sha256, input, invoke) {
        if (!this.metaRecorder) {
            return invoke();
        }
        const attempt = ++this.metaTraceCounter;
        const suffix = `${Date.now().toString(36)}_${attempt.toString(36)}`;
        const spanId = `${sha256.slice(0, 12)}_${suffix}`;
        const stepId = `step_meta_${sha256.slice(0, 12)}_${attempt}`;
        const attrs = {
            "openclaw.meta_trace": true,
            "openclaw.meta_trace.operation": "artifact_summary",
            "artifact.kind": kind,
            "artifact.sha256": sha256,
            "gen_ai.operation.name": "summarize",
            "gen_ai.request.model": this.summaryModelName
        };
        await this.metaRecorder
            .record({
            kind: "model.call",
            actor: "model",
            phase: "start",
            status: "running",
            span_id: spanId,
            step_id: stepId,
            attrs,
            input: {
                kind: input.kind,
                mime_type: input.mimeType,
                size_bytes: input.sizeBytes,
                size_class: input.sizeClass
            }
        })
            .catch(() => undefined);
        try {
            const response = await invoke();
            const parsed = parseSummaryResponse(response);
            await this.metaRecorder
                .record({
                kind: "model.call",
                actor: "model",
                phase: "end",
                status: "ok",
                span_id: spanId,
                step_id: stepId,
                attrs: { ...attrs, ...usageAttrs(parsed.metadata) },
                output: parsed
            })
                .catch(() => undefined);
            return response;
        }
        catch (error) {
            await this.metaRecorder
                .record({
                kind: "model.call",
                actor: "model",
                phase: "end",
                status: "error",
                span_id: spanId,
                step_id: stepId,
                attrs,
                error: { message: error instanceof Error ? error.message : String(error) }
            })
                .catch(() => undefined);
            throw error;
        }
    }
}
export function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
function extensionForMime(mimeType) {
    if (mimeType === "application/json") {
        return ".json";
    }
    if (mimeType.startsWith("text/")) {
        return ".txt";
    }
    if (mimeType === "image/png") {
        return ".png";
    }
    if (mimeType === "image/jpeg") {
        return ".jpg";
    }
    if (mimeType === "application/pdf") {
        return ".pdf";
    }
    return ".bin";
}
function artifactKindPath(kind) {
    const sanitized = kind.replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/^_+|_+$/g, "") || "artifact";
    return `${sanitized}_${sha256Hex(kind).slice(0, 8)}`;
}
function deterministicSummary(kind, text, mimeType, sizeBytes) {
    const compact = text.replaceAll(/\s+/g, " ").trim();
    if (mimeType === "application/json") {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const keys = Object.keys(parsed).slice(0, 8);
                return `JSON object artifact ${kind} with keys: ${keys.join(", ") || "(none)"}. Size ${sizeBytes} bytes.`;
            }
            if (Array.isArray(parsed)) {
                return `JSON array artifact ${kind} with ${parsed.length} items. Size ${sizeBytes} bytes.`;
            }
            return `JSON ${typeof parsed} artifact ${kind}. Size ${sizeBytes} bytes.`;
        }
        catch {
            return `JSON artifact ${kind}, ${sizeBytes} bytes.`;
        }
    }
    return `Text artifact ${kind}, ${sizeBytes} bytes: ${compact.slice(0, 180)}`;
}
export function parseSummaryResponse(response) {
    if (typeof response === "string") {
        return { summary: response.trim() || null, metadata: {} };
    }
    if (!response || typeof response !== "object") {
        return { summary: null, metadata: {} };
    }
    const data = response.data && typeof response.data === "object" && !Array.isArray(response.data) ? response.data : {};
    const rawSummary = response.summary ??
        response.text ??
        data.summary ??
        extractText(response.choices) ??
        extractText(response.content) ??
        extractText(response.output) ??
        extractText(data);
    const metadata = {};
    for (const key of ["confidence", "reasons", "cited_lines", "schema_version", "kind"]) {
        const value = response[key];
        if (value !== undefined)
            metadata[key] = value;
    }
    const usage = extractUsage(response);
    if (usage.inputTokens !== null)
        metadata.input_tokens = usage.inputTokens;
    if (usage.outputTokens !== null)
        metadata.output_tokens = usage.outputTokens;
    if (usage.totalTokens !== null)
        metadata.total_tokens = usage.totalTokens;
    const costUsd = numberLike(response.cost_usd) ?? numberLike(response.cost?.usd);
    if (costUsd !== null)
        metadata.cost_usd = costUsd;
    return { summary: typeof rawSummary === "string" ? rawSummary.trim() || null : null, metadata };
}
function extractText(value) {
    if (typeof value === "string")
        return value;
    if (!value)
        return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = extractText(item);
            if (found)
                return found;
        }
        return null;
    }
    if (typeof value !== "object")
        return null;
    const record = value;
    for (const key of ["summary", "text", "content", "output_text"]) {
        const found = extractText(record[key]);
        if (found)
            return found;
    }
    const message = record.message;
    if (message && typeof message === "object") {
        const found = extractText(message.content);
        if (found)
            return found;
    }
    const delta = record.delta;
    if (delta && typeof delta === "object") {
        const found = extractText(delta.content);
        if (found)
            return found;
    }
    return null;
}
function extractUsage(response) {
    const usage = objectRecord(response.usage) ?? objectRecord(response.token_usage) ?? objectRecord(response.metrics) ?? {};
    const inputTokens = numberLike(usage.input_tokens) ??
        numberLike(usage.prompt_tokens) ??
        numberLike(usage.inputTokens) ??
        numberLike(usage.promptTokens);
    const outputTokens = numberLike(usage.output_tokens) ??
        numberLike(usage.completion_tokens) ??
        numberLike(usage.outputTokens) ??
        numberLike(usage.completionTokens);
    const totalTokens = numberLike(usage.total_tokens) ??
        numberLike(usage.totalTokens) ??
        (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);
    return { inputTokens, outputTokens, totalTokens };
}
function usageAttrs(metadata) {
    return {
        ...(typeof metadata.input_tokens === "number" ? { "gen_ai.usage.input_tokens": metadata.input_tokens } : {}),
        ...(typeof metadata.output_tokens === "number" ? { "gen_ai.usage.output_tokens": metadata.output_tokens } : {}),
        ...(typeof metadata.total_tokens === "number" ? { "gen_ai.usage.total_tokens": metadata.total_tokens } : {}),
        ...(typeof metadata.cost_usd === "number" ? { "gen_ai.cost.usd": metadata.cost_usd } : {})
    };
}
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function numberLike(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function sizeClass(sizeBytes) {
    if (sizeBytes < 8 * 1024)
        return "small";
    if (sizeBytes < 64 * 1024)
        return "medium";
    return "large";
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function readArtifactMetadata(path) {
    if (!(await exists(path)))
        return null;
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
async function atomicWriteFile(path, content) {
    const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
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
async function assertSafeDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Unsafe directory for atomic write: ${path}`);
    }
}
function isFileExistsError(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
export function redactJson(value, path = [], stack = new WeakSet(), context = {}) {
    if (Array.isArray(value)) {
        if (stack.has(value)) {
            return { value: "[Circular]", redacted: false, redactedKeys: [], cycleDetected: true, cyclePaths: [jsonPointer(path)] };
        }
        stack.add(value);
        let anyRedacted = false;
        const redactedKeys = [];
        const cyclePaths = [];
        const next = value.map((item, index) => {
            const redacted = redactJson(item, [...path, String(index)], stack, context);
            anyRedacted ||= redacted.redacted;
            redactedKeys.push(...redacted.redactedKeys);
            cyclePaths.push(...(redacted.cyclePaths ?? []));
            return redacted.value;
        });
        stack.delete(value);
        return { value: next, redacted: anyRedacted, redactedKeys, ...(cyclePaths.length > 0 ? { cycleDetected: true, cyclePaths } : {}) };
    }
    if (value && typeof value === "object") {
        if (stack.has(value)) {
            return { value: "[Circular]", redacted: false, redactedKeys: [], cycleDetected: true, cyclePaths: [jsonPointer(path)] };
        }
        stack.add(value);
        const objectContext = redactContextForObject(value, path, context);
        let anyRedacted = false;
        const redactedKeys = [];
        const cyclePaths = [];
        const next = {};
        for (const [key, item] of Object.entries(value)) {
            const keyPath = [...path, key];
            if (isSensitiveKey(key) && !isAllowedDiagnosticMetadataKey(keyPath, objectContext)) {
                next[key] = "[REDACTED]";
                anyRedacted = true;
                redactedKeys.push(jsonPointer(keyPath));
                continue;
            }
            const redacted = redactJson(item, keyPath, stack, objectContext);
            next[key] = redacted.value;
            anyRedacted ||= redacted.redacted;
            redactedKeys.push(...redacted.redactedKeys);
            cyclePaths.push(...(redacted.cyclePaths ?? []));
        }
        stack.delete(value);
        return { value: next, redacted: anyRedacted, redactedKeys, ...(cyclePaths.length > 0 ? { cycleDetected: true, cyclePaths } : {}) };
    }
    if (typeof value === "string") {
        return redactText(value);
    }
    return { value, redacted: false, redactedKeys: [] };
}
export function redactText(value) {
    const next = value
        .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
        .replaceAll(/Basic\s+[A-Za-z0-9._~+/=-]+/g, "Basic [REDACTED]")
        .replaceAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
        .replaceAll(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
        .replaceAll(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]")
        .replaceAll(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]")
        .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
        .replaceAll(/((?:key|token|secret|password|passcode|passphrase|auth|bearer|credential|credentials|signature|private|client_id|client-id)\s*[=:]\s*['"]?)([A-Za-z0-9._~+/=-]{16,})/gi, "$1[REDACTED]");
    const withEnvPatterns = applyEnvRedactPatterns(next);
    return { value: withEnvPatterns, redacted: withEnvPatterns !== value, redactedKeys: [] };
}
function isSensitiveKey(key) {
    const normalized = key.toLowerCase();
    const allowlist = new Set([
        "idempotency_token",
        "csrf_token",
        "prompt_token_count",
        "completion_tokens",
        ...envList("OPENCLAW_REDACT_KEY_ALLOWLIST")
    ]);
    if (allowlist.has(normalized) || /(input|output|total)[._-]?tokens?$/.test(normalized)) {
        return false;
    }
    if (/(api[._-]?key|api[._-]?secret|access[._-]?key|secret[._-]?key|client[._-]?secret|client[._-]?id|oauth[._-]?token|private[._-]?key|authorization|password|passcode|passphrase|cookie|credentials?|credential|密钥|口令|凭证|秘密|비밀|シークレット|секрет|mot[._-]?de[._-]?passe|geheimnis)/i.test(normalized)) {
        return true;
    }
    const parts = normalized.split(/[._-]/).filter(Boolean);
    return parts.some((part) => ["auth", "bearer", "token", "pat", "private"].includes(part));
}
const externalRequestDiagnosticTypes = new Set(["external.request.started", "external.request.completed", "external.request.failed"]);
const safeExternalDiagnosticAuthPaths = new Set([
    "auth",
    "auth/scheme",
    "auth/source",
    "auth/source/type",
    "auth/source/id",
    "auth/present",
    "auth/status",
    "auth/fingerprint"
]);
const safeExternalDiagnosticRedactionPaths = new Set([
    "redaction",
    "redaction/policy",
    "redaction/secret_fields_removed",
    "redaction/header_allowlist",
    "redaction/body_truncated",
    "redaction/body_max_bytes"
]);
const safeExternalDiagnosticAttrKeys = new Set(["auth.scheme", "auth.source.type", "auth.source.id", "auth.present", "auth.status", "auth.fingerprint"]);
function redactContextForObject(value, path, context) {
    const next = { ...context };
    if (isExternalRequestDiagnosticObject(value)) {
        next.externalRequestDiagnosticRootPath = path;
    }
    if (isExternalRequestDiagnosticAttrs(value)) {
        next.externalRequestDiagnosticAttrsPath = path;
    }
    return next;
}
function isExternalRequestDiagnosticObject(value) {
    return value.schema_version === "openclaw.diagnostic.external-request/v1" && typeof value.type === "string" && externalRequestDiagnosticTypes.has(value.type);
}
function isExternalRequestDiagnosticAttrs(value) {
    return value["openclaw.diagnostic_only"] === true && typeof value["openclaw.diagnostic_type"] === "string" && externalRequestDiagnosticTypes.has(value["openclaw.diagnostic_type"]);
}
function isAllowedDiagnosticMetadataKey(path, context) {
    if (context.externalRequestDiagnosticRootPath) {
        const relative = relativeRedactPath(path, context.externalRequestDiagnosticRootPath);
        if (relative) {
            const key = relative.join("/");
            if (safeExternalDiagnosticAuthPaths.has(key) || safeExternalDiagnosticRedactionPaths.has(key))
                return true;
        }
    }
    if (context.externalRequestDiagnosticAttrsPath) {
        const relative = relativeRedactPath(path, context.externalRequestDiagnosticAttrsPath);
        if (relative && relative.length === 1 && safeExternalDiagnosticAttrKeys.has(relative[0] ?? ""))
            return true;
    }
    return false;
}
function relativeRedactPath(path, root) {
    if (path.length <= root.length)
        return null;
    for (let index = 0; index < root.length; index += 1) {
        if (path[index] !== root[index])
            return null;
    }
    return path.slice(root.length);
}
function applyEnvRedactPatterns(value) {
    const raw = process.env.OPENCLAW_REDACT_PATTERNS;
    if (!raw)
        return value;
    return raw
        .split(/[\n,]/)
        .map((pattern) => pattern.trim())
        .filter(Boolean)
        .reduce((current, pattern) => {
        if (pattern.length > 200) {
            process.stderr.write(`Warning: OPENCLAW_REDACT_PATTERNS entry is too long and was ignored.\n`);
            return current;
        }
        if (!safeRegex(pattern)) {
            process.stderr.write(`Warning: OPENCLAW_REDACT_PATTERNS entry looks unsafe and was ignored.\n`);
            return current;
        }
        try {
            return current.replaceAll(new RegExp(pattern, "g"), "[REDACTED]");
        }
        catch (error) {
            process.stderr.write(`Warning: invalid OPENCLAW_REDACT_PATTERNS '${pattern}': ${error instanceof Error ? error.message : String(error)}\n`);
            return current;
        }
    }, value);
}
function jsonPointer(path) {
    return `/${path.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
function validateSha256(sha256) {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
        throw new Error(`Invalid sha256: ${sha256}`);
    }
}
function envList(name) {
    return (process.env[name] ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}
export { stableStringify };
//# sourceMappingURL=artifact-store.js.map
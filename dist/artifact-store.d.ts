import type { ArtifactMetadata } from "./types.js";
import { stableStringify } from "./utils.js";
export type ArtifactSummaryMode = "none" | "deterministic" | "llm";
export interface ArtifactSummaryInput {
    kind: string;
    mimeType: string;
    text: string;
    sha256: string;
    sizeBytes: number;
    sizeClass: "small" | "medium" | "large";
    maxChars: number;
}
export type LlmSummaryResponse = string | null | {
    kind?: "text" | "structured";
    text?: unknown;
    summary?: unknown;
    output?: unknown;
    choices?: unknown;
    content?: unknown;
    usage?: unknown;
    cost_usd?: unknown;
    cost?: unknown;
    confidence?: unknown;
    reasons?: unknown;
    cited_lines?: unknown;
    data?: unknown;
    schema_version?: unknown;
    [key: string]: unknown;
};
export interface LlmClient {
    summarizeArtifact(input: ArtifactSummaryInput): Promise<LlmSummaryResponse>;
}
export interface SummaryCache {
    get(sha256: string): Promise<string | null>;
    set(sha256: string, summary: string): Promise<void>;
}
export declare class MemorySummaryCache implements SummaryCache {
    private readonly maxEntries;
    private readonly entries;
    constructor(maxEntries?: number);
    get(sha256: string): Promise<string | null>;
    set(sha256: string, summary: string): Promise<void>;
}
export declare class FsSummaryCache implements SummaryCache {
    private readonly rootDir;
    constructor(rootDir: string);
    get(sha256: string): Promise<string | null>;
    set(sha256: string, summary: string): Promise<void>;
    private safePath;
}
export declare function summaryCacheFromUri(uri: string): SummaryCache;
export interface SummaryBudget {
    maxCalls?: number;
    maxBytes?: number;
}
export interface MetaTraceRecorder {
    record(options: {
        timestamp?: string;
        kind: string;
        actor: "model";
        phase: "start" | "end";
        status: "running" | "ok" | "error" | "timeout";
        parent_span_id?: string | null;
        span_id?: string;
        step_id?: string;
        attrs?: Record<string, unknown>;
        input?: unknown;
        output?: unknown;
        error?: {
            message: string;
            code?: string;
            stack?: string;
        } | null;
    }): Promise<unknown>;
}
export interface ArtifactStoreOptions {
    redactSecrets?: boolean;
    summarize?: ArtifactSummaryMode;
    llm?: LlmClient;
    summaryMaxChars?: number;
    summaryBudget?: SummaryBudget;
    summaryCache?: SummaryCache;
    metaRecorder?: MetaTraceRecorder | null;
    summaryModelName?: string | null;
}
export declare class ArtifactStore {
    private readonly rootDir;
    private readonly redactSecrets;
    private readonly summarize;
    private readonly llm;
    private readonly summaryMaxChars;
    private readonly summaryBudget;
    private readonly summaryCache;
    private readonly metaRecorder;
    private readonly summaryModelName;
    private metaTraceCounter;
    private summaryCalls;
    private summaryBytes;
    constructor(rootDir: string, options?: ArtifactStoreOptions);
    writeJson(kind: string, value: unknown, metadata?: Record<string, unknown>): Promise<ArtifactMetadata>;
    writeText(kind: string, value: string, metadata?: Record<string, unknown>): Promise<ArtifactMetadata>;
    readJson<T>(uri: string): Promise<T>;
    readText(uri: string): Promise<string>;
    readMetadata(uri: string): Promise<ArtifactMetadata>;
    pathFromUri(uri: string): string;
    safePathFromUri(uri: string): Promise<string>;
    private safeRoot;
    private writeBytes;
    private appendArtifactIndex;
    private createSummary;
    private consumeSummaryBudget;
    private traceLlmSummary;
}
export declare function sha256Hex(value: string | Buffer): string;
export declare function parseSummaryResponse(response: LlmSummaryResponse): {
    summary: string | null;
    metadata: Record<string, unknown>;
};
export interface RedactResult {
    value: unknown;
    redacted: boolean;
    redactedKeys: string[];
    cycleDetected?: boolean;
    cyclePaths?: string[];
}
interface RedactContext {
    externalRequestDiagnosticRootPath?: string[];
    externalRequestDiagnosticAttrsPath?: string[];
}
export declare function redactJson(value: unknown, path?: string[], stack?: WeakSet<object>, context?: RedactContext): RedactResult;
export declare function redactText(value: string): {
    value: string;
    redacted: boolean;
    redactedKeys: string[];
};
export { stableStringify };

import type { ArtifactStoreOptions, MetaTraceRecorder, SummaryBudget, SummaryCache } from "./artifact-store.js";
export type OpenClawRuntimeCapability = "summarize" | (string & {});
export interface OpenClawRuntimeHealth {
    status: "ok" | "error" | "disconnected";
    message?: string;
    capabilities: OpenClawRuntimeCapability[];
}
export interface OpenClawRuntimeAdapter extends Pick<ArtifactStoreOptions, "llm" | "summaryCache" | "summaryBudget" | "metaRecorder" | "summaryModelName"> {
    capabilities?: OpenClawRuntimeCapability[];
}
export interface RuntimeArtifactOptions {
    summarize?: ArtifactStoreOptions["summarize"];
    summaryMaxChars?: number;
}
export declare abstract class OpenClawRuntime {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    abstract negotiateCapabilities(): Promise<OpenClawRuntimeCapability[]>;
    abstract health(): Promise<OpenClawRuntimeHealth>;
    artifactStoreOptions(options?: RuntimeArtifactOptions): Promise<ArtifactStoreOptions>;
    protected abstract toAdapter(): Promise<OpenClawRuntimeAdapter>;
}
export declare class InProcessRuntime extends OpenClawRuntime {
    private readonly adapter;
    constructor(adapter: OpenClawRuntimeAdapter);
    negotiateCapabilities(): Promise<OpenClawRuntimeCapability[]>;
    health(): Promise<OpenClawRuntimeHealth>;
    protected toAdapter(): Promise<OpenClawRuntimeAdapter>;
}
export declare class MockRuntime extends InProcessRuntime {
    constructor(summary?: string, options?: Omit<OpenClawRuntimeAdapter, "llm" | "capabilities">);
}
export interface HttpRuntimeOptions {
    endpoint: string;
    capabilitiesEndpoint?: string | null;
    healthEndpoint?: string | null;
    model?: string | null;
    apiKey?: string | null;
    summaryCache?: SummaryCache;
    summaryBudget?: SummaryBudget;
    metaRecorder?: MetaTraceRecorder | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    warn?: (message: string) => void;
}
export declare class HttpRuntime extends OpenClawRuntime {
    private readonly options;
    private connected;
    private readonly fetchImpl;
    constructor(options: HttpRuntimeOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    negotiateCapabilities(): Promise<OpenClawRuntimeCapability[]>;
    health(): Promise<OpenClawRuntimeHealth>;
    protected toAdapter(): Promise<OpenClawRuntimeAdapter>;
    private healthProbe;
    private llmClient;
}
export declare function artifactStoreOptionsFromRuntime(runtime: OpenClawRuntimeAdapter, options?: RuntimeArtifactOptions): ArtifactStoreOptions;

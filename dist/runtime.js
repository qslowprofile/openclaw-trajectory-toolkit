import { createSafeHttpLlmClient, validateLlmEndpoint, withTimeout } from "./http-llm.js";
export class OpenClawRuntime {
    async connect() { }
    async disconnect() { }
    async artifactStoreOptions(options = {}) {
        return artifactStoreOptionsFromRuntime(await this.toAdapter(), options);
    }
}
export class InProcessRuntime extends OpenClawRuntime {
    adapter;
    constructor(adapter) {
        super();
        this.adapter = adapter;
    }
    async negotiateCapabilities() {
        return capabilitiesFromAdapter(this.adapter);
    }
    async health() {
        return {
            status: "ok",
            capabilities: await this.negotiateCapabilities()
        };
    }
    async toAdapter() {
        return this.adapter;
    }
}
export class MockRuntime extends InProcessRuntime {
    constructor(summary = "mock summary", options = {}) {
        super({
            ...options,
            capabilities: ["summarize"],
            llm: {
                summarizeArtifact: async () => summary
            }
        });
    }
}
export class HttpRuntime extends OpenClawRuntime {
    options;
    connected = false;
    fetchImpl;
    constructor(options) {
        super();
        this.options = options;
        validateLlmEndpoint(options.endpoint);
        if (options.capabilitiesEndpoint)
            validateLlmEndpoint(options.capabilitiesEndpoint);
        if (options.healthEndpoint)
            validateLlmEndpoint(options.healthEndpoint);
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async connect() {
        await this.healthProbe();
        this.connected = true;
    }
    async disconnect() {
        this.connected = false;
    }
    async negotiateCapabilities() {
        const endpoint = this.options.capabilitiesEndpoint ?? this.options.endpoint;
        try {
            const response = await this.fetchImpl(endpoint, { method: "OPTIONS" });
            if (response.ok) {
                const headerCapabilities = parseCapabilities(response.headers.get("x-openclaw-runtime-capabilities"));
                if (headerCapabilities.length > 0)
                    return headerCapabilities;
                const text = await withTimeout(response.text(), this.options.timeoutMs ?? 5_000, "OpenClaw runtime capabilities timed out");
                const bodyCapabilities = parseCapabilitiesFromBody(text);
                if (bodyCapabilities.length > 0)
                    return bodyCapabilities;
            }
        }
        catch {
            // A configured summary endpoint may not expose OPTIONS. In that case summarize remains the configured capability.
        }
        return ["summarize"];
    }
    async health() {
        if (!this.connected) {
            return {
                status: "disconnected",
                capabilities: await this.negotiateCapabilities()
            };
        }
        try {
            await this.healthProbe();
            return {
                status: "ok",
                capabilities: await this.negotiateCapabilities()
            };
        }
        catch (error) {
            return {
                status: "error",
                message: error instanceof Error ? error.message : String(error),
                capabilities: []
            };
        }
    }
    async toAdapter() {
        return {
            capabilities: await this.negotiateCapabilities(),
            llm: this.llmClient(),
            summaryModelName: this.options.model ?? process.env.OPENCLAW_LLM_MODEL ?? "openclaw-runtime",
            ...(this.options.summaryCache ? { summaryCache: this.options.summaryCache } : {}),
            ...(this.options.summaryBudget ? { summaryBudget: this.options.summaryBudget } : {}),
            ...(this.options.metaRecorder !== undefined ? { metaRecorder: this.options.metaRecorder } : {})
        };
    }
    async healthProbe() {
        const endpoint = this.options.healthEndpoint ?? this.options.endpoint;
        const response = await this.fetchImpl(endpoint, { method: "HEAD" });
        if (!response.ok && response.status !== 405) {
            throw new Error(`OpenClaw HTTP runtime health check failed with HTTP ${response.status}`);
        }
    }
    llmClient() {
        const clientOptions = {
            endpoint: this.options.endpoint,
            fetchImpl: this.fetchImpl
        };
        if (this.options.model !== undefined)
            clientOptions.model = this.options.model;
        if (this.options.apiKey !== undefined)
            clientOptions.apiKey = this.options.apiKey;
        if (this.options.timeoutMs !== undefined)
            clientOptions.timeoutMs = this.options.timeoutMs;
        if (this.options.maxBytes !== undefined)
            clientOptions.maxBytes = this.options.maxBytes;
        if (this.options.warn !== undefined)
            clientOptions.warn = this.options.warn;
        return createSafeHttpLlmClient(clientOptions);
    }
}
export function artifactStoreOptionsFromRuntime(runtime, options = {}) {
    const capabilities = capabilitiesFromAdapter(runtime);
    const canSummarize = capabilities.includes("summarize");
    if (options.summarize === "llm" && !canSummarize) {
        throw new Error("Runtime does not advertise the summarize capability required by summarize=llm.");
    }
    if (options.summarize === "llm" && !runtime.llm) {
        throw new Error("Runtime summarize=llm requires an llm client.");
    }
    const summarize = options.summarize ?? (runtime.llm && canSummarize ? "llm" : "deterministic");
    return {
        summarize,
        ...(summarize === "llm" && runtime.llm ? { llm: runtime.llm } : {}),
        ...(runtime.summaryCache ? { summaryCache: runtime.summaryCache } : {}),
        ...(runtime.summaryBudget ? { summaryBudget: runtime.summaryBudget } : {}),
        ...(runtime.metaRecorder !== undefined ? { metaRecorder: runtime.metaRecorder } : {}),
        ...(runtime.summaryModelName !== undefined ? { summaryModelName: runtime.summaryModelName } : {}),
        ...(options.summaryMaxChars !== undefined ? { summaryMaxChars: options.summaryMaxChars } : {})
    };
}
function capabilitiesFromAdapter(runtime) {
    if (runtime.capabilities !== undefined)
        return runtime.capabilities;
    return runtime.llm ? ["summarize"] : [];
}
function parseCapabilities(value) {
    return (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function parseCapabilitiesFromBody(value) {
    if (!value.trim())
        return [];
    try {
        const payload = JSON.parse(value);
        if (!Array.isArray(payload.capabilities))
            return [];
        return payload.capabilities.filter((item) => typeof item === "string" && item.trim().length > 0);
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=runtime.js.map
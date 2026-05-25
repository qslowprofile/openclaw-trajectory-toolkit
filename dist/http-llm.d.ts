import type { ArtifactSummaryInput, LlmClient } from "./artifact-store.js";
export interface SafeHttpLlmClientOptions {
    endpoint: string;
    model?: string | null;
    apiKey?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    warn?: (message: string) => void;
}
export declare function createSafeHttpLlmClient(options: SafeHttpLlmClientOptions): LlmClient;
export declare function summaryRequestBody(input: ArtifactSummaryInput, text: string, model: string | null): Record<string, unknown>;
export declare function truncateUtf8Safe(text: string, maxBytes: number): string;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
export declare function validateHeaderValue(name: string, value: string): void;
export declare function validateLlmEndpoint(endpoint: string): void;

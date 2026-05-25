import { isIP } from "node:net";
export function createSafeHttpLlmClient(options) {
    validateLlmEndpoint(options.endpoint);
    const apiKey = options.apiKey ?? process.env.OPENCLAW_LLM_API_KEY ?? null;
    if (apiKey)
        validateHeaderValue("OPENCLAW_LLM_API_KEY", apiKey);
    const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    if (apiKey && options.endpoint.startsWith("http://")) {
        warn("Warning: OPENCLAW_LLM_API_KEY will be sent over plain HTTP. Set HTTPS endpoint or unset key.");
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        summarizeArtifact: async (input) => {
            const timeoutMs = options.timeoutMs ?? numberEnv("OPENCLAW_LLM_TIMEOUT_MS", 30_000);
            const maxBytes = options.maxBytes ?? numberEnv("OPENCLAW_LLM_MAX_BYTES", 64 * 1024);
            const text = truncateUtf8Safe(input.text, maxBytes);
            for (let attempt = 1; attempt <= 2; attempt += 1) {
                const abort = new AbortController();
                const timer = setTimeout(() => abort.abort(), timeoutMs);
                try {
                    const response = await fetchImpl(options.endpoint, {
                        method: "POST",
                        signal: abort.signal,
                        headers: {
                            "content-type": "application/json",
                            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
                        },
                        body: JSON.stringify(summaryRequestBody(input, text, options.model ?? process.env.OPENCLAW_LLM_MODEL ?? null))
                    });
                    if (!response.ok) {
                        if (response.status >= 500 && attempt < 2)
                            continue;
                        throw new Error(`OpenClaw LLM summary request failed with HTTP ${response.status}`);
                    }
                    return JSON.parse(await withTimeout(response.text(), timeoutMs, "OpenClaw LLM response body timed out"));
                }
                finally {
                    clearTimeout(timer);
                }
            }
            return null;
        }
    };
}
export function summaryRequestBody(input, text, model) {
    return {
        task: "openclaw.trajectory.artifact_summary",
        model,
        kind: input.kind,
        mime_type: input.mimeType,
        size_class: input.sizeClass,
        text
    };
}
export function truncateUtf8Safe(text, maxBytes) {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= maxBytes)
        return text;
    let end = Math.max(0, maxBytes);
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
        end -= 1;
    }
    return `${bytes.subarray(0, end).toString("utf8")} ...[truncated]`;
}
export function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
export function validateHeaderValue(name, value) {
    if (/[\r\n\0]/.test(value)) {
        throw new Error(`${name} contains control characters and cannot be used as an HTTP header`);
    }
}
export function validateLlmEndpoint(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
        throw new Error(`Invalid LLM endpoint URL: ${endpoint}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Unsupported LLM endpoint protocol: ${url.protocol}`);
    }
    const allowHosts = new Set(envList("OPENCLAW_LLM_ALLOW_HOSTS"));
    if (allowHosts.has(url.hostname.toLowerCase()))
        return;
    if (isMetadataServiceHost(url.hostname)) {
        throw new Error(`LLM endpoint host ${url.hostname} is blocked. Add it to OPENCLAW_LLM_ALLOW_HOSTS only if this is intentional.`);
    }
    if (isInternalHost(url.hostname)) {
        process.stderr.write(`Warning: LLM endpoint host ${url.hostname} is local or private network scoped.\n`);
    }
}
function numberEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function isMetadataServiceHost(hostname) {
    const host = hostname.toLowerCase();
    return host === "169.254.169.254" || host === "metadata.google.internal";
}
function isInternalHost(hostname) {
    const host = hostname.toLowerCase();
    if (host === "localhost")
        return true;
    const ipVersion = isIP(host);
    if (ipVersion === 4) {
        const [aRaw, bRaw] = host.split(".");
        const a = Number(aRaw);
        const b = Number(bRaw);
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (ipVersion === 6) {
        return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
    }
    return false;
}
function envList(name) {
    return (process.env[name] ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}
//# sourceMappingURL=http-llm.js.map
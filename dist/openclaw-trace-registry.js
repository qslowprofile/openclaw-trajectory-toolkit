import { createHash } from "node:crypto";
export class OpenClawTraceRegistry {
    options;
    runIdToTraceId = new Map();
    weakAliasToTraceIds = new Map();
    traceIdToWeakAliases = new Map();
    pendingIngressBySession = new Map();
    pendingIngressByFingerprint = new Map();
    pendingIngressByRoute = new Map();
    recentlyEndedByWeakAlias = new Map();
    pendingEndTraceIds = new Set();
    constructor(options) {
        this.options = options;
    }
    prebindMessage(event, ctx) {
        this.prune();
        const fingerprint = ingressFingerprint(event, ctx);
        const routeKey = routeKeyFromMessage(ctx);
        const aliases = collectAliases(event, ctx);
        const existing = (fingerprint ? this.pendingIngressByFingerprint.get(fingerprint)?.[0]?.traceId : undefined) ??
            (routeKey ? this.pendingIngressByRoute.get(routeKey)?.[0]?.traceId : undefined) ??
            this.resolveByWeakAliases(Object.values(aliases).filter((value) => typeof value === "string"));
        if (existing) {
            return {
                traceId: existing,
                ...(fingerprint ? { fingerprint } : {}),
                ...(routeKey ? { routeKey } : {}),
                mode: fingerprint ? "fingerprint_reuse" : "alias_reuse"
            };
        }
        const traceId = newTraceIdFromParts("ingress", fingerprint ?? routeKey ?? stableString(event), String(this.options.now()));
        const entry = {
            traceId,
            createdAtMs: this.options.now(),
            ...(fingerprint ? { fingerprint } : {}),
            ...(routeKey ? { routeKey } : {})
        };
        if (aliases.sessionKey)
            pushQueue(this.pendingIngressBySession, aliases.sessionKey, entry);
        if (aliases.sessionId)
            pushQueue(this.pendingIngressBySession, aliases.sessionId, entry);
        if (fingerprint)
            pushQueue(this.pendingIngressByFingerprint, fingerprint, entry);
        if (routeKey)
            pushQueue(this.pendingIngressByRoute, routeKey, entry);
        return {
            traceId,
            ...(fingerprint ? { fingerprint } : {}),
            ...(routeKey ? { routeKey } : {}),
            mode: "prebound_new"
        };
    }
    startOrAttachRun(event, ctx) {
        this.prune();
        const aliases = collectAliases(event, ctx);
        if (aliases.runId) {
            const strong = this.runIdToTraceId.get(aliases.runId);
            if (strong) {
                this.registerAliases(strong, aliases);
                return { traceId: strong, mode: "runId_reuse" };
            }
        }
        const weak = this.resolveByWeakAliases([aliases.sessionKey, aliases.sessionId].filter((value) => typeof value === "string"));
        if (weak) {
            this.registerAliases(weak, aliases);
            return { traceId: weak, mode: "weak_alias_reuse" };
        }
        const routeKey = routeKeyFromRunContext(ctx);
        const pending = (aliases.sessionKey ? this.consumePending(aliases.sessionKey, this.pendingIngressBySession) : undefined) ??
            (aliases.sessionId ? this.consumePending(aliases.sessionId, this.pendingIngressBySession) : undefined) ??
            (routeKey ? this.consumePending(routeKey, this.pendingIngressByRoute) : undefined);
        if (pending) {
            this.registerAliases(pending.traceId, aliases);
            return {
                traceId: pending.traceId,
                mode: "prebound_inherit",
                ...(pending.fingerprint ? { ingressFingerprint: pending.fingerprint } : {}),
                ...(pending.routeKey ? { ingressRouteKey: pending.routeKey } : {})
            };
        }
        const traceId = newTraceIdFromParts("run", aliases.runId ?? aliases.sessionKey ?? aliases.sessionId ?? stableString(event), String(this.options.now()));
        this.registerAliases(traceId, aliases);
        return { traceId, mode: "run_new_trace" };
    }
    markPendingEnd(event, ctx) {
        const traceId = this.resolveTraceId(event, ctx);
        if (traceId)
            this.pendingEndTraceIds.add(traceId);
    }
    finalizePendingEnd(event, ctx) {
        const traceId = this.resolveTraceId(event, ctx);
        if (traceId && this.pendingEndTraceIds.has(traceId)) {
            this.pendingEndTraceIds.delete(traceId);
            this.retainEndedWeakAliases(traceId);
        }
    }
    resolveTraceId(event, ctx) {
        const aliases = collectAliases(event, ctx);
        if (aliases.runId && this.runIdToTraceId.has(aliases.runId))
            return this.runIdToTraceId.get(aliases.runId) ?? null;
        const weak = this.resolveByWeakAliases([aliases.sessionKey, aliases.sessionId].filter((value) => typeof value === "string"));
        if (weak)
            return weak;
        return this.resolveRecentlyEnded([aliases.sessionKey, aliases.sessionId].filter((value) => typeof value === "string"));
    }
    registerAliases(traceId, aliases) {
        if (aliases.runId)
            this.runIdToTraceId.set(aliases.runId, traceId);
        for (const alias of [aliases.sessionKey, aliases.sessionId]) {
            if (!alias)
                continue;
            let candidates = this.weakAliasToTraceIds.get(alias);
            if (!candidates) {
                candidates = new Set();
                this.weakAliasToTraceIds.set(alias, candidates);
            }
            candidates.add(traceId);
            let weakAliases = this.traceIdToWeakAliases.get(traceId);
            if (!weakAliases) {
                weakAliases = new Set();
                this.traceIdToWeakAliases.set(traceId, weakAliases);
            }
            weakAliases.add(alias);
        }
    }
    resolveByWeakAliases(aliases) {
        let intersection = null;
        for (const alias of aliases) {
            const candidates = this.weakAliasToTraceIds.get(alias);
            if (!candidates?.size)
                continue;
            if (intersection === null) {
                intersection = new Set(candidates);
            }
            else {
                const next = new Set();
                for (const candidate of intersection) {
                    if (candidates.has(candidate))
                        next.add(candidate);
                }
                intersection = next;
            }
        }
        return intersection?.size === 1 ? [...intersection][0] : undefined;
    }
    consumePending(key, map) {
        const queue = map.get(key);
        const entry = queue?.shift();
        if (!queue?.length)
            map.delete(key);
        if (entry)
            this.removePending(entry);
        return entry;
    }
    removePending(entry) {
        for (const queue of this.pendingIngressBySession.values())
            removeFromQueue(queue, entry);
        if (entry.fingerprint)
            removeFromQueue(this.pendingIngressByFingerprint.get(entry.fingerprint), entry);
        if (entry.routeKey)
            removeFromQueue(this.pendingIngressByRoute.get(entry.routeKey), entry);
    }
    retainEndedWeakAliases(traceId) {
        const aliases = this.traceIdToWeakAliases.get(traceId);
        if (!aliases)
            return;
        const expiresAtMs = this.options.now() + (this.options.weakAliasRetentionMs ?? 5_000);
        for (const alias of aliases) {
            this.recentlyEndedByWeakAlias.set(alias, { traceId, expiresAtMs });
        }
    }
    resolveRecentlyEnded(aliases) {
        for (const alias of aliases) {
            const entry = this.recentlyEndedByWeakAlias.get(alias);
            if (!entry)
                continue;
            if (entry.expiresAtMs < this.options.now()) {
                this.recentlyEndedByWeakAlias.delete(alias);
                continue;
            }
            return entry.traceId;
        }
        return null;
    }
    prune() {
        const ttl = this.options.pendingIngressTtlMs ?? 60_000;
        const expired = (entry) => this.options.now() - entry.createdAtMs > ttl;
        for (const map of [this.pendingIngressBySession, this.pendingIngressByFingerprint, this.pendingIngressByRoute]) {
            for (const [key, queue] of map.entries()) {
                const kept = queue.filter((entry) => !expired(entry));
                if (kept.length === 0)
                    map.delete(key);
                else
                    map.set(key, kept);
            }
        }
    }
}
function collectAliases(event, ctx) {
    return {
        ...(stringFrom(event.runId ?? ctx.runId) ? { runId: stringFrom(event.runId ?? ctx.runId) } : {}),
        ...(stringFrom(event.sessionKey ?? ctx.sessionKey) ? { sessionKey: stringFrom(event.sessionKey ?? ctx.sessionKey) } : {}),
        ...(stringFrom(event.sessionId ?? ctx.sessionId) ? { sessionId: stringFrom(event.sessionId ?? ctx.sessionId) } : {})
    };
}
function ingressFingerprint(event, ctx) {
    const content = stringFrom(event.content)?.replaceAll(/\s+/g, " ").trim().slice(0, 512);
    const parts = [ctx.channelId, ctx.accountId, ctx.conversationId, event.from, content, event.timestamp ?? event.eventAt].map((value) => String(value ?? ""));
    if (!parts.some((part) => part.length > 0))
        return undefined;
    return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}
function routeKeyFromMessage(ctx) {
    return routeKey(stringFrom(ctx.channelId), stringFrom(ctx.conversationId));
}
function routeKeyFromRunContext(ctx) {
    return routeKey(stringFrom(ctx.channelId), peerFromSessionKey(stringFrom(ctx.sessionKey)));
}
function routeKey(channelId, peer) {
    const channel = channelId?.toLowerCase();
    const normalizedPeer = peer?.replace(/^(user|chat|mis|wecom):/i, "").replace(/^(single_|group_)/i, "").toLowerCase();
    return channel && normalizedPeer ? `${channel}::${normalizedPeer}` : undefined;
}
function peerFromSessionKey(sessionKey) {
    if (!sessionKey)
        return null;
    const segments = sessionKey.split(":");
    for (let index = segments.length - 2; index >= 2; index -= 1) {
        const token = segments[index]?.toLowerCase();
        if (token === "direct" || token === "group" || token === "channel")
            return segments[index + 1] ?? null;
    }
    return null;
}
function pushQueue(map, key, entry) {
    const queue = map.get(key) ?? [];
    queue.push(entry);
    map.set(key, queue);
}
function removeFromQueue(queue, entry) {
    if (!queue)
        return;
    const index = queue.indexOf(entry);
    if (index >= 0)
        queue.splice(index, 1);
}
function newTraceIdFromParts(...parts) {
    return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
}
function stableString(value) {
    return JSON.stringify(value, Object.keys(objectRecord(value)).sort());
}
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringFrom(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
//# sourceMappingURL=openclaw-trace-registry.js.map
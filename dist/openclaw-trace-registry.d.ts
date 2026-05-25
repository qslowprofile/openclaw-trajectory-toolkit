export interface OpenClawTraceAliases {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
}
export interface OpenClawTraceBinding {
    traceId: string;
    mode: "runId_reuse" | "weak_alias_reuse" | "prebound_inherit" | "run_new_trace";
    ingressFingerprint?: string;
    ingressRouteKey?: string;
}
export declare class OpenClawTraceRegistry {
    private readonly options;
    private readonly runIdToTraceId;
    private readonly weakAliasToTraceIds;
    private readonly traceIdToWeakAliases;
    private readonly pendingIngressBySession;
    private readonly pendingIngressByFingerprint;
    private readonly pendingIngressByRoute;
    private readonly recentlyEndedByWeakAlias;
    private readonly pendingEndTraceIds;
    constructor(options: {
        now: () => number;
        pendingIngressTtlMs?: number;
        weakAliasRetentionMs?: number;
    });
    prebindMessage(event: Record<string, unknown>, ctx: Record<string, unknown>): {
        traceId: string;
        fingerprint?: string;
        routeKey?: string;
        mode: "fingerprint_reuse" | "prebound_new" | "alias_reuse";
    };
    startOrAttachRun(event: Record<string, unknown>, ctx: Record<string, unknown>): OpenClawTraceBinding;
    markPendingEnd(event: Record<string, unknown>, ctx: Record<string, unknown>): void;
    finalizePendingEnd(event: Record<string, unknown>, ctx: Record<string, unknown>): void;
    resolveTraceId(event: Record<string, unknown>, ctx: Record<string, unknown>): string | null;
    private registerAliases;
    private resolveByWeakAliases;
    private consumePending;
    private removePending;
    private retainEndedWeakAliases;
    private resolveRecentlyEnded;
    private prune;
}

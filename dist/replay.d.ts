import type { ReplayPlan } from "./types.js";
export type ReplayMode = "read_only" | "mock";
export declare function createReplayPlan(runDir: string, mode?: ReplayMode, options?: {
    write?: boolean;
}): Promise<ReplayPlan>;
export declare function findMissingArtifacts(runDir: string): Promise<string[]>;

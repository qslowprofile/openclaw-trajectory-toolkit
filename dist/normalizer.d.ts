import type { EventPair, OpenClawTrajectory, TrajectoryEvent } from "./types.js";
export type ArtifactInlineMode = "safe" | "inline" | "summary" | "ref";
export type ChildClampMode = "warn" | "root" | "none";
export interface NormalizeOptions {
    artifactMode?: ArtifactInlineMode;
    childClamp?: ChildClampMode;
    inferSpecs?: boolean;
}
export declare function normalizeRun(runDir: string, options?: NormalizeOptions): Promise<OpenClawTrajectory>;
export declare function readEvents(runDir: string): Promise<TrajectoryEvent[]>;
export declare function pairEvents(events: TrajectoryEvent[]): EventPair[];

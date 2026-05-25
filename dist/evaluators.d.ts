import type { EvaluationResult, OpenClawTrajectory } from "./types.js";
export interface EvaluateOptions {
    toolArgsMode?: "strict" | "loose";
}
export declare function evaluateTrajectory(trajectory: OpenClawTrajectory, options?: EvaluateOptions): EvaluationResult[];
export declare function appendEvaluationResults(runDir: string, results: EvaluationResult[]): Promise<void>;
export declare function writeEvaluationResults(runDir: string, results: EvaluationResult[], options?: {
    append?: boolean;
}): Promise<void>;

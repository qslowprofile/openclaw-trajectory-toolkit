import { type OpenClawTrajectoryPluginRegistration, type OpenClawTrajectoryRuntimeLike } from "./plugin.js";
import type { HookManagerStartOptions } from "./hooks.js";
export interface RegisterOpenClawTrajectoryOptions extends Partial<HookManagerStartOptions> {
    runtime?: OpenClawTrajectoryRuntimeLike | null;
}
export declare function registerOpenClawTrajectory(options?: RegisterOpenClawTrajectoryOptions): Promise<OpenClawTrajectoryPluginRegistration>;

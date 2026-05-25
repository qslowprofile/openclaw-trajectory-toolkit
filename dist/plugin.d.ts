import { TrajectoryHookManager, type HookManagerStartOptions } from "./hooks.js";
export interface OpenClawTrajectoryRuntimeLike {
    registerTrajectoryHooks?: (hooks: TrajectoryHookManager) => unknown | Promise<unknown>;
    hooks?: {
        registerTrajectoryHooks?: (hooks: TrajectoryHookManager) => unknown | Promise<unknown>;
    };
}
export interface OpenClawTrajectoryPluginOptions extends HookManagerStartOptions {
    autoNormalizeOnFinalize?: boolean;
}
export interface OpenClawTrajectoryPluginRegistration {
    mode: "native" | "sdk";
    manager: TrajectoryHookManager;
    supported_hooks: string[];
}
export interface OpenClawTrajectoryPlugin {
    name: "openclaw-trajectory";
    version: string;
    supported_hooks: string[];
    setup(runtime?: OpenClawTrajectoryRuntimeLike | null): Promise<OpenClawTrajectoryPluginRegistration>;
}
export declare function createOpenClawTrajectoryPlugin(options: OpenClawTrajectoryPluginOptions): OpenClawTrajectoryPlugin;

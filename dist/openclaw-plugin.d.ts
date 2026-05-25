import { type OpenClawPluginApiLike } from "./openclaw-native.js";
export { OpenClawNativeTrajectoryCollector, registerOpenClawNativeTrajectory } from "./openclaw-native.js";
export type { DiagnosticSubscription, OpenClawNativeCollectorOptions, OpenClawPluginApiLike } from "./openclaw-native.js";
export default function register(api: OpenClawPluginApiLike): void;

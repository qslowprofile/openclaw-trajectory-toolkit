export interface OpenClawPluginInstallRecord {
    pluginId: string;
    installPath?: string;
    enabled?: boolean;
    source: string;
    sourcePath: string;
    raw: Record<string, unknown>;
}
export interface OpenClawPluginRegistryRead {
    openclawHome: string;
    openclawConfigPath: string;
    installsPath: string;
    records: OpenClawPluginInstallRecord[];
}
export declare function readOpenClawPluginRegistry(openclawHome: string, pluginId?: string): Promise<OpenClawPluginRegistryRead>;
export declare function findOpenClawPluginInstallRecord(openclawHome: string, pluginId?: string): Promise<OpenClawPluginInstallRecord | null>;
export declare function sameInstallPath(left: string, right: string): Promise<boolean>;

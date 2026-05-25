import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
export async function readOpenClawPluginRegistry(openclawHome, pluginId = "openclaw-trajectory") {
    const runtimeHome = resolve(openclawHome);
    const openclawConfigPath = join(runtimeHome, ".openclaw", "openclaw.json");
    const installsPath = join(runtimeHome, ".openclaw", "plugins", "installs.json");
    const records = [];
    const openclawConfig = await readJsonRecord(openclawConfigPath);
    const installs = await readJsonUnknown(installsPath);
    records.push(...recordsFromContainer({
        value: objectValue(objectValue(openclawConfig?.plugins)?.installs),
        pluginId,
        source: "openclaw.json.plugins.installs",
        sourcePath: openclawConfigPath
    }));
    records.push(...recordsFromContainer({
        value: objectValue(objectValue(installs)?.installRecords),
        pluginId,
        source: "plugins/installs.json.installRecords",
        sourcePath: installsPath
    }));
    records.push(...recordsFromContainer({
        value: objectValue(objectValue(installs)?.installs),
        pluginId,
        source: "plugins/installs.json.installs",
        sourcePath: installsPath
    }));
    records.push(...recordsFromContainer({
        value: installs,
        pluginId,
        source: "plugins/installs.json",
        sourcePath: installsPath
    }));
    return {
        openclawHome: runtimeHome,
        openclawConfigPath,
        installsPath,
        records: dedupeRecords(records)
    };
}
export async function findOpenClawPluginInstallRecord(openclawHome, pluginId = "openclaw-trajectory") {
    const registry = await readOpenClawPluginRegistry(openclawHome, pluginId);
    return registry.records[0] ?? null;
}
export async function sameInstallPath(left, right) {
    const leftPath = await canonicalPath(left);
    const rightPath = await canonicalPath(right);
    return leftPath === rightPath;
}
async function canonicalPath(path) {
    return realpath(path).catch(() => resolve(path));
}
function recordsFromContainer(options) {
    const value = options.value;
    const records = [];
    if (!value)
        return records;
    if (Array.isArray(value)) {
        for (const item of value) {
            const record = objectValue(item);
            if (record && recordMatches(record, options.pluginId)) {
                records.push(normalizeInstallRecord(options.pluginId, record, options.source, options.sourcePath));
            }
        }
        return records;
    }
    const object = objectValue(value);
    if (!object)
        return records;
    const direct = objectValue(object[options.pluginId]);
    if (direct) {
        records.push(normalizeInstallRecord(options.pluginId, direct, options.source, options.sourcePath));
    }
    for (const [key, item] of Object.entries(object)) {
        if (key === options.pluginId)
            continue;
        const record = objectValue(item);
        if (record && recordMatches(record, options.pluginId)) {
            records.push(normalizeInstallRecord(options.pluginId, record, options.source, options.sourcePath));
        }
    }
    if (recordMatches(object, options.pluginId)) {
        records.push(normalizeInstallRecord(options.pluginId, object, options.source, options.sourcePath));
    }
    return records;
}
function normalizeInstallRecord(pluginId, record, source, sourcePath) {
    const installPath = firstString(record.installPath, record.install_path, record.path, record.linkPath, record.link_path);
    return {
        pluginId,
        ...(installPath ? { installPath } : {}),
        ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
        source,
        sourcePath,
        raw: record
    };
}
function recordMatches(record, pluginId) {
    return [record.id, record.name, record.pluginId, record.plugin_id, record.packageName].some((value) => value === pluginId);
}
function dedupeRecords(records) {
    const seen = new Set();
    const deduped = [];
    for (const record of records) {
        const key = `${record.source}\u001f${record.installPath ?? ""}\u001f${record.enabled ?? ""}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(record);
    }
    return deduped;
}
async function readJsonRecord(path) {
    return objectValue(await readJsonUnknown(path));
}
async function readJsonUnknown(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function firstString(...values) {
    return values.find((value) => typeof value === "string" && value.trim().length > 0);
}
//# sourceMappingURL=openclaw-registry.js.map
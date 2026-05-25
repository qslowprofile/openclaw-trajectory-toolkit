import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
}
export async function createZipFromDirectory(rootDir, outputFile) {
    const files = await collectFiles(rootDir);
    const entries = [];
    const chunks = [];
    let offset = 0;
    for (const file of files) {
        const data = await readFile(file);
        const name = relative(rootDir, file).split(sep).join("/");
        const entry = { name, data, crc32: crc32(data), localOffset: offset };
        const local = localFileHeader(entry);
        chunks.push(local, data);
        offset += local.length + data.length;
        entries.push(entry);
    }
    const centralStart = offset;
    for (const entry of entries) {
        const central = centralDirectoryHeader(entry);
        chunks.push(central);
        offset += central.length;
    }
    const centralSize = offset - centralStart;
    chunks.push(endOfCentralDirectory(entries.length, centralSize, centralStart));
    const archive = Buffer.concat(chunks);
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, archive);
    return { output: outputFile, file_count: entries.length, bytes: archive.length };
}
async function collectFiles(rootDir) {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(path)));
        }
        else if (entry.isFile()) {
            files.push(path);
        }
        else {
            const info = await stat(path).catch(() => null);
            if (info?.isFile())
                files.push(path);
        }
    }
    return files.sort();
}
function localFileHeader(entry) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(entry.crc32, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, name]);
}
function centralDirectoryHeader(entry) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.localOffset, 42);
    return Buffer.concat([header, name]);
}
function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
    const header = Buffer.alloc(22);
    header.writeUInt32LE(0x06054b50, 0);
    header.writeUInt16LE(0, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(entryCount, 8);
    header.writeUInt16LE(entryCount, 10);
    header.writeUInt32LE(centralSize, 12);
    header.writeUInt32LE(centralOffset, 16);
    header.writeUInt16LE(0, 20);
    return header;
}
function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
//# sourceMappingURL=archive.js.map
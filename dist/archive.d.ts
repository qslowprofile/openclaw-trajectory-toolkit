export interface ZipArchiveResult {
    output: string;
    file_count: number;
    bytes: number;
}
export declare function createZipFromDirectory(rootDir: string, outputFile: string): Promise<ZipArchiveResult>;

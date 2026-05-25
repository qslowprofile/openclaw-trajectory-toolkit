#!/usr/bin/env node
export interface CliIO {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    stdin?: () => Promise<string>;
}
export declare function runCli(argv: string[], io?: CliIO): Promise<number>;

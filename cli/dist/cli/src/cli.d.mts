import type { CliOptions } from "./cli-types.mjs";
export declare class RemoteCli {
    private options;
    private client;
    constructor(options: CliOptions);
    run(): Promise<void>;
    private resolveVeContext;
    private generateTemplate;
    private resolveStack;
    private readParametersFile;
    private processFileUploads;
}

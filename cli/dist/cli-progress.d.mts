import type { CliApiClient } from "./cli-api-client.mjs";
export interface ProgressOptions {
    quiet?: boolean;
    json?: boolean;
    verbose?: boolean;
    timeout: number;
}
export declare class CliProgress {
    private client;
    private veContext;
    private options;
    private seenMessages;
    private startTime;
    constructor(client: CliApiClient, veContext: string, options: ProgressOptions);
    poll(): Promise<{
        vmId?: number;
        success: boolean;
    }>;
    private renderMessage;
}

export interface CliOptions {
    server: string;
    ve: string;
    application: string;
    task: string;
    parametersFile?: string;
    token?: string;
    insecure?: boolean;
    generateTemplate?: boolean;
    templateOutput?: string;
    quiet?: boolean;
    json?: boolean;
    verbose?: boolean;
    timeout: number;
    enableAddons?: string[];
    disableAddons?: string[];
}
export declare class CliError extends Error {
    exitCode: number;
    constructor(message: string, exitCode: number);
}
export declare class ConnectionError extends CliError {
    constructor(message: string);
}
export declare class AuthenticationError extends CliError {
    constructor(message: string);
}
export declare class NotFoundError extends CliError {
    constructor(message: string);
}
export declare class ApiError extends CliError {
    constructor(message: string);
}
export declare class ValidationCliError extends CliError {
    constructor(message: string);
}
export declare class TimeoutError extends CliError {
    constructor(message: string);
}
export declare class ExecutionFailedError extends CliError {
    constructor(message: string);
}

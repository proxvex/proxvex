export class CliError extends Error {
    exitCode;
    constructor(message, exitCode) {
        super(message);
        this.exitCode = exitCode;
        this.name = "CliError";
    }
}
export class ConnectionError extends CliError {
    constructor(message) {
        super(message, 2);
        this.name = "ConnectionError";
    }
}
export class AuthenticationError extends CliError {
    constructor(message) {
        super(message, 3);
        this.name = "AuthenticationError";
    }
}
export class NotFoundError extends CliError {
    constructor(message) {
        super(message, 4);
        this.name = "NotFoundError";
    }
}
export class ApiError extends CliError {
    constructor(message) {
        super(message, 5);
        this.name = "ApiError";
    }
}
export class ValidationCliError extends CliError {
    constructor(message) {
        super(message, 6);
        this.name = "ValidationCliError";
    }
}
export class TimeoutError extends CliError {
    constructor(message) {
        super(message, 7);
        this.name = "TimeoutError";
    }
}
export class ExecutionFailedError extends CliError {
    constructor(message) {
        super(message, 8);
        this.name = "ExecutionFailedError";
    }
}
//# sourceMappingURL=cli-types.mjs.map
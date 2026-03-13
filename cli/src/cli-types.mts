export interface CliOptions {
  server: string;
  ve: string;
  application?: string;
  task?: string;
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
  fixturePath?: string;
  oidcCredentials?: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
  };
}

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class ConnectionError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ConnectionError";
  }
}

export class AuthenticationError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends CliError {
  constructor(message: string) {
    super(message, 4);
    this.name = "NotFoundError";
  }
}

export class ApiError extends CliError {
  constructor(message: string) {
    super(message, 5);
    this.name = "ApiError";
  }
}

export class ValidationCliError extends CliError {
  constructor(message: string) {
    super(message, 6);
    this.name = "ValidationCliError";
  }
}

export class TimeoutError extends CliError {
  constructor(message: string) {
    super(message, 7);
    this.name = "TimeoutError";
  }
}

export class ExecutionFailedError extends CliError {
  constructor(message: string) {
    super(message, 8);
    this.name = "ExecutionFailedError";
  }
}

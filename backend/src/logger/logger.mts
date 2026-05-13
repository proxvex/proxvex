import winston from "winston";

export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Per-line callback that receives every log line regardless of the
 * `shouldLogDebug()` component filter. Used by the DebugCollector to assemble
 * the per-task debug bundle.
 */
export type DebugSink = (entry: {
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
  meta?: Record<string, unknown>;
}) => void;

interface LoggerState {
  level: LogLevel;
  debugComponents: Set<string>;
  debugSink: DebugSink | null;
}

// Singleton configuration state
const state: LoggerState = {
  level: (process.env.LOG_LEVEL as LogLevel) || "info",
  debugComponents: new Set<string>(
    (process.env.DEBUG_COMPONENTS || "").split(",").filter(Boolean),
  ),
  debugSink: null,
};

// Console format: human-readable with timestamps
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
    const comp = component ? `[${component}]` : "";
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level} ${comp} ${message}${metaStr}`;
  }),
);

// Create the base Winston logger (console only)
const baseLogger = winston.createLogger({
  level: state.level,
  transports: [new winston.transports.Console({ format: consoleFormat })],
});

/**
 * Logger class with component-based debug filtering.
 *
 * Usage:
 * ```typescript
 * import { createLogger } from './logger/index.mjs';
 * const logger = createLogger('execution');
 *
 * logger.info('Starting execution');
 * logger.debug('Detailed info', { host: 'example.com' });
 * logger.error('Something failed', { error: err.message });
 * ```
 */
export class Logger {
  constructor(private component: string) {}

  /**
   * Check if debug logging is enabled for this component.
   * Debug logs only appear if the component is in DEBUG_COMPONENTS or '*' is set.
   */
  private shouldLogDebug(): boolean {
    return (
      state.debugComponents.has(this.component) ||
      state.debugComponents.has("*")
    );
  }

  private sink(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const fn = state.debugSink;
    if (fn) {
      try {
        fn({
          ts: Date.now(),
          level,
          component: this.component,
          message,
          ...(meta ? { meta } : {}),
        });
      } catch {
        /* sink errors must never break logging */
      }
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    baseLogger.error({ message, component: this.component, ...meta });
    this.sink("error", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    baseLogger.warn({ message, component: this.component, ...meta });
    this.sink("warn", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    baseLogger.info({ message, component: this.component, ...meta });
    this.sink("info", message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLogDebug()) {
      baseLogger.debug({ message, component: this.component, ...meta });
    }
    // Sink bypasses the shouldLogDebug filter so the debug bundle is complete
    // even when DEBUG_COMPONENTS does not include this component.
    this.sink("debug", message, meta);
  }

  // Static methods for runtime configuration

  /**
   * Set the global log level at runtime.
   */
  static setLevel(level: LogLevel): void {
    state.level = level;
    baseLogger.level = level;
  }

  /**
   * Get the current log level.
   */
  static getLevel(): LogLevel {
    return state.level;
  }

  /**
   * Enable debug logging for a specific component.
   */
  static enableDebugComponent(component: string): void {
    state.debugComponents.add(component);
  }

  /**
   * Disable debug logging for a specific component.
   */
  static disableDebugComponent(component: string): void {
    state.debugComponents.delete(component);
  }

  /**
   * Get all currently enabled debug components.
   */
  static getDebugComponents(): string[] {
    return Array.from(state.debugComponents);
  }

  /**
   * Set the debug components (replaces all existing).
   */
  static setDebugComponents(components: string[]): void {
    state.debugComponents.clear();
    components.forEach((c) => state.debugComponents.add(c));
  }

  /**
   * Register a sink that receives every log line (all levels, no component
   * filter). Pass `null` to clear. Designed for the per-task DebugCollector
   * to capture the full backend log stream into the debug bundle.
   *
   * Only one sink can be active at a time; the assumption is that the UI
   * runs at most one task at a time. For concurrent tasks, layer an
   * AsyncLocalStorage-aware sink that filters by current restartKey.
   */
  static setDebugSink(sink: DebugSink | null): void {
    state.debugSink = sink;
  }

  static getDebugSink(): DebugSink | null {
    return state.debugSink;
  }
}

/**
 * Factory function for creating component-specific loggers.
 */
export function createLogger(component: string): Logger {
  return new Logger(component);
}

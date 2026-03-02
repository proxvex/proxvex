import express from "express";
import { Logger, type LogLevel } from "../logger/index.mjs";
import { ApiUri } from "../types.mjs";

const validLevels: LogLevel[] = ["error", "warn", "info", "debug"];

/**
 * Register logger configuration routes.
 *
 * All endpoints use GET for easy access via browser or curl:
 *
 * - GET /api/logger/config - Get current config
 * - GET /api/logger/level/:level - Set log level
 * - GET /api/logger/debug-components?components=ssh,execution - Set debug components
 */
export function registerLoggerRoutes(app: express.Application): void {
  // GET /api/logger/config - Get current logger configuration
  app.get(ApiUri.LoggerConfig, (_req, res) => {
    res.json({
      level: Logger.getLevel(),
      debugComponents: Logger.getDebugComponents(),
      availableLevels: validLevels,
    });
  });

  // GET /api/logger/level/:level - Set log level
  // Example: curl http://localhost:3080/api/logger/level/debug
  app.get(ApiUri.LoggerLevel, (req, res) => {
    const { level } = req.params;

    if (!validLevels.includes(level as LogLevel)) {
      res.status(400).json({
        error: `Invalid log level: ${level}`,
        validLevels,
      });
      return;
    }

    Logger.setLevel(level as LogLevel);
    res.json({
      success: true,
      level: Logger.getLevel(),
    });
  });

  // GET /api/logger/debug-components?components=ssh,execution
  // Example: curl "http://localhost:3080/api/logger/debug-components?components=ssh,execution"
  // Without components parameter: disable all debug components
  app.get(ApiUri.LoggerDebugComponents, (req, res) => {
    const componentsParam = req.query.components as string | undefined;
    const components = componentsParam
      ? componentsParam.split(",").filter(Boolean)
      : [];

    Logger.setDebugComponents(components);
    res.json({
      success: true,
      debugComponents: Logger.getDebugComponents(),
    });
  });
}

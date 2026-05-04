import express from "express";
import { ApiUri, IVeLogsResponse } from "../types.mjs";
import { IVEContext } from "../backend-types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeLogsService } from "../ve-execution/ve-logs-service.mjs";

/**
 * Registers VE log-related API routes.
 * Provides hostname lookup, console logs, and docker logs endpoints.
 */
export function registerVeLogsRoutes(app: express.Application): void {
  const pm = PersistenceManager.getInstance();

  // GET /api/:veContext/ve/logs/:vmId/hostname - Get container hostname
  app.get<{ vmId: string; veContext: string }>(
    ApiUri.VeLogsHostname,
    async (req, res) => {
      const { vmId: vmIdStr, veContext: veContextKey } = req.params;

      const vmId = parseInt(vmIdStr, 10);
      if (isNaN(vmId) || vmId <= 0) {
        res.status(400).json({ hostname: null, error: "Invalid VM ID" });
        return;
      }

      // Try to get VE context from storage, or derive from key (ve_hostname -> hostname)
      const storageContext = pm.getContextManager();
      const storedContext = storageContext.getVEContextByKey(veContextKey);
      let veContext: IVEContext;
      if (storedContext) {
        veContext = storedContext;
      } else if (veContextKey.startsWith("ve_")) {
        // Extract host from key format: ve_hostname -> hostname
        const host = veContextKey.substring(3);
        veContext = { host, port: 22 } as IVEContext;
      } else {
        res
          .status(404)
          .json({ hostname: null, error: "Invalid VE context key format" });
        return;
      }

      try {
        const logsService = new VeLogsService(veContext);
        const hostname = await logsService.getHostnameForVm(vmId);
        res.json({ hostname: hostname || null });
      } catch {
        res.json({ hostname: null });
      }
    },
  );

  // GET /api/ve/logs/:vmId/:veContext - LXC Console Logs
  app.get<
    { vmId: string; veContext: string },
    unknown,
    unknown,
    { lines?: string }
  >(ApiUri.VeLogs, async (req, res) => {
    const { vmId: vmIdStr, veContext: veContextKey } = req.params;
    const linesStr = req.query.lines;

    // Validate vmId
    const vmId = parseInt(vmIdStr, 10);
    if (isNaN(vmId) || vmId <= 0) {
      res.status(400).json({
        success: false,
        error: "Invalid VM ID",
      });
      return;
    }

    // Get VE context
    const storageContext = pm.getContextManager();
    const veContext = storageContext.getVEContextByKey(veContextKey);
    if (!veContext) {
      res.status(404).json({
        success: false,
        error: "VE context not found",
      });
      return;
    }

    // Create log service and fetch logs
    const logsService = new VeLogsService(veContext);
    const logOptions: { vmId: number; lines?: number } = { vmId };
    if (linesStr) {
      logOptions.lines = parseInt(linesStr, 10);
    }
    const result = await logsService.getConsoleLogs(logOptions);

    // Content negotiation: return HTML for browsers, JSON for API clients
    const acceptHeader = req.headers.accept || "";
    if (acceptHeader.includes("text/html")) {
      const logContent =
        result.success && result.content
          ? result.content
          : result.error || "No logs available";
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Logs - CT ${vmId}</title>
  <style>
    body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 20px; }
    h1 { color: #569cd6; margin-bottom: 10px; }
    .meta { color: #808080; margin-bottom: 20px; }
    pre { white-space: pre-wrap; word-wrap: break-word; background: #252526; padding: 15px; border-radius: 4px; overflow-x: auto; }
    .error { color: #f44747; }
  </style>
</head>
<body>
  <h1>Logs - CT ${vmId}</h1>
  <div class="meta">VE: ${veContextKey} | Lines: ${result.lines || "N/A"}</div>
  <pre${result.success ? "" : ' class="error"'}>${logContent.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
</body>
</html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(result.success ? 200 : 400).send(html);
      return;
    }

    res
      .status(result.success ? 200 : 400)
      .json(result as IVeLogsResponse);
  });

  // GET /api/:veContext/ve/logs/:vmId/docker/services — Docker compose service list
  app.get<{ vmId: string; veContext: string }>(
    ApiUri.VeDockerServices,
    async (req, res) => {
      const { vmId: vmIdStr, veContext: veContextKey } = req.params;
      const vmId = parseInt(vmIdStr, 10);
      if (isNaN(vmId) || vmId <= 0) {
        res.status(400).json({ services: [], error: "Invalid VM ID" });
        return;
      }
      const storageContext = pm.getContextManager();
      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ services: [], error: "VE context not found" });
        return;
      }
      try {
        const logsService = new VeLogsService(veContext);
        const services = await logsService.listDockerServices(vmId);
        res.json({ services });
      } catch {
        res.json({ services: [] });
      }
    },
  );

  // GET /api/ve/logs/:vmId/docker/:veContext - Docker Logs
  app.get<
    { vmId: string; veContext: string },
    unknown,
    unknown,
    { lines?: string; service?: string }
  >(ApiUri.VeDockerLogs, async (req, res) => {
    const { vmId: vmIdStr, veContext: veContextKey } = req.params;
    const { lines: linesStr, service } = req.query;

    // Validate vmId
    const vmId = parseInt(vmIdStr, 10);
    if (isNaN(vmId) || vmId <= 0) {
      res.status(400).json({
        success: false,
        error: "Invalid VM ID",
      });
      return;
    }

    // Get VE context
    const storageContext = pm.getContextManager();
    const veContext = storageContext.getVEContextByKey(veContextKey);
    if (!veContext) {
      res.status(404).json({
        success: false,
        error: "VE context not found",
      });
      return;
    }

    // Create log service and fetch logs
    const logsService = new VeLogsService(veContext);
    const logOptions: { vmId: number; lines?: number; service?: string } = {
      vmId,
    };
    if (linesStr) {
      logOptions.lines = parseInt(linesStr, 10);
    }
    if (service) {
      logOptions.service = service;
    }
    const result = await logsService.getDockerLogs(logOptions);

    res
      .status(result.success ? 200 : 400)
      .json(result as IVeLogsResponse);
  });
}

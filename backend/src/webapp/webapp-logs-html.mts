import express from "express";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeLogsService } from "../ve-execution/ve-logs-service.mjs";
import { IVEContext } from "../backend-types.mjs";

/**
 * Register HTML log viewer route at /logs/:vmId/:veContext
 * This is a human-readable endpoint for direct browser access (e.g., from Proxmox notes).
 * Auto-detects whether to show docker-compose logs or console logs.
 * Hostname is loaded asynchronously via /api/ve/logs/:vmId/:veContext/hostname (in webapp-ve.mts)
 */
export function registerLogsHtmlRoute(app: express.Application): void {
  const pm = PersistenceManager.getInstance();

  app.get("/logs/:vmId/:veContext", async (req, res) => {
    const { vmId: vmIdStr, veContext: veContextKey } = req.params;
    const linesStr = req.query.lines as string | undefined;

    // Validate vmId
    const vmId = parseInt(vmIdStr, 10);
    if (isNaN(vmId) || vmId <= 0) {
      res
        .status(400)
        .send(renderHtml(vmId, veContextKey, "Invalid VM ID", true));
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
        .send(
          renderHtml(vmId, veContextKey, "Invalid VE context key format", true),
        );
      return;
    }

    // Fetch logs (auto-detects docker-compose vs console)
    const logsService = new VeLogsService(veContext);
    const logOptions: { vmId: number; lines?: number } = { vmId };
    if (linesStr) {
      logOptions.lines = parseInt(linesStr, 10);
    }
    const result = await logsService.getLogs(logOptions);

    const content =
      result.success && result.content
        ? result.content
        : result.error || "No logs available";
    res
      .status(result.success ? 200 : 400)
      .send(
        renderHtml(vmId, veContextKey, content, !result.success, result.lines),
      );
  });
}

function renderHtml(
  vmId: number,
  veContextKey: string,
  content: string,
  isError: boolean,
  lines?: number,
): string {
  const escapedContent = content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
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
  <h1 id="title">Logs - CT ${vmId}</h1>
  <div class="meta">VE: ${veContextKey} | Lines: ${lines || "N/A"}</div>
  <pre${isError ? ' class="error"' : ""}>${escapedContent}</pre>
  <script>
    (async function() {
      try {
        const res = await fetch('/api/ve/logs/${vmId}/${veContextKey}/hostname');
        const data = await res.json();
        if (data.hostname) {
          const title = data.hostname + ' (CT ${vmId})';
          document.getElementById('title').textContent = 'Logs - ' + title;
          document.title = 'Logs - ' + title;
        }
      } catch (e) {
        // Ignore - keep default CT title
      }
    })();
  </script>
</body>
</html>`;
}

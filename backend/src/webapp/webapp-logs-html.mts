import express from "express";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeLogsService } from "../ve-execution/ve-logs-service.mjs";
import { IVEContext } from "../backend-types.mjs";

/**
 * Register HTML log viewer route at /logs/:veContext/:vmId
 * This is a human-readable endpoint for direct browser access (e.g., from Proxmox notes).
 * Auto-detects whether to show docker-compose logs or console logs.
 * Hostname is loaded asynchronously via /api/:veContext/ve/logs/:vmId/hostname (in webapp-ve.mts)
 */
export function registerLogsHtmlRoute(app: express.Application): void {
  const pm = PersistenceManager.getInstance();

  // Legacy redirect: /logs/<number>/<veContext> → /logs/<veContext>/<number>
  // Keeps old links in existing container notes working
  app.get("/logs/:first/:second", (req, res, next) => {
    const { first, second } = req.params;
    // Old format: /logs/105/ve_pve1 (first is numeric vmId)
    // New format: /logs/ve_pve1/105 (first is veContext) — handled below
    if (/^\d+$/.test(first) && !(/^\d+$/.test(second))) {
      res.redirect(301, `/logs/${second}/${first}`);
    } else {
      next();
    }
  });

  app.get("/logs/:veContext/:vmId", async (req, res) => {
    const { vmId: vmIdStr, veContext: veContextKey } = req.params;
    const linesStr = req.query.lines as string | undefined;
    const service = req.query.service as string | undefined;

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

    const logsService = new VeLogsService(veContext);
    const lines = linesStr ? parseInt(linesStr, 10) : undefined;

    // If a specific service is requested, fetch only that service's logs.
    // Otherwise fall back to the auto-detect path (which merges all
    // docker-compose services or returns the LXC console log).
    let result;
    if (service && /^[a-zA-Z0-9_-]+$/.test(service)) {
      const opts: { vmId: number; service: string; lines?: number } = {
        vmId,
        service,
      };
      if (lines !== undefined) opts.lines = lines;
      result = await logsService.getDockerLogs(opts);
    } else {
      const opts: { vmId: number; lines?: number } = { vmId };
      if (lines !== undefined) opts.lines = lines;
      result = await logsService.getLogs(opts);
    }

    const content =
      result.success && result.content
        ? result.content
        : result.error || "No logs available";
    res
      .status(result.success ? 200 : 400)
      .send(
        renderHtml(
          vmId,
          veContextKey,
          content,
          !result.success,
          result.lines,
          service,
        ),
      );
  });
}

function renderHtml(
  vmId: number,
  veContextKey: string,
  content: string,
  isError: boolean,
  lines?: number,
  activeService?: string,
): string {
  const escapedContent = content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const activeJson = activeService ? JSON.stringify(activeService) : "null";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Logs - CT ${vmId}</title>
  <style>
    body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 20px; }
    h1 { color: #569cd6; margin-bottom: 10px; }
    .meta { color: #808080; margin-bottom: 12px; }
    .tabs { display: none; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; border-bottom: 1px solid #3c3c3c; padding-bottom: 6px; }
    .tabs.shown { display: flex; }
    .tab { color: #d4d4d4; text-decoration: none; padding: 6px 14px; border-radius: 4px 4px 0 0; background: #2d2d2d; border: 1px solid transparent; font-size: 13px; }
    .tab:hover { background: #37373d; }
    .tab.active { background: #094771; color: #fff; border-color: #569cd6; }
    pre { white-space: pre-wrap; word-wrap: break-word; background: #252526; padding: 15px; border-radius: 4px; overflow-x: auto; }
    .error { color: #f44747; }
  </style>
</head>
<body>
  <h1 id="title">Logs - CT ${vmId}</h1>
  <div class="meta">VE: ${veContextKey} | Lines: ${lines || "N/A"}</div>
  <div id="tabs" class="tabs"></div>
  <pre${isError ? ' class="error"' : ""}>${escapedContent}</pre>
  <script>
    (async function() {
      const veCtx = ${JSON.stringify(veContextKey)};
      const vmId = ${vmId};
      const activeService = ${activeJson};
      // Hostname title
      try {
        const res = await fetch('/api/' + veCtx + '/ve/logs/' + vmId + '/hostname');
        const data = await res.json();
        if (data.hostname) {
          const title = data.hostname + ' (CT ' + vmId + ')';
          document.getElementById('title').textContent = 'Logs - ' + title;
          document.title = 'Logs - ' + title;
        }
      } catch (e) { /* keep default */ }
      // Render docker-compose service tabs (if any)
      try {
        const res = await fetch('/api/' + veCtx + '/ve/logs/' + vmId + '/docker/services');
        const data = await res.json();
        const services = (data && Array.isArray(data.services)) ? data.services : [];
        if (services.length > 0) {
          const tabs = document.getElementById('tabs');
          const mkTab = (label, href, isActive) => {
            const a = document.createElement('a');
            a.className = 'tab' + (isActive ? ' active' : '');
            a.href = href;
            a.textContent = label;
            return a;
          };
          tabs.appendChild(mkTab('All services', '/logs/' + veCtx + '/' + vmId, !activeService));
          for (const svc of services) {
            const href = '/logs/' + veCtx + '/' + vmId + '?service=' + encodeURIComponent(svc);
            tabs.appendChild(mkTab(svc, href, activeService === svc));
          }
          tabs.classList.add('shown');
        }
      } catch (e) { /* no docker-compose, no tabs */ }
    })();
  </script>
</body>
</html>`;
}

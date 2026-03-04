import express, { RequestHandler } from "express";
import {
  ApiUri,
  IVeConfigurationResponse,
  IVeExecuteMessagesResponse,
  IPostVeConfigurationBody,
  IPostVeCopyUpgradeBody,
  IVeLogsResponse,
  TaskType,
} from "../types.mjs";
import { IVEContext } from "../backend-types.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { WebAppVeRouteHandlers } from "./webapp-ve-route-handlers.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeLogsService } from "../ve-execution/ve-logs-service.mjs";

export class WebAppVE {
  private messageManager: WebAppVeMessageManager;
  private restartManager: WebAppVeRestartManager;
  private parameterProcessor: WebAppVeParameterProcessor;
  private executionSetup: WebAppVeExecutionSetup;
  private routeHandlers: WebAppVeRouteHandlers;
  private pm: PersistenceManager;

  constructor(private app: express.Application) {
    this.pm = PersistenceManager.getInstance();
    this.messageManager = new WebAppVeMessageManager();
    this.restartManager = new WebAppVeRestartManager();
    this.parameterProcessor = new WebAppVeParameterProcessor();
    this.executionSetup = new WebAppVeExecutionSetup();
    this.routeHandlers = new WebAppVeRouteHandlers(
      this.messageManager,
      this.restartManager,
      this.parameterProcessor,
      this.executionSetup,
    );
  }

  /**
   * Exposes messages for GET endpoint (backward compatibility).
   */
  get messages(): IVeExecuteMessagesResponse {
    return this.messageManager.messages;
  }

  private returnResponse<T>(
    res: express.Response,
    payload: T,
    statusCode: number = 200,
  ): void {
    res.status(statusCode).json(payload);
  }

  private post<
    TParams extends Record<string, string>,
    TBody,
    TQuery extends Record<string, string | undefined> = Record<
      string,
      string | undefined
    >,
  >(
    path: string,
    handler: (
      req: express.Request<TParams, unknown, TBody, TQuery>,
      res: express.Response,
    ) => void | Promise<unknown>,
  ): void {
    this.app.post(path, express.json(), handler as unknown as RequestHandler);
  }

  init(): void {
    // POST /api/ve-configuration/:application/:task/:veContext
    this.post<
      { application: string; task: TaskType; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeConfiguration, async (req, res) => {
      const { application, task, veContext: veContextKey } = req.params;

      // Set vmInstallContext in ContextManager for restart support
      // Use changedParams if provided, otherwise fall back to params
      let vmInstallKey: string | undefined;
      const changedParams = req.body?.changedParams;
      const params = req.body?.params;

      // Use changedParams if available and non-empty, otherwise use params
      const paramsToStore =
        changedParams &&
        Array.isArray(changedParams) &&
        changedParams.length > 0
          ? changedParams
          : params && Array.isArray(params)
            ? params
            : [];

      if (paramsToStore.length > 0) {
        const storageContext =
          this.pm.getContextManager();
        const veContext = storageContext.getVEContextByKey(veContextKey);
        if (veContext) {
          const hostname =
            typeof veContext.host === "string"
              ? veContext.host
              : (veContext.host as any)?.host || "unknown";

          // Map params from request
          const mappedParams = paramsToStore.map((p: any) => ({
            name: p.name,
            value: p.value,
          }));

          // Create or update VMInstallContext
          vmInstallKey = storageContext.setVMInstallContext({
            hostname,
            application,
            task: task as TaskType,
            changedParams: mappedParams,
          });
        }
      }

      const result = await this.routeHandlers.handleVeConfiguration(
        application,
        task,
        veContextKey,
        req.body,
      );
      if (result.success && result.restartKey) {
        // Set vmInstallKey in message group if it exists
        if (vmInstallKey) {
          this.messageManager.setVmInstallKeyForGroup(
            application,
            task,
            vmInstallKey,
          );
        }
        const response: IVeConfigurationResponse = {
          success: true,
          restartKey: result.restartKey,
          ...(vmInstallKey && { vmInstallKey }),
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // POST /api/ve/restart-installation/:vmInstallKey/:veContext
    this.post<
      { vmInstallKey: string; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeRestartInstallation, async (req, res) => {
      const { vmInstallKey, veContext: veContextKey } = req.params;
      const result = await this.routeHandlers.handleVeRestartInstallation(
        vmInstallKey,
        veContextKey,
      );
      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = {
          success: true,
          restartKey: result.restartKey,
          ...(result.vmInstallKey && { vmInstallKey: result.vmInstallKey }),
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // GET /api/ve/execute/:veContext
    this.app.get<{ veContext: string }>(ApiUri.VeExecute, (req, res) => {
      const storageContext =
        this.pm.getContextManager();
      const veContext = storageContext.getVEContextByKey(req.params.veContext);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      const messages = this.routeHandlers.handleGetMessages(veContext);
      this.returnResponse<IVeExecuteMessagesResponse>(res, messages);
    });

    // POST /api/ve/restart/:restartKey/:veContext
    this.app.post(ApiUri.VeRestart, express.json(), async (req, res) => {
      const { restartKey, veContext: veContextKey } = req.params;
      const result = await this.routeHandlers.handleVeRestart(
        restartKey,
        veContextKey,
      );
      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = {
          success: true,
          restartKey: result.restartKey,
          ...(result.vmInstallKey && { vmInstallKey: result.vmInstallKey }),
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // POST /api/ve/copy-upgrade/:application/:veContext
    // Starts the application "copy-upgrade" task (per application.schema.json) without persisting a VMInstallContext.
    this.post<
      { application: string; veContext: string },
      IPostVeCopyUpgradeBody
    >(ApiUri.VeCopyUpgrade, async (req, res) => {
      const { application, veContext: veContextKey } = req.params;
      const body = req.body;

      // Minimal validation for required copy-upgrade fields
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "Invalid body" });
        return;
      }
      if (!body.oci_image || typeof body.oci_image !== "string") {
        res.status(400).json({ success: false, error: "Missing oci_image" });
        return;
      }
      if (
        body.source_vm_id === undefined ||
        body.source_vm_id === null ||
        typeof body.source_vm_id !== "number"
      ) {
        res.status(400).json({ success: false, error: "Missing source_vm_id" });
        return;
      }

      const params: { name: string; value: any }[] = [];
      const add = (name: string, value: any) => {
        if (value === undefined || value === null) return;
        if (typeof value === "string" && value.trim() === "") return;
        params.push({ name, value });
      };

      add("oci_image", body.oci_image);
      add("source_vm_id", body.source_vm_id);
      add("vm_id", body.vm_id);
      add("disk_size", body.disk_size);
      add("bridge", body.bridge);
      add("memory", body.memory);
      add("storage", body.storage);
      add("registry_username", body.registry_username);
      add("registry_password", body.registry_password);
      add("registry_token", body.registry_token);
      add("platform", body.platform);
      add("application_id", body.application_id);
      add("application_name", body.application_name);
      add("version", body.version);

      const configBody: any = { params };
      if (
        Array.isArray(body.selectedAddons) &&
        body.selectedAddons.length > 0
      ) {
        configBody.selectedAddons = body.selectedAddons;
      }

      const result = await this.routeHandlers.handleVeConfiguration(
        application,
        "copy-upgrade",
        veContextKey,
        configBody as IPostVeConfigurationBody,
      );

      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = {
          success: true,
          restartKey: result.restartKey,
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // GET /api/ve/logs/:vmId/:veContext/hostname - Get container hostname
    // IMPORTANT: Must be registered BEFORE VeLogs to avoid :veContext matching "hostname"
    this.app.get<{ vmId: string; veContext: string }>(
      ApiUri.VeLogsHostname,
      async (req, res) => {
        const { vmId: vmIdStr, veContext: veContextKey } = req.params;

        const vmId = parseInt(vmIdStr, 10);
        if (isNaN(vmId) || vmId <= 0) {
          res.status(400).json({ hostname: null, error: "Invalid VM ID" });
          return;
        }

        // Try to get VE context from storage, or derive from key (ve_hostname -> hostname)
        const storageContext =
          this.pm.getContextManager();
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
    this.app.get<
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
      const storageContext =
        this.pm.getContextManager();
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

      this.returnResponse<IVeLogsResponse>(
        res,
        result,
        result.success ? 200 : 400,
      );
    });

    // GET /api/ve/logs/:vmId/docker/:veContext - Docker Logs
    this.app.get<
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
      const storageContext =
        this.pm.getContextManager();
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

      this.returnResponse<IVeLogsResponse>(
        res,
        result,
        result.success ? 200 : 400,
      );
    });
  }
}

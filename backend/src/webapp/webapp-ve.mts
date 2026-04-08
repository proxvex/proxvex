import express, { RequestHandler } from "express";
import {
  ApiUri,
  IVeConfigurationResponse,
  IVeExecuteMessage,
  IVeExecuteMessagesResponse,
  IPostVeConfigurationBody,
  TaskType,
} from "../types.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { WebAppVeRouteHandlers } from "./webapp-ve-route-handlers.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { registerVeLogsRoutes } from "./webapp-ve-logs-routes.mjs";

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
    // POST /api/ve-configuration/:application/:veContext
    this.post<
      { application: string; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeConfiguration, async (req, res) => {
      const { application, veContext: veContextKey } = req.params;
      const task = req.body?.task as TaskType;
      if (!task) {
        res.status(400).json({ success: false, error: "Missing task in request body" });
        return;
      }

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

      // Extract user's access token for OIDC addon (delegated access)
      const userAccessToken =
        (req.session as any)?.accessToken                      // Browser: session cookie
        || req.headers.authorization?.replace("Bearer ", "");  // CLI: Bearer token

      const result = await this.routeHandlers.handleVeConfiguration(
        application,
        task,
        veContextKey,
        req.body,
        userAccessToken,
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

      const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
      const messages = this.routeHandlers.handleGetMessages(veContext, since);
      this.returnResponse<IVeExecuteMessagesResponse>(res, messages);
    });

    // GET /api/ve/execute/stream/:veContext — Server-Sent Events for real-time updates
    this.app.get<{ veContext: string }>(ApiUri.VeExecuteStream, (req, res) => {
      const storageContext = this.pm.getContextManager();
      const veContext = storageContext.getVEContextByKey(req.params.veContext);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Send existing messages as initial snapshot
      const snapshot = this.routeHandlers.handleGetMessages(veContext);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

      // Listen for new messages
      const listener = (
        msg: IVeExecuteMessage,
        application: string,
        task: string,
      ) => {
        const payload = { application, task, message: msg };
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      this.messageManager.addListener(listener);

      // Heartbeat to detect dead connections
      const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
      }, 30000);

      req.on("close", () => {
        clearInterval(heartbeat);
        this.messageManager.removeListener(listener);
      });
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

    // Register extracted route modules
    registerVeLogsRoutes(this.app);
  }
}

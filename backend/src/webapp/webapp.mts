import express from "express";
import http from "http";
import https from "https";
import path from "path";
import { ContextManager } from "../context-manager.mjs";
import { registerApplicationRoutes } from "./webapp-application-routes.mjs";
import { registerFrameworkRoutes } from "./webapp-framework-routes.mjs";
import { registerInstallationsRoutes } from "./webapp-installations-routes.mjs";
import { registerContainerConfigRoutes } from "./webapp-container-config-routes.mjs";
import { registerSshRoutes } from "./webapp-ssh-routes.mjs";
import { registerAddonRoutes } from "./webapp-addon-routes.mjs";
import { registerLogsHtmlRoute } from "./webapp-logs-html.mjs";
import { registerLoggerRoutes } from "./webapp-logger-routes.mjs";
import { registerVersionRoutes } from "./webapp-version-routes.mjs";
import { setupStaticRoutes } from "./webapp-static.mjs";
import { WebAppVE } from "./webapp-ve.mjs";
import { WebAppStack } from "./webapp-stack-routes.mjs";
import { WebAppStackRefresh } from "./webapp-stack-refresh-routes.mjs";
import { registerCertificateRoutes, getAutoRenewalService } from "./webapp-certificate-routes.mjs";
import { registerMaintenanceRoutes, getLogRotationService } from "./webapp-maintenance-routes.mjs";
import { registerValidationRoutes } from "./webapp-validation-routes.mjs";
import { registerDependencyCheckRoutes } from "./webapp-dependency-check-routes.mjs";
import { registerTestQueueRoutes } from "./webapp-test-queue-routes.mjs";
import { registerHubRoutes } from "./webapp-hub-routes.mjs";
import { createAuthMiddleware } from "./webapp-auth-middleware.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { createLogger } from "../logger/index.mjs";
import {
  initOidc,
  setupSession,
  registerOidcRoutes,
} from "./webapp-oidc.mjs";

export class VEWebApp {
  app: express.Application;
  public httpServer: http.Server;
  public httpsServer?: https.Server;

  createHttpsServer(options: { key: string; cert: string }): https.Server {
    this.httpsServer = https.createServer(options, this.app);
    return this.httpsServer;
  }

  returnResponse<T>(
    res: express.Response,
    payload: T,
    statusCode: number = 200,
  ) {
    res.status(statusCode).json(payload);
  }

  private constructor(private storageContext: ContextManager) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
  }

  private startAutoRenewalIfEnabled(): void {
    const autoRenewal = getAutoRenewalService();
    if (!autoRenewal) return;

    if (autoRenewal.isEnabled()) {
      autoRenewal.startTimer();
    }
  }

  stopAutoRenewal(): void {
    const autoRenewal = getAutoRenewalService();
    if (autoRenewal) autoRenewal.stop();
  }

  private startLogRotationIfEnabled(): void {
    const logRotation = getLogRotationService();
    if (!logRotation) return;

    if (logRotation.isEnabled()) {
      logRotation.startTimer();
    }
  }

  stopLogRotation(): void {
    const logRotation = getLogRotationService();
    if (logRotation) logRotation.stop();
  }

  static async create(storageContext: ContextManager): Promise<VEWebApp> {
    const instance = new VEWebApp(storageContext);
    await instance.init();
    return instance;
  }

  private async init(): Promise<void> {
    const staticDir = setupStaticRoutes(this.app);

    // OIDC initialization (async - needs discovery)
    const oidcConfig = await initOidc();

    // Session middleware (needed for OIDC, set up before auth)
    if (oidcConfig) {
      setupSession(this.app);
      registerOidcRoutes(this.app, oidcConfig);
    } else {
      // Always provide auth/config so the frontend doesn't get a 404
      this.app.get("/api/auth/config", (_req, res) => {
        res.json({ oidcEnabled: false, authenticated: false });
      });
    }

    // Auth middleware on /api/* routes (must be before route registration)
    const authMiddleware = createAuthMiddleware(oidcConfig);
    if (authMiddleware) {
      this.app.use("/api", authMiddleware);
    }

    registerLogsHtmlRoute(this.app);
    registerLoggerRoutes(this.app);
    registerVersionRoutes(this.app);

    registerSshRoutes(
      this.app,
      this.storageContext,
      this.returnResponse.bind(this),
    );
    registerApplicationRoutes(
      this.app,
      this.storageContext,
      this.returnResponse.bind(this),
    );
    registerInstallationsRoutes(this.app, this.storageContext);
    registerContainerConfigRoutes(this.app, this.storageContext);
    registerCertificateRoutes(this.app, this.storageContext);
    registerAddonRoutes(this.app, this.storageContext);
    registerValidationRoutes(this.app);
    registerMaintenanceRoutes(this.app, this.storageContext);
    registerDependencyCheckRoutes(this.app, this.storageContext);
    registerTestQueueRoutes(this.app);

    // Reload endpoint: re-reads json/ and schemas/ from disk
    const reloadLogger = createLogger("reload");
    this.app.post("/api/reload", (_req, res) => {
      try {
        PersistenceManager.reload();
        reloadLogger.info("PersistenceManager reloaded");
        res.json({ ok: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Rich structured details (filename, line, nested errors) for
        // JsonError / ValidationError. Falls back to name + stack for other
        // errors so the client always sees *something* actionable.
        let details: unknown;
        if (err && typeof (err as any).toJSON === "function") {
          details = (err as any).toJSON();
        } else if (err instanceof Error) {
          details = { name: err.name, message: err.message, stack: err.stack };
        } else {
          details = { value: String(err) };
        }
        reloadLogger.error("Reload failed", { error: message, details });
        res.status(500).json({ ok: false, error: message, details });
      }
    });

    registerFrameworkRoutes(
      this.app,
      this.storageContext,
      this.returnResponse.bind(this),
    );

    const webAppVE = new WebAppVE(this.app);
    webAppVE.init();

    const { LocalStackProvider } = await import("../services/local-stack-provider.mjs");
    const localStackProvider = new LocalStackProvider(this.storageContext);
    const webAppStack = new WebAppStack(this.app, localStackProvider);
    webAppStack.init();

    const webAppStackRefresh = new WebAppStackRefresh(this.app, localStackProvider);
    webAppStackRefresh.init();

    // Hub endpoints (always active — CA signing + stack API for spokes)
    registerHubRoutes(this.app);

    // Start periodic timers if enabled
    this.startAutoRenewalIfEnabled();
    this.startLogRotationIfEnabled();

    // Catch-all route for Angular routing - must be after all API routes
    // This ensures that routes like /ssh-config work correctly.
    // Use a RegExp instead of "*" to avoid path-to-regexp errors on Express 5.
    // Exclude /api/ and /logs/ from the catch-all.
    if (staticDir) {
      this.app.get(/^(?!\/(api|logs)\/).*/, (_req, res) => {
        res.sendFile(path.join(staticDir, "index.html"));
      });
    }
  }
}

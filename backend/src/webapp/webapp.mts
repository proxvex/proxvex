import express from "express";
import http from "http";
import https from "https";
import path from "path";
import { ContextManager } from "../context-manager.mjs";
import { registerApplicationRoutes } from "./webapp-application-routes.mjs";
import { registerFrameworkRoutes } from "./webapp-framework-routes.mjs";
import { registerInstallationsRoutes } from "./webapp-installations-routes.mjs";
import { registerSshRoutes } from "./webapp-ssh-routes.mjs";
import { registerAddonRoutes } from "./webapp-addon-routes.mjs";
import { registerLogsHtmlRoute } from "./webapp-logs-html.mjs";
import { registerLoggerRoutes } from "./webapp-logger-routes.mjs";
import { registerVersionRoutes } from "./webapp-version-routes.mjs";
import { setupStaticRoutes } from "./webapp-static.mjs";
import { WebAppVE } from "./webapp-ve.mjs";
import { WebAppStack } from "./webapp-stack-routes.mjs";
import { registerCertificateRoutes } from "./webapp-certificate-routes.mjs";

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

  constructor(private storageContext: ContextManager) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    // No socket.io needed anymore
    const staticDir = setupStaticRoutes(this.app);

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
    registerCertificateRoutes(this.app, this.storageContext);
    registerAddonRoutes(this.app, this.storageContext);
    registerFrameworkRoutes(
      this.app,
      this.storageContext,
      this.returnResponse.bind(this),
    );

    const webAppVE = new WebAppVE(this.app);
    webAppVE.init();

    const webAppStack = new WebAppStack(this.app, this.storageContext);
    webAppStack.init();

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

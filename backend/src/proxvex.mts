#!/usr/bin/env node
import path from "node:path";
import http from "node:http";
import { exec } from "node:child_process";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { VEWebApp } from "./webapp/webapp.mjs";
import { createLogger } from "./logger/index.mjs";
import { buildInfo } from "./webapp/webapp-version-routes.mjs";

const logger = createLogger("main");
logger.info("proxvex started", { version: buildInfo.version });

interface WebAppArgs {
  localPath?: string;
  storageContextFilePath?: string;
  secretsFilePath?: string;
}

function parseArgs(): WebAppArgs {
  const args: WebAppArgs = {};
  const argv = process.argv.slice(2);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i += 1;
      continue;
    }

    if (arg === "--local") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args.localPath = path.isAbsolute(value)
          ? value
          : path.join(process.cwd(), value);
        i += 2;
      } else {
        args.localPath = path.join(process.cwd(), "local");
        i += 1;
      }
    } else if (arg === "--storageContextFilePath") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("--storageContextFilePath requires a value");
        process.exit(1);
      }
      args.storageContextFilePath = path.isAbsolute(value)
        ? value
        : path.join(process.cwd(), value);
      i += 2;
    } else if (arg === "--secretsFilePath") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("--secretsFilePath requires a value");
        process.exit(1);
      }
      args.secretsFilePath = path.isAbsolute(value)
        ? value
        : path.join(process.cwd(), value);
      i += 2;
    } else {
      i += 1;
    }
  }

  return args;
}

async function fetchHubProject(hubUrl: string): Promise<string> {
  const { execSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");

  const hostname = new URL(hubUrl).hostname;
  const hubDir = path.join(tmpdir(), `proxvex-${hostname}`);

  // Clean and recreate
  execSync(`rm -rf "${hubDir}" && mkdir -p "${hubDir}"`);

  // Fetch project tar.gz from Hub and extract
  const projectUrl = `${hubUrl.replace(/\/$/, "")}/api/hub/project`;
  logger.info("Fetching project settings from Hub", { url: projectUrl });

  try {
    execSync(
      `curl -sf --max-time 30 "${projectUrl}" | tar -xzf - -C "${hubDir}"`,
      { stdio: "pipe" },
    );
    logger.info("Hub project settings loaded", { hubDir });
    return hubDir;
  } catch (err: any) {
    throw new Error(`Failed to fetch project from Hub at ${projectUrl}: ${err.message}`);
  }
}

async function startWebApp(
  localPath: string,
  storageContextPath: string,
  secretFilePath: string,
) {
  // Fetch project settings from Hub if HUB_URL is set
  let hubPath: string | undefined;
  const hubUrl = process.env.HUB_URL;
  if (hubUrl) {
    try {
      hubPath = await fetchHubProject(hubUrl);
    } catch (err: any) {
      logger.error("Hub project fetch failed — cannot start as Spoke", { error: err.message });
      process.exit(1);
    }
  }

  PersistenceManager.initialize(localPath, storageContextPath, secretFilePath, true, undefined, undefined, undefined, hubPath);
  const pm = PersistenceManager.getInstance();

  // If this instance was just started as the target of a deployer self-upgrade,
  // a marker file sits in the /config volume. Process it before we serve any
  // requests so the log makes the upgrade visible and the marker is cleared.
  try {
    const { finalizeUpgradeIfPending } = await import(
      "./services/upgrade-finalization-service.mjs"
    );
    finalizeUpgradeIfPending(localPath);
  } catch (err: any) {
    logger.warn("Upgrade finalization check failed (non-fatal)", {
      error: err?.message,
    });
  }

  // Check for duplicate templates/scripts across categories
  const repositories = pm.getRepositories();
  if (repositories.checkForDuplicates) {
    const duplicateWarnings = repositories.checkForDuplicates();
    for (const warning of duplicateWarnings) {
      logger.warn("Duplicate file detected", { warning });
    }
  }

  // Ensure SSH public key exists early so installer can import it
  try {
    const { Ssh } = await import("./ssh.mjs");
    const pub = (Ssh as any).getPublicKey?.();
    if (pub && typeof pub === "string" && pub.length > 0) {
      logger.info("SSH public key ready for import");
    } else {
      logger.info(
        "SSH public key not available yet; will be generated on demand",
      );
    }
  } catch {}
  const contextManager = pm.getContextManager();

  // Ensure global CA exists so that skopeo / registry mirror trust works
  // from the very first deployment (template 005-host-trust-deployer-ca).
  {
    const { CertificateAuthorityService } = await import("./services/certificate-authority-service.mjs");
    const caService = new CertificateAuthorityService(contextManager);
    caService.ensureCA("global");
    logger.info("CA ready");
  }

  const webApp = await VEWebApp.create(contextManager);
  const httpPort = process.env.DEPLOYER_PORT || process.env.PORT || 3080;
  const httpsPort = process.env.DEPLOYER_HTTPS_PORT || 3443;

  // Check if SSL certificates exist in the addon certs volume
  let httpsEnabled = false;
  const certPath = "/etc/ssl/addon/fullchain.pem";
  const keyPath = "/etc/ssl/addon/privkey.pem";

  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      const cert = readFileSync(certPath, "utf-8");
      const key = readFileSync(keyPath, "utf-8");
      logger.info("SSL certificates loaded", { certBytes: cert.length, keyBytes: key.length });
      const httpsServer = webApp.createHttpsServer({ key, cert });
      httpsServer.listen(httpsPort, () => {
        logger.info("HTTPS server started", { port: httpsPort });
      });
      httpsEnabled = true;
    } catch (err: any) {
      logger.error("Failed to start HTTPS server", { error: err?.message });
    }
  } else {
    logger.info("HTTPS disabled: certificate files not found");
  }

  if (httpsEnabled) {
    // HTTPS active: HTTP server becomes a redirect-only server
    const redirectApp = express();
    redirectApp.use((req, res) => {
      const httpsUrl = `https://${req.hostname}:${httpsPort}${req.originalUrl}`;
      res.redirect(301, httpsUrl);
    });
    const redirectServer = http.createServer(redirectApp);
    redirectServer.listen(httpPort, () => {
      logger.info("HTTP redirect server started", { port: httpPort, redirectTo: httpsPort });
    });
    // Keep reference for shutdown
    webApp.httpServer = redirectServer;
  } else {
    // No HTTPS: HTTP server serves the app directly
    webApp.httpServer.listen(httpPort, () => {
      logger.info("HTTP server started", { port: httpPort });
    });

    // No fallback listener on HTTPS port — without certificates, only HTTP is needed
  }

  // Graceful shutdown handlers
  const servers: http.Server[] = [webApp.httpServer];
  if (webApp.httpsServer) servers.push(webApp.httpsServer);


  const shutdown = (signal: string) => {
    logger.info("Shutdown initiated", { signal });

    // Stop certificate auto-renewal timer
    webApp.stopAutoRenewal();

    // Close PersistenceManager (FileWatchers)
    try {
      PersistenceManager.getInstance().close();
      logger.info("PersistenceManager closed");
    } catch {
      // not initialized
    }

    // Kill SSH master connections (ControlPersist=60 spawns background ssh processes)
    exec(
      'for sock in /tmp/proxvex-ssh-*; do [ -S "$sock" ] && ssh -O exit -o ControlPath="$sock" dummy 2>/dev/null; done',
      { timeout: 3000 },
      (err) => {
        if (!err) {
          logger.info("SSH master connections closed");
        }
      },
    );

    // Destroy active keep-alive connections so server.close() completes
    for (const server of servers) {
      server.closeAllConnections();
    }

    let closedCount = 0;
    const onClosed = () => {
      closedCount++;
      if (closedCount >= servers.length) {
        logger.info("All servers closed");
        process.exit(0);
      }
    };

    for (const server of servers) {
      server.close(onClosed);
    }

    // Force shutdown after 5 seconds
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Proxvex - Web Application Server");
    console.log("");
    console.log("Usage:");
    console.log("  proxvex [options]");
    console.log("");
    console.log("Options:");
    console.log(
      "  --local <path>                    Path to the local data directory (default: examples)",
    );
    console.log(
      "  --storageContextFilePath <path>   Path to the storage context file",
    );
    console.log(
      "  --secretsFilePath <path>          Path to the secrets file",
    );
    console.log("  --help, -h                       Show this help message");
    console.log("");
    console.log("For CLI commands (exec, validate, updatedoc, remote), use: oci-lxc-cli");
    process.exit(0);
  }

  try {
    const args = parseArgs();
    const localPath = args.localPath || path.join(process.cwd(), "examples");
    const storageContextFilePath =
      args.storageContextFilePath ||
      path.join(localPath, "storagecontext.json");
    const secretFilePath =
      args.secretsFilePath || path.join(localPath, "secret.txt");
    await startWebApp(localPath, storageContextFilePath, secretFilePath);
  } catch (err: any) {
    console.error("Unexpected error:", err?.message || err);
    if (err?.stack) {
      console.error("Stack trace:", err.stack);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled promise rejection:", err?.message || err);
  if (err?.stack) {
    console.error("Stack trace:", err.stack);
  }
  process.exit(1);
});

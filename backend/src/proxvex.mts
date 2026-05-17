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

async function startWebApp(
  localPath: string,
  storageContextPath: string,
  secretFilePath: string,
) {
  // Spoke startup-sync: if a Hub is configured (via storagecontext SSH entry
  // marked isHub=true, or HUB_URL env), pull the latest project tarball into
  // <localPath>/.hubs/<hub-id>/ and bind <workspacePath>/local as `hubPath`.
  // Search precedence in resolveTemplatePath / resolveScriptPath then becomes
  // localPath → hubPath → jsonPath, i.e. project state from the Hub overrides
  // the on-disk json/ tree but the spoke's own local/ wins over both.
  //
  // Two-phase init: PM is initialized once without hubPath so we can read the
  // active Hub URL from storagecontext, then re-initialized with hubPath
  // pointing at the synced workspace. If the Hub is unreachable, we keep the
  // previous workspace on disk (syncFromHub does an atomic swap) and proceed.
  PersistenceManager.initialize(localPath, storageContextPath, secretFilePath);
  let hubPath: string | undefined;
  let hubUrl: string | undefined;
  try {
    hubUrl = PersistenceManager.getInstance().getActiveHubUrl();
  } catch {
    /* storagecontext unreadable — skip */
  }
  if (!hubUrl) hubUrl = process.env.HUB_URL;

  if (hubUrl) {
    const { syncFromHub, hubIdFromUrl } = await import(
      "./services/spoke-sync-service.mjs"
    );
    const expectedWorkspace = path.join(
      localPath,
      ".hubs",
      hubIdFromUrl(hubUrl.replace(/\/$/, "")),
    );
    try {
      const result = await syncFromHub(hubUrl, localPath);
      hubPath = path.join(result.workspacePath, "local");
      logger.info(`Spoke startup-sync done: ${hubPath}`);
    } catch (err: any) {
      logger.warn(
        `Spoke startup-sync failed (${err.message}) — falling back to last synced workspace if present`,
      );
      const fallback = path.join(expectedWorkspace, "local");
      if (existsSync(fallback)) {
        hubPath = fallback;
        logger.info(`Using stale Hub workspace: ${hubPath}`);
      }
    }
  }

  PersistenceManager.initialize(
    localPath,
    storageContextPath,
    secretFilePath,
    true,
    undefined,
    undefined,
    undefined,
    hubPath,
  );
  const pm = PersistenceManager.getInstance();

  // If this instance was just started as the target of a deployer self-upgrade,
  // a marker file sits in the /config volume. The previous deployer is still
  // running and holding the static IP — we must stop it (via SSH back to the
  // PVE host) before app.listen, otherwise our network bind will fail or
  // race with the old deployer. The marker is only removed on success so a
  // crash here retries on the next boot.
  try {
    const { finalizeUpgradeIfPending } = await import(
      "./services/upgrade-finalization-service.mjs"
    );
    await finalizeUpgradeIfPending(localPath);
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
  // from the very first deployment. The cert is then distributed to PVE
  // hosts (setup-pve-host.sh) and into containers (template 108).
  {
    const { CertificateAuthorityService } = await import("./services/certificate-authority-service.mjs");
    const caService = new CertificateAuthorityService(contextManager);
    caService.ensureCA("global");
    logger.info("CA ready");
  }

  const webApp = await VEWebApp.create(contextManager);
  const httpPort = process.env.DEPLOYER_PORT || process.env.PORT || 3080;
  const localHttpsPort = process.env.DEPLOYER_HTTPS_PORT || 3443;

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
      httpsServer.listen(localHttpsPort, () => {
        logger.info("HTTPS server started", { port: localHttpsPort });
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
      const httpsUrl = `https://${req.hostname}:${localHttpsPort}${req.originalUrl}`;
      res.redirect(301, httpsUrl);
    });
    const redirectServer = http.createServer(redirectApp);
    redirectServer.listen(httpPort, () => {
      logger.info("HTTP redirect server started", { port: httpPort, redirectTo: localHttpsPort });
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

    // Stop live app-log followers (tail / docker logs ssh children) so they
    // don't outlive proxvex. Before the SSH-master cleanup below.
    webApp.stopAppLogMonitors();

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

function loadProxvexEnv(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    logger.info("Loaded environment overrides", { file: filePath });
  } catch (err: any) {
    logger.warn("Failed to load env file (non-fatal)", {
      file: filePath,
      error: err?.message,
    });
  }
}

async function main() {
  loadProxvexEnv("/config/proxvex.env");
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
    reportFatalError("Unexpected error", err);
    process.exit(1);
  }
}

function reportFatalError(label: string, err: any): void {
  console.error(`${label}:`, err?.message || err);
  if (err?.filename) {
    console.error("File:", err.filename);
  }
  if (err?.name === "JsonError" && Array.isArray(err.details)) {
      dumpJsonErrorDetails(err.details, "  ");
  }
  else if (err?.stack) {
    console.error("Stack trace:", err.stack);
  }
}

function dumpJsonErrorDetails(details: any[], indent: string): void {
  console.error(`${indent}Details (${details.length}):`);
  for (const d of details) {
    if (!d) continue;
    const msg = d.message ?? d.passed_message ?? String(d);
    console.error(`${indent}- ${msg}`);
    if (d.filename) console.error(`${indent}  file: ${d.filename}`);
    if (typeof d.line === "number") console.error(`${indent}  line: ${d.line}`);
    if (Array.isArray(d.details) && d.details.length > 0) {
      dumpJsonErrorDetails(d.details, indent + "  ");
    } 
  }
}

main().catch((err) => {
  reportFatalError("Unhandled promise rejection", err);
  process.exit(1);
});

import express from "express";
import fs from "node:fs";
import path from "node:path";
import {
  ApiUri,
  ISsh,
  ISshConfigsResponse,
  ISshConfigKeyResponse,
  ISshCheckResponse,
  ISetSshConfigResponse,
  IDeleteSshConfigResponse,
} from "@src/types.mjs";
import { Ssh } from "../ssh.mjs";
import { ContextManager } from "../context-manager.mjs";
import { IConfiguredPathes, IVEContext } from "../backend-types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";

type ReturnResponse = <T>(
  res: express.Response,
  payload: T,
  statusCode?: number,
) => void;

export function registerSshRoutes(
  app: express.Application,
  storageContext: ContextManager,
  returnResponse: ReturnResponse,
): void {
  const pm = PersistenceManager.getInstance();

  const collectEnumValueTemplates = (pathes: IConfiguredPathes): string[] => {
    const results = new Set<string>();

    // Scan shared/templates/list/ directories - all files there are enum value templates
    const scanListDir = (dir: string) => {
      const listDir = path.join(dir, "shared", "templates", "list");
      if (!fs.existsSync(listDir)) return;
      const entries = fs.readdirSync(listDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          results.add(entry.name);
        }
      }
    };

    scanListDir(pathes.localPath);
    scanListDir(pathes.jsonPath);

    return Array.from(results);
  };

  const triggerEnumWarmup = (veContextKey: string | undefined) => {
    if (!veContextKey) return;
    const veContext = storageContext.getVEContextByKey(veContextKey);
    if (!veContext) return;
    const enumTemplates = collectEnumValueTemplates(pm.getPathes());
    if (enumTemplates.length === 0) return;
    const templateProcessor = storageContext.getTemplateProcessor();
    void templateProcessor
      .warmupEnumValuesForVeContext(veContext, enumTemplates)
      .catch(() => {
        // ignore warmup errors
      });
  };
  app.get(ApiUri.SshConfigs, (_req, res) => {
    try {
      const sshs: ISsh[] = storageContext.listSshConfigs();
      const key = storageContext.getCurrentVEContext()?.getKey();
      const publicKeyCommand = Ssh.getPublicKeyCommand() || undefined;
      returnResponse<ISshConfigsResponse>(res, {
        sshs,
        key,
        publicKeyCommand,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(ApiUri.SshConfigGET, (req, res) => {
    try {
      const host = String(req.params.host || "").trim();
      if (!host) {
        res.status(400).json({ error: "Missing host" });
        return;
      }
      const key = `ve_${host}`;
      if (!storageContext.has(key)) {
        res.status(404).json({ error: "SSH config not found" });
        return;
      }
      returnResponse<ISshConfigKeyResponse>(res, { key });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(ApiUri.SshCheck, (req, res) => {
    try {
      const host = String(req.query.host || "").trim();
      const portRaw = req.query.port as string | undefined;
      const port = portRaw ? Number(portRaw) : undefined;
      if (!host) {
        res.status(400).json({ error: "Missing host" });
        return;
      }
      const result = Ssh.checkSshPermission(host, port);
      returnResponse<ISshCheckResponse>(res, result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(ApiUri.SshConfig, express.json(), (req, res) => {
    const body = req.body as Partial<ISsh> | undefined;
    const host = body?.host;
    const port = body?.port;
    const current = body?.current === true;
    if (!host || typeof host !== "string" || typeof port !== "number") {
      res.status(400).json({
        error:
          "Invalid SSH config. Must provide host (string) and port (number).",
      });
      return;
    }
    // Optional Hub fields. When isHub is true, hubApiUrl must be a valid URL.
    const isHub = body?.isHub === true;
    const hubApiUrl = typeof body?.hubApiUrl === "string" ? body.hubApiUrl.trim() : undefined;
    const hubCaFingerprint =
      typeof body?.hubCaFingerprint === "string" ? body.hubCaFingerprint.trim() : undefined;
    if (isHub && (!hubApiUrl || !/^https?:\/\//.test(hubApiUrl))) {
      res.status(400).json({
        error:
          "isHub=true requires hubApiUrl to be a valid http(s):// URL.",
      });
      return;
    }
    try {
      const prevCurrentKey = storageContext.getCurrentVEContext()?.getKey();
      let currentKey: string | undefined = storageContext.setVEContext({
        host,
        port,
        current,
        isHub,
        hubApiUrl: hubApiUrl || undefined,
        hubCaFingerprint: hubCaFingerprint || undefined,
      } as IVEContext);
      if (current === true) {
        for (const key of storageContext
          .keys()
          .filter((k) => k.startsWith("ve_") && k !== `ve_${host}`)) {
          const ctx: any = storageContext.get(key) || {};
          const updated = { ...ctx, current: false };
          storageContext.setVEContext(updated);
        }
      } else currentKey = undefined;
      if (currentKey && currentKey !== prevCurrentKey) {
        triggerEnumWarmup(currentKey);
      }

      // Hub/Spoke live switch: if the SSH entry changed its isHub/hubApiUrl
      // (or the active entry switched to one that IS a Hub), drop the cached
      // CA/Stack providers so the next request re-evaluates Spoke-vs-Standalone.
      // Then trigger a background sync so repositories are available after the
      // swap without requiring a deployer restart.
      (async () => {
        try {
          const { PersistenceManager } = await import(
            "../persistence/persistence-manager.mjs"
          );
          const pm = PersistenceManager.getInstance();
          pm.resetProviders();

          const hubUrl = pm.getActiveHubUrl();
          if (!hubUrl) return;

          const { syncFromHub, hubIdFromUrl } = await import(
            "../services/spoke-sync-service.mjs"
          );
          const { createLogger } = await import("../logger/index.mjs");
          const logger = createLogger("ssh-routes");
          const localPath = process.env.LXC_MANAGER_LOCAL_PATH || process.cwd();
          const result = await syncFromHub(hubUrl, localPath);
          logger.info(
            `[ssh-routes] Spoke-sync done: ${result.workspacePath} (hub=${result.hubUrl})`,
          );
          // Rebind only localPath to the freshly synced Hub state.
          // jsonPath stays on the Spoke's checkout (templates/scripts come
          // from the user's working tree, not the Hub).
          const path = await import("node:path");
          const workspace = path.join(
            localPath,
            ".hubs",
            hubIdFromUrl(hubUrl.replace(/\/$/, "")),
          );
          pm.rebindRepositoriesRoot(path.join(workspace, "local"));
        } catch (err) {
          const { createLogger } = await import("../logger/index.mjs");
          createLogger("ssh-routes").warn(
            `[ssh-routes] Spoke-sync after SSH change failed: ${(err as Error).message}`,
          );
        }
      })();

      returnResponse<ISetSshConfigResponse>(res, {
        success: true,
        key: currentKey,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get<String>(ApiUri.SshConfig, (_req, res) => {
    try {
      const veContext = storageContext.getCurrentVEContext();
      if (!veContext) {
        res.status(404).json({
          error: "No default SSH config available. Please configure first",
        });
        return;
      }
      const key = veContext.getKey();
      returnResponse<ISshConfigKeyResponse>(res, { key });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(ApiUri.SshConfig, (req, res) => {
    try {
      const prevCurrentKey = storageContext.getCurrentVEContext()?.getKey();
      const host =
        String(req.query.host || "").trim() ||
        String((req.body as any)?.host || "").trim();
      if (!host) {
        res.status(400).json({ error: "Missing host" });
        return;
      }
      const key = `ve_${host}`;
      if (!storageContext.has(key)) {
        returnResponse<IDeleteSshConfigResponse>(res, {
          success: true,
          deleted: false,
        });
        return;
      }
      storageContext.remove(key);
      const remainingKeys: string[] = storageContext
        .keys()
        .filter((k: string) => k.startsWith("ve_"));
      let currentKey: string | undefined = undefined;
      if (remainingKeys.length > 0 && remainingKeys[0] !== undefined) {
        currentKey = remainingKeys[0];
        const ctx: any = storageContext.get(currentKey) || {};
        const updated = { ...ctx, current: true };
        storageContext.set(currentKey, updated);
      }
      if (currentKey && currentKey !== prevCurrentKey) {
        triggerEnumWarmup(currentKey);
      }
      returnResponse<IDeleteSshConfigResponse>(res, {
        success: true,
        deleted: true,
        key: currentKey,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put(ApiUri.SshConfig, express.json(), (req, res) => {
    try {
      const prevCurrentKey = storageContext.getCurrentVEContext()?.getKey();
      const rawHost =
        (req.query.host as string | undefined) ??
        ((req.body as any)?.host as string | undefined);
      const host = rawHost ? String(rawHost).trim() : "";
      if (!host) {
        res.status(400).json({ error: "Missing host" });
        return;
      }
      const key: string = `ve_${host}`;
      if (!storageContext.has(key)) {
        res.status(404).json({ error: "SSH config not found" });
        return;
      }
      for (const k of storageContext
        .keys()
        .filter((k: string) => k.startsWith("ve_") && k !== key)) {
        const ctx: any = storageContext.get(k) || {};
        storageContext.set(k, { ...ctx, current: false });
      }
      const curCtx: any = storageContext.get(key) || {};
      storageContext.set(key, { ...curCtx, current: true });
      if (key && key !== prevCurrentKey) {
        triggerEnumWarmup(key);
      }
      returnResponse<ISetSshConfigResponse>(res, { success: true, key });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Startup warmup: if there's already a current VE context (from a previous session),
  // pre-load enum values immediately so they're cached when the user opens the UI.
  const currentVeKey = storageContext.getCurrentVEContext()?.getKey();
  if (currentVeKey) {
    triggerEnumWarmup(currentVeKey);
  }
}

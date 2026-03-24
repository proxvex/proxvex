import express from "express";
import {
  ApiUri,
  IInstallationsResponse,
  IManagedOciContainer,
  ICommand,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { IVEContext } from "../backend-types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

/**
 * Detects which addons are active on the PVE host by running a lightweight
 * shell script via SSH. Returns addon notes_keys (e.g. ["ssl", "oidc"]).
 */
async function detectProxmoxAddons(
  veContext: IVEContext,
  pm: PersistenceManager,
): Promise<string[]> {
  try {
    const repositories = pm.getRepositories();
    const scriptContent = repositories.getScript({
      name: "host-detect-proxmox-addons.sh",
      scope: "shared",
      category: "list",
    });
    if (!scriptContent) {
      return [];
    }

    const cmd: ICommand = {
      name: "Detect Proxmox Addons",
      execute_on: "ve",
      script: "host-detect-proxmox-addons.sh",
      scriptContent,
      outputs: ["pve_addons"],
    };

    const ve = new VeExecution(
      [cmd],
      [],
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );
    await ve.run(null);
    const raw = ve.outputs.get("pve_addons");
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch {
    // Detection failure is non-fatal — show Proxmox without addon info
  }
  return [];
}

export function registerInstallationsRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  const pm = PersistenceManager.getInstance();

  app.get(ApiUri.Installations, async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }
      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      const repositories = pm.getRepositories();
      const scriptContent = repositories.getScript({
        name: "list-managed-oci-containers.py",
        scope: "shared",
        category: "list", // list scripts are in list/ category
      });
      if (!scriptContent) {
        res.status(500).json({
          error:
            "list-managed-oci-containers.py not found (expected in local/shared/scripts/list or json/shared/scripts/list)",
        });
        return;
      }

      const libraryContent = repositories.getScript({
        name: "lxc_config_parser_lib.py",
        scope: "shared",
        category: "library", // library scripts are in library/ category
      });
      if (!libraryContent) {
        res.status(500).json({
          error:
            "lxc_config_parser_lib.py not found (expected in local/shared/scripts/library or json/shared/scripts/library)",
        });
        return;
      }

      const cmd: ICommand = {
        name: "List Managed OCI Containers",
        execute_on: "ve",
        script: "list-managed-oci-containers.py",
        scriptContent,
        libraryContent,
        outputs: ["containers"],
      };

      // Run container list and addon detection in parallel
      const veExecPromise = (async () => {
        const ve = new VeExecution(
          [cmd],
          [],
          veContext,
          new Map(),
          undefined,
          determineExecutionMode(),
        );
        await ve.run(null);
        const containersRaw = ve.outputs.get("containers");
        const parsed =
          typeof containersRaw === "string" && containersRaw.trim().length > 0
            ? JSON.parse(containersRaw)
            : [];
        return Array.isArray(parsed) ? parsed : [];
      })();

      const addonsPromise = detectProxmoxAddons(veContext, pm);

      const [containers, pveAddons] = await Promise.all([
        veExecPromise,
        addonsPromise,
      ]);

      // Inject Proxmox host as virtual installation entry
      const proxmoxEntry: IManagedOciContainer = {
        vm_id: 0,
        hostname: veContext.host,
        oci_image: "proxmox-ve",
        application_id: "proxmox",
        application_name: "Proxmox VE",
        status: "running",
        is_host: true,
        ...(pveAddons.length > 0 ? { addons: pveAddons } : {}),
      };

      const payload: IInstallationsResponse = [proxmoxEntry, ...containers];
      res.status(200).json(payload);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}

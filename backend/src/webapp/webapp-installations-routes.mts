import express from "express";
import {
  ApiUri,
  IInstallationsResponse,
  IManagedOciContainer,
  IContainerVersionsResponse,
  ICommand,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { IVEContext } from "../backend-types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";
import {
  parseVersionString,
  mergeComposeImages,
} from "../version-utils.mjs";

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

  // --- GET /api/:veContext/installations/:vmId/versions ---
  app.get(ApiUri.InstallationVersions, async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      const vmId = parseInt(req.params.vmId, 10);
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }
      if (isNaN(vmId)) {
        res.status(400).json({ error: "Invalid vmId" });
        return;
      }

      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      // Step 1: Read container config to get version, oci_image, application_id
      const repositories = pm.getRepositories();
      const scriptContent = repositories.getScript({
        name: "list-managed-oci-containers.py",
        scope: "shared",
        category: "list",
      });
      const libraryContent = repositories.getScript({
        name: "lxc_config_parser_lib.py",
        scope: "shared",
        category: "library",
      });
      if (!scriptContent || !libraryContent) {
        res.status(500).json({ error: "Required scripts not found" });
        return;
      }

      const listCmd: ICommand = {
        name: "List Managed OCI Containers",
        execute_on: "ve",
        script: "list-managed-oci-containers.py",
        scriptContent,
        libraryContent,
        outputs: ["containers"],
      };

      const ve = new VeExecution(
        [listCmd],
        [],
        veContext,
        new Map(),
        undefined,
        determineExecutionMode(),
      );
      await ve.run(null);
      const containersRaw = ve.outputs.get("containers");
      const containers: IManagedOciContainer[] =
        typeof containersRaw === "string" && containersRaw.trim().length > 0
          ? JSON.parse(containersRaw)
          : [];

      const container = containers.find((c) => c.vm_id === vmId);
      if (!container) {
        res.status(404).json({ error: `Container ${vmId} not found` });
        return;
      }

      // Step 2: Determine framework from application_id
      const appId = container.application_id;
      let framework = "oci-image";
      if (appId) {
        try {
          const apps = pm.getApplicationService().listApplicationsForFrontend();
          const app = apps.find((a) => a.id === appId);
          if (app?.framework) {
            framework = app.framework;
          }
        } catch {
          // Fall back to oci-image
        }
      }

      // Step 3: Parse version string from notes
      let services = parseVersionString(
        container.version,
        container.oci_image,
      );

      // Step 4: For docker-compose, try to read compose file for full image names
      if (framework === "docker-compose" && container.hostname) {
        try {
          const composeScriptContent = repositories.getScript({
            name: "list-container-service-versions.py",
            scope: "shared",
            category: "list",
          });
          if (composeScriptContent) {
            const composeProject = container.hostname;
            const resolvedScript = composeScriptContent
              .replace(/\{\{\s*compose_project\s*\}\}/g, composeProject)
              .replace(/\{\{\s*vm_id\s*\}\}/g, String(vmId));

            const composeCmd: ICommand = {
              name: "List Container Service Versions",
              execute_on: "ve",
              script: "list-container-service-versions.py",
              scriptContent: resolvedScript,
              outputs: ["service_versions"],
            };

            const veCompose = new VeExecution(
              [composeCmd],
              [],
              veContext,
              new Map(),
              undefined,
              determineExecutionMode(),
            );
            await veCompose.run(null);
            const versionsRaw = veCompose.outputs.get("service_versions");
            if (
              typeof versionsRaw === "string" &&
              versionsRaw.trim().length > 0
            ) {
              const composeServices = JSON.parse(versionsRaw);
              if (Array.isArray(composeServices) && composeServices.length > 0) {
                // Build image lookup from compose file
                const composeImages: Record<string, string> = {};
                for (const svc of composeServices) {
                  if (svc.service && svc.image) {
                    composeImages[svc.service] = svc.image;
                  }
                }

                // If notes had no version info, use compose file versions directly
                if (services.length === 0) {
                  services = composeServices;
                } else {
                  services = mergeComposeImages(services, composeImages);
                }
              }
            }
          }
        } catch {
          // Compose file read failed — use version from notes only
        }
      }

      const response: IContainerVersionsResponse = { services, framework };
      res.status(200).json(response);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}

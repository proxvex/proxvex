import express from "express";
import {
  ApiUri,
  IDependencyCheckResponse,
  IDependencyStatus,
  IManagedOciContainer,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { listManagedContainers } from "../services/container-list-service.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

/**
 * Checks whether dependency containers are running for a given application.
 * Used by the frontend to block installation when dependencies are missing.
 */
export function registerDependencyCheckRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  const pm = PersistenceManager.getInstance();

  app.get(ApiUri.DependencyCheck, async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      const application = String(req.params.application || "").trim();

      if (!veContextKey || !application) {
        res
          .status(400)
          .json({ error: "Missing veContext or application" });
        return;
      }

      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      // Parse query params
      const addonsParam = String(req.query.addons || "");
      const stackId = String(req.query.stackId || "");
      const selectedAddons = addonsParam
        ? addonsParam.split(",").filter(Boolean)
        : [];

      // Collect all dependencies (application + addons)
      const allDeps: { application: string; source: string }[] = [];

      try {
        const appConfig = pm.getRepositories().getApplication(application);
        if (appConfig.dependencies) {
          for (const dep of appConfig.dependencies) {
            allDeps.push({
              application: dep.application,
              source: "application",
            });
          }
        }
      } catch {
        /* app not found — continue with addon deps only */
      }

      // Merge addon dependencies
      if (selectedAddons.length > 0) {
        const addonSvc = pm.getAddonService();
        for (const addonId of selectedAddons) {
          try {
            const addon = addonSvc.getAddon(addonId);
            if (addon?.dependencies) {
              for (const dep of addon.dependencies) {
                if (
                  !allDeps.some((d) => d.application === dep.application)
                ) {
                  allDeps.push({
                    application: dep.application,
                    source: addonId,
                  });
                }
              }
            }
          } catch {
            /* unknown addon */
          }
        }
      }

      // No dependencies → return empty
      if (allDeps.length === 0) {
        const response: IDependencyCheckResponse = { dependencies: [] };
        res.status(200).json(response);
        return;
      }

      // Fetch all managed containers via the existing listing script
      const containers = await listManagedContainers(pm, veContext);

      // Match each dependency against running containers
      const results: IDependencyStatus[] = allDeps.map((dep) => {
        // Find containers matching application_id (and optionally stack_name)
        const matching = containers.filter((c) => {
          if (c.application_id !== dep.application) return false;
          // If stackId is provided, match stack_name
          if (stackId && c.stack_name && c.stack_name !== stackId)
            return false;
          return true;
        });

        if (matching.length === 0) {
          return {
            application: dep.application,
            source: dep.source,
            status: "not_found" as const,
          };
        }

        // Prefer running containers
        const running = matching.find((c) => c.status === "running");
        if (running) {
          const result: IDependencyStatus = {
            application: dep.application,
            source: dep.source,
            status: "running",
            vmId: running.vm_id,
          };
          if (running.hostname) result.hostname = running.hostname;
          return result;
        }

        // Container exists but not running
        const first = matching[0]!;
        const result: IDependencyStatus = {
          application: dep.application,
          source: dep.source,
          status: "stopped",
          vmId: first.vm_id,
        };
        if (first.hostname) result.hostname = first.hostname;
        return result;
      });

      const response: IDependencyCheckResponse = { dependencies: results };
      res.status(200).json(response);
    } catch (err: unknown) {
      sendErrorResponse(res, err);
    }
  });
}


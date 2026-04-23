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
      const stackIdsParam = String(req.query.stackIds || req.query.stackId || "");
      const selectedAddons = addonsParam
        ? addonsParam.split(",").filter(Boolean)
        : [];
      const selectedStackIds = stackIdsParam
        ? stackIdsParam.split(",").filter(Boolean)
        : [];

      // Build map stacktype -> requested stack id for the install context. The
      // dep-check filters per-stacktype to resolve cross-stack dependencies
      // (e.g. addon-oidc -> zitadel via the OIDC stack).
      const requestedStackIdByType: Record<string, string> = {};
      for (const sid of selectedStackIds) {
        const stack = storageContext.getStack(sid);
        if (!stack) continue;
        const types = Array.isArray(stack.stacktype) ? stack.stacktype : [stack.stacktype];
        for (const t of types) {
          if (t && !requestedStackIdByType[t]) requestedStackIdByType[t] = stack.id;
        }
      }

      // Collect all dependencies (application + addons), each tagged with the
      // stacktype that determines stack-membership for the dependency match.
      const allDeps: { application: string; source: string; stacktype: string | null }[] = [];

      const consumerStacktypes = (() => {
        try {
          const cfg = pm.getRepositories().getApplication(application) as { stacktype?: string | string[] };
          const st = cfg?.stacktype;
          if (!st) return [];
          return Array.isArray(st) ? st : [st];
        } catch { return []; }
      })();

      const sharedStacktype = (depApp: string): string | null => {
        try {
          const cfg = pm.getRepositories().getApplication(depApp) as { stacktype?: string | string[] };
          const depTypes = cfg?.stacktype
            ? (Array.isArray(cfg.stacktype) ? cfg.stacktype : [cfg.stacktype])
            : [];
          for (const t of consumerStacktypes) {
            if (depTypes.includes(t)) return t;
          }
          return null;
        } catch { return null; }
      };

      try {
        const appConfig = pm.getRepositories().getApplication(application);
        if (appConfig.dependencies) {
          for (const dep of appConfig.dependencies) {
            allDeps.push({
              application: dep.application,
              source: "application",
              stacktype: sharedStacktype(dep.application),
            });
          }
        }
      } catch {
        /* app not found — continue with addon deps only */
      }

      // Merge addon dependencies. Stacktype comes from the addon itself (e.g.
      // addon-oidc has stacktype "oidc" -> match dep against the OIDC stack).
      if (selectedAddons.length > 0) {
        const addonSvc = pm.getAddonService();
        for (const addonId of selectedAddons) {
          try {
            const addon = addonSvc.getAddon(addonId);
            if (!addon?.dependencies) continue;
            const addonTypes = addon.stacktype
              ? (Array.isArray(addon.stacktype) ? addon.stacktype : [addon.stacktype])
              : [];
            const addonStacktype = addonTypes[0] ?? null;
            for (const dep of addon.dependencies) {
              if (allDeps.some((d) => d.application === dep.application)) continue;
              allDeps.push({
                application: dep.application,
                source: addonId,
                stacktype: addonStacktype,
              });
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

      // Match each dependency against running containers. A container matches when
      // application_id matches and (if the dep is bound to a stacktype with a
      // requested stack) the container is a member of that exact stack.
      const results: IDependencyStatus[] = allDeps.map((dep) => {
        const wantedStackId = dep.stacktype
          ? requestedStackIdByType[dep.stacktype]
          : undefined;

        const matching = containers.filter((c: IManagedOciContainer) => {
          if (c.application_id !== dep.application) return false;
          if (!wantedStackId) return true;
          return Array.isArray(c.stack_ids) && c.stack_ids.includes(wantedStackId);
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


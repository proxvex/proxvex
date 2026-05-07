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

      // Single source of truth for the "which dependencies?" question:
      // ApplicationDependencyResolver. Same code path as the install/
      // reconfigure flow in webapp-ve-route-handlers and the livetest
      // scenario auto-derive — three call-sites converge on identical
      // behaviour for identical inputs.
      const allDeps = pm
        .getApplicationDependencyResolver()
        .resolve(application, selectedAddons, selectedStackIds);

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
        const wantedStackId = dep.expectedStackId ?? undefined;
        // The resolver tags consumer-stacktype-driven deps as
        // "stacktype:<name>"; the UI distinguishes only "application" vs.
        // "<addon-id>", so normalize stacktype-tagged deps to "application"
        // (they are consumer-driven, not addon-driven).
        const displaySource = dep.source.startsWith("stacktype:") ? "application" : dep.source;

        const matching = containers.filter((c: IManagedOciContainer) => {
          if (c.application_id !== dep.application) return false;
          if (!wantedStackId) return true;
          return Array.isArray(c.stack_ids) && c.stack_ids.includes(wantedStackId);
        });

        if (matching.length === 0) {
          return {
            application: dep.application,
            source: displaySource,
            status: "not_found" as const,
          };
        }

        // Status priority for picking the representative container:
        //   running  > unknown > stopped (anything else)
        // - "running" is reported as-is.
        // - "unknown" is surfaced honestly (the listing script returned
        //   "unknown" because `pct status` failed even after retry —
        //   transient lock/timeout). The frontend renders this as a
        //   warning, not a blocking error.
        // - Otherwise the container is reported as "stopped" so the
        //   user knows to start it before installing the consumer.
        const running = matching.find((c) => c.status === "running");
        if (running) {
          const result: IDependencyStatus = {
            application: dep.application,
            source: displaySource,
            status: "running",
            vmId: running.vm_id,
          };
          if (running.hostname) result.hostname = running.hostname;
          return result;
        }
        const indeterminate = matching.find((c) => c.status === "unknown");
        if (indeterminate) {
          const result: IDependencyStatus = {
            application: dep.application,
            source: displaySource,
            status: "unknown",
            vmId: indeterminate.vm_id,
          };
          if (indeterminate.hostname) result.hostname = indeterminate.hostname;
          return result;
        }

        // Container exists but not running
        const first = matching[0]!;
        const result: IDependencyStatus = {
          application: dep.application,
          source: displaySource,
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


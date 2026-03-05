import express, { RequestHandler } from "express";
import {
  ApiUri,
  IVeConfigurationResponse,
  IPostVeCopyUpgradeBody,
  IPostVeConfigurationBody,
} from "../types.mjs";
import { WebAppVeRouteHandlers } from "./webapp-ve-route-handlers.mjs";

/**
 * Registers the VE copy-upgrade API route.
 * Starts the application "copy-upgrade" task without persisting a VMInstallContext.
 */
export function registerVeCopyUpgradeRoutes(
  app: express.Application,
  routeHandlers: WebAppVeRouteHandlers,
): void {
  // POST /api/ve/copy-upgrade/:application/:veContext
  app.post<{ application: string; veContext: string }>(
    ApiUri.VeCopyUpgrade,
    express.json() as RequestHandler,
    async (
      req: express.Request<{ application: string; veContext: string }, unknown, IPostVeCopyUpgradeBody>,
      res: express.Response,
    ) => {
      const { application, veContext: veContextKey } = req.params;
      const body = req.body;

      // Minimal validation for required copy-upgrade fields
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "Invalid body" });
        return;
      }
      if (!body.oci_image || typeof body.oci_image !== "string") {
        res.status(400).json({ success: false, error: "Missing oci_image" });
        return;
      }
      if (
        body.source_vm_id === undefined ||
        body.source_vm_id === null ||
        typeof body.source_vm_id !== "number"
      ) {
        res.status(400).json({ success: false, error: "Missing source_vm_id" });
        return;
      }

      const params: { name: string; value: any }[] = [];
      const add = (name: string, value: any) => {
        if (value === undefined || value === null) return;
        if (typeof value === "string" && value.trim() === "") return;
        params.push({ name, value });
      };

      add("oci_image", body.oci_image);
      add("source_vm_id", body.source_vm_id);
      add("vm_id", body.vm_id);
      add("disk_size", body.disk_size);
      add("bridge", body.bridge);
      add("memory", body.memory);
      add("storage", body.storage);
      add("registry_username", body.registry_username);
      add("registry_password", body.registry_password);
      add("registry_token", body.registry_token);
      add("platform", body.platform);
      add("application_id", body.application_id);
      add("application_name", body.application_name);
      add("version", body.version);

      const configBody: any = { params };
      if (
        Array.isArray(body.selectedAddons) &&
        body.selectedAddons.length > 0
      ) {
        configBody.selectedAddons = body.selectedAddons;
      }

      const result = await routeHandlers.handleVeConfiguration(
        application,
        "copy-upgrade",
        veContextKey,
        configBody as IPostVeConfigurationBody,
      );

      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = {
          success: true,
          restartKey: result.restartKey,
        };
        res.status(200).json(response);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    },
  );
}

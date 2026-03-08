import express from "express";
import { ApiUri, ICommand } from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

export function registerContainerConfigRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  const pm = PersistenceManager.getInstance();

  app.get(ApiUri.ContainerConfig, async (req, res) => {
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

      const vmId = parseInt(req.params.vmId, 10);
      if (isNaN(vmId)) {
        res.status(400).json({ error: "Invalid vmId" });
        return;
      }

      const repositories = pm.getRepositories();
      const scriptContent = repositories.getScript({
        name: "get-container-config.py",
        scope: "shared",
        category: "list",
      });
      if (!scriptContent) {
        res.status(500).json({
          error:
            "get-container-config.py not found (expected in local/shared/scripts/list or json/shared/scripts/list)",
        });
        return;
      }

      const libraryContent = repositories.getScript({
        name: "lxc_config_parser_lib.py",
        scope: "shared",
        category: "library",
      });
      if (!libraryContent) {
        res.status(500).json({
          error:
            "lxc_config_parser_lib.py not found (expected in local/shared/scripts/library or json/shared/scripts/library)",
        });
        return;
      }

      const cmd: ICommand = {
        name: "Get Container Config",
        execute_on: "ve",
        script: "get-container-config.py",
        scriptContent,
        libraryContent,
        outputs: ["config"],
      };

      const ve = new VeExecution(
        [cmd],
        [{ id: "previous_vm_id", value: vmId }],
        veContext,
        new Map(),
        undefined,
        determineExecutionMode(),
      );
      await ve.run(null);
      const configRaw = ve.outputs.get("config");
      const parsed =
        typeof configRaw === "string" && configRaw.trim().length > 0
          ? JSON.parse(configRaw)
          : {};
      res.status(200).json(parsed);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}

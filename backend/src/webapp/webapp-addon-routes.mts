import express from "express";
import {
  ApiUri,
  IVeConfigurationResponse,
  ICommand,
  ITemplate,
  IPostAddonInstallBody,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

export function registerAddonRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  const pm = PersistenceManager.getInstance();

  /**
   * POST /api/addons/install/:addonId/:veContext
   *
   * Installs an addon on an existing running container.
   * Runs the addon's post_start templates and updates the container notes.
   */
  app.post(
    ApiUri.AddonInstall,
    express.json(),
    async (
      req: express.Request<
        { addonId: string; veContext: string },
        unknown,
        IPostAddonInstallBody
      >,
      res: express.Response,
    ) => {
      try {
        const { addonId, veContext: veContextKey } = req.params;
        const body = req.body;

        // Validate required fields
        if (!addonId) {
          res.status(400).json({ success: false, error: "Missing addonId" });
          return;
        }
        if (!body || typeof body !== "object") {
          res.status(400).json({ success: false, error: "Invalid body" });
          return;
        }
        if (body.vm_id === undefined || typeof body.vm_id !== "number") {
          res.status(400).json({ success: false, error: "Missing vm_id" });
          return;
        }

        const veContext = storageContext.getVEContextByKey(veContextKey);
        if (!veContext) {
          res
            .status(404)
            .json({ success: false, error: "VE context not found" });
          return;
        }

        const addonService = pm.getAddonService();
        const repositories = pm.getRepositories();

        // Load the addon
        let addon;
        try {
          addon = addonService.getAddon(addonId);
        } catch {
          res
            .status(404)
            .json({ success: false, error: `Addon not found: ${addonId}` });
          return;
        }

        // Build inputs array for VeExecution
        const inputs: { id: string; value: string | number | boolean }[] = [];
        inputs.push({ id: "vm_id", value: body.vm_id });
        inputs.push({ id: "addon_id", value: addonId });

        // Add addon properties to inputs
        if (addon.properties) {
          for (const prop of addon.properties) {
            if (prop.value !== undefined) {
              inputs.push({
                id: prop.id,
                value: prop.value as string | number | boolean,
              });
            }
          }
        }

        // Add user-provided params
        if (body.params && Array.isArray(body.params)) {
          for (const p of body.params) {
            if (p.name && p.value !== undefined) {
              inputs.push({ id: p.name, value: p.value });
            }
          }
        }

        // If application_id provided
        if (body.application_id) {
          inputs.push({ id: "application_id", value: body.application_id });
        }

        // Collect commands from addon's reconfigure post_start templates
        const commands: ICommand[] = [];
        const reconfigurePostStart = addon.reconfigure?.post_start;

        if (reconfigurePostStart && reconfigurePostStart.length > 0) {
          for (const templateRef of reconfigurePostStart) {
            const templateName =
              typeof templateRef === "string" ? templateRef : templateRef.name;

            try {
              // Load template from repositories
              const template = repositories.getTemplate({
                name: templateName,
                scope: "shared",
              }) as ITemplate | null;

              if (template && template.commands) {
                for (const cmd of template.commands) {
                  // Resolve script content if script is specified
                  const command: ICommand = { ...cmd };
                  if (!command.execute_on && template.execute_on) {
                    command.execute_on = template.execute_on;
                  }

                  if (cmd.script && !cmd.scriptContent) {
                    const scriptContent = repositories.getScript({
                      name: cmd.script,
                      scope: "shared",
                    });
                    if (scriptContent) {
                      command.scriptContent = scriptContent;
                    }
                  }

                  if (cmd.library && !cmd.libraryContent) {
                    const libraryContent = repositories.getScript({
                      name: cmd.library,
                      scope: "shared",
                    });
                    if (libraryContent) {
                      command.libraryContent = libraryContent;
                    }
                  }

                  commands.push(command);
                }
              }
            } catch (e) {
              console.error(`Failed to load template ${templateName}:`, e);
              // Continue with other templates
            }
          }
        }

        // Add the notes update command at the end
        const notesUpdateScript = repositories.getScript({
          name: "host-update-lxc-notes-addon.py",
          scope: "shared",
          category: "post_start",
        });
        const notesUpdateLibrary = repositories.getScript({
          name: "lxc_config_parser_lib.py",
          scope: "shared",
          category: "library",
        });

        if (notesUpdateScript && notesUpdateLibrary) {
          commands.push({
            name: "Update LXC Notes with Addon Marker",
            execute_on: "ve",
            script: "host-update-lxc-notes-addon.py",
            scriptContent: notesUpdateScript,
            libraryContent: notesUpdateLibrary,
            outputs: ["success"],
          });
        }

        if (commands.length === 0) {
          res.status(400).json({
            success: false,
            error: "No commands to execute for this addon",
          });
          return;
        }

        // Execute the addon installation
        const ve = new VeExecution(
          commands,
          inputs,
          veContext,
          new Map(),
          undefined,
          determineExecutionMode(),
        );

        await ve.run(null);

        // Check success via outputs
        const success = ve.outputs.get("success");

        const response: IVeConfigurationResponse = {
          success: success === "true" || success === true,
        };
        res.status(200).json(response);
      } catch (err: unknown) {
        sendErrorResponse(res, err, { success: false });
      }
    },
  );
}

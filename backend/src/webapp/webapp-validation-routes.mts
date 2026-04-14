import type { Application } from "express";
import express from "express";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { ParameterValidator } from "../parameter-validator.mjs";
import type { TaskType } from "../types.mjs";
import { VEConfigurationError } from "../backend-types.mjs";
import { validateAllJson, ValidationError } from "../validateAllJson.mjs";

const validator = new ParameterValidator();

export function registerValidationRoutes(app: Application): void {
  // GET /api/validate — validate all JSON files (templates, applications, frameworks, addons)
  app.get("/api/validate", async (_req, res) => {
    try {
      await validateAllJson();
      res.status(200).json({ valid: true });
    } catch (err: any) {
      if (err instanceof ValidationError) {
        res.status(200).json({ valid: false, error: err.message });
      } else {
        res.status(500).json({ valid: false, error: err?.message || "Validation failed" });
      }
    }
  });

  app.post(
    "/api/:veContext/validate-parameters/:application",
    express.json(),
    async (req, res) => {
      try {
        const { application } = req.params;
        const task = String(req.body?.task ?? "");
        if (!task) {
          res.status(400).json({ error: "Missing task in request body" });
          return;
        }
        const body = req.body as {
          params?: { name: string; value: any }[];
          selectedAddons?: string[];
          stackId?: string;
        };

        if (!body.params || !Array.isArray(body.params)) {
          res.status(400).json({ error: "Missing or invalid params array" });
          return;
        }

        const pm = PersistenceManager.getInstance();
        const appService = pm.getApplicationService();
        const addonService = pm.getAddonService();
        const contextManager = pm.getContextManager();

        // Load application
        const appObj = appService.readApplication(application, {
          applicationHierarchy: [],
          error: new VEConfigurationError("", application),
          taskTemplates: [],
        });

        if (!appObj) {
          res.status(404).json({ error: `Application '${application}' not found` });
          return;
        }

        // Load unresolved parameters via template processor
        const veContextKey = req.params.veContext;
        const veContext = contextManager.getVEContextByKey(veContextKey);

        let parameterDefs = appObj.parameters ?? [];

        if (veContext) {
          try {
            const templateProcessor = contextManager.getTemplateProcessor();
            const unresolved = await templateProcessor.getUnresolvedParameters(
              application,
              task as TaskType,
              veContext,
            );
            if (unresolved.length > 0) {
              parameterDefs = unresolved;
            }
          } catch {
            // Fall back to application parameters
          }
        }

        // Load compatible addons
        const availableAddons = addonService.getCompatibleAddonsWithParameters(appObj);

        // Load stacks if app or selected addons have stacktype
        const stacktypes = appObj.stacktype
          ? (Array.isArray(appObj.stacktype) ? appObj.stacktype : [appObj.stacktype])
          : [];
        if (body.selectedAddons) {
          for (const addonId of body.selectedAddons) {
            try {
              const addon = addonService.getAddon(addonId);
              if (addon.stacktype) {
                const addonTypes = Array.isArray(addon.stacktype) ? addon.stacktype : [addon.stacktype];
                for (const st of addonTypes) {
                  if (!stacktypes.includes(st)) stacktypes.push(st);
                }
              }
            } catch { /* addon not found */ }
          }
        }
        const availableStacks = stacktypes.length > 0
          ? stacktypes.flatMap((st) => contextManager.listStacks(st))
          : [];
        console.log("[validate-parameters DEBUG]", {
          application,
          appObjStacktype: (appObj as any).stacktype,
          stacktypes,
          availableStacksCount: availableStacks.length,
          availableStackIds: availableStacks.map(s => s.id),
          bodyStackId: body.stackId,
          allStacksUnfiltered: contextManager.listStacks().map(s => ({id: s.id, stacktype: s.stacktype})),
        });

        // Build application parameter/property ID set for addon requirements check
        const applicationParamIds = new Set<string>();
        for (const p of appObj.parameters ?? []) applicationParamIds.add(p.id);
        for (const p of appObj.properties ?? []) applicationParamIds.add(p.id);

        // Build known property IDs to suppress "Unknown parameter" warnings.
        // These are internally resolved values (properties, addon properties,
        // backend-injected params) that are valid but not in parameterDefs.
        const knownPropertyIds = new Set<string>();
        for (const p of appObj.properties ?? []) knownPropertyIds.add(p.id);
        if (body.selectedAddons && availableAddons) {
          for (const addonId of body.selectedAddons) {
            const addon = availableAddons.find(a => a.id === addonId);
            for (const p of addon?.properties ?? []) knownPropertyIds.add(p.id);
          }
        }
        for (const id of ["application_id", "vm_id", "previouse_vm_id", "ve_context_key", "deployer_base_url"]) {
          knownPropertyIds.add(id);
        }

        // Inject backend-provided parameters that are always available at runtime
        // but never sent by CLI/frontend (they are set internally by the backend)
        const params = [...body.params];
        const injectIfMissing = (name: string, fallback: string) => {
          if (!params.some(p => p.name === name)) {
            params.push({ name, value: fallback });
          }
        };
        injectIfMissing("application_id", application);
        // For in-place upgrade/reconfigure: vm_id = previouse_vm_id
        const prevVm = params.find(p => p.name === "previouse_vm_id");
        if (prevVm) injectIfMissing("vm_id", prevVm.value);

        const result = validator.validate({
          params,
          parameterDefs,
          ...(body.selectedAddons ? { selectedAddons: body.selectedAddons } : {}),
          availableAddons,
          applicationParamIds,
          knownPropertyIds,
          ...(body.stackId ? { stackId: body.stackId } : {}),
          availableStacks,
        });

        res.status(200).json(result);
      } catch (err: any) {
        res.status(500).json({ error: err?.message || "Validation failed" });
      }
    },
  );
}

import { IVEContext } from "@src/backend-types.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { StorageContext } from "@src/storagecontext.mjs";
import {
  IPostVeConfigurationBody,
  IParameter,
  IParameterValue,
  TaskType,
} from "@src/types.mjs";
import fs from "fs";
import path from "path";

/**
 * Processes parameters for VE configuration, including file uploads and vmInstallContext.
 */
export class WebAppVeParameterProcessor {
  /**
   * Processes parameters: for upload parameters with "local:" prefix, reads file and base64 encodes.
   */
  async processParameters(
    params: IPostVeConfigurationBody["params"],
    loadedParameters: IParameter[],
    storageContext: ContextManager,
  ): Promise<Array<{ id: string; value: string | number | boolean }>> {
    return await Promise.all(
      params.map(async (p) => {
        const paramDef = loadedParameters.find((param) => param.id === p.name);
        if (
          paramDef?.upload &&
          typeof p.value === "string" &&
          p.value.startsWith("local:")
        ) {
          const filePath = p.value.substring(6); // Remove "local:" prefix
          const localPath = storageContext.getLocalPath();
          const fullPath = path.join(localPath, filePath);
          try {
            const fileContent = fs.readFileSync(fullPath);
            const base64Content = fileContent.toString("base64");
            return { id: p.name, value: base64Content };
          } catch (err: any) {
            throw new Error(`Failed to read file ${fullPath}: ${err.message}`);
          }
        }

        // Extract base64 content if value has file metadata format: file:filename:content:base64content
        // This handles cases where the frontend sends the format (shouldn't happen, but for robustness)
        let processedValue: IParameterValue = p.value;
        if (typeof p.value === "string" && paramDef?.upload) {
          const fileMetadataMatch = p.value.match(
            /^file:([^:]+):content:(.+)$/,
          );
          if (fileMetadataMatch && fileMetadataMatch[2]) {
            processedValue = fileMetadataMatch[2]; // Extract only the base64 content
          }
        }

        return { id: p.name, value: processedValue };
      }),
    );
  }

  /**
   * Builds a defaults map from loaded parameters and (optionally) property
   * defaults that did not match a declared parameter.
   *
   * Property defaults declared in project-level templates (e.g.
   * `050-set-project-parameters.json`) target parameter ids that may be
   * declared only by addon templates (e.g. `oidc_issuer_url` in
   * `150-conf-setup-oidc-client.json`). Those addon templates are not
   * processed by `loadApplication`, so `applyPropertyDefaults` finds no
   * matching parameter to update and the project default would otherwise
   * be silently dropped — the runtime resolver would yield NOT_DEFINED.
   *
   * Orphan property defaults (id not present in `loadedParameters`) are
   * therefore seeded into the Map after the parameter pass. Declared
   * parameters keep precedence: their `default` field has already been
   * resolved by `applyPropertyDefaults`, and `defaults.has(id)` shields
   * them from being overwritten here.
   */
  buildDefaults(
    loadedParameters: IParameter[],
    propertyDefaults?: ReadonlyArray<{
      id: string;
      default?: string | number | boolean;
    }>,
  ): Map<string, string | number | boolean> {
    const defaults = new Map<string, string | number | boolean>();
    loadedParameters.forEach((param) => {
      const p = defaults.get(param.name);
      if (!p && param.default !== undefined) {
        // do not overwrite existing defaults
        defaults.set(param.id, param.default);
      }
    });
    if (propertyDefaults) {
      for (const pd of propertyDefaults) {
        if (pd.default !== undefined && !defaults.has(pd.id)) {
          defaults.set(pd.id, pd.default);
        }
      }
    }
    return defaults;
  }

  /**
   * Saves vmInstallContext if changedParams are provided.
   * Returns the vmInstallKey if context was saved, undefined otherwise.
   */
  saveVmInstallContext(
    changedParams: IPostVeConfigurationBody["changedParams"] | undefined,
    veContext: IVEContext,
    application: string,
    task: TaskType,
    storageContext: StorageContext,
  ): string | undefined {
    if (changedParams && changedParams.length > 0) {
      const hostname =
        typeof veContext.host === "string"
          ? veContext.host
          : (veContext.host as any)?.host || "unknown";
      return storageContext.setVMInstallContext({
        hostname,
        application,
        task,
        changedParams: changedParams.map((p) => ({
          name: p.name,
          value: p.value,
        })),
      });
    }
    return undefined;
  }
}

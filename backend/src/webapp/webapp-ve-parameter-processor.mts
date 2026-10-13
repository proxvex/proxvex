import { IVEContext } from "@src/backend-types.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { StorageContext } from "@src/storagecontext.mjs";
import {
  IPostVeConfigurationBody,
  IParameter,
  IParameterValue,
  IDeployParamsSnapshot,
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
   * For in-place upgrade/reconfigure: vm_id = previous_vm_id if not
   * explicitly set. The parameter definition gives vm_id a default of "",
   * so an empty default counts as unset — otherwise host-side scripts
   * substitute {{ vm_id }} with "" (lxc commands fall back on their own).
   */
  applyPreviousVmIdFallback(
    defaults: Map<string, string | number | boolean>,
    params: IPostVeConfigurationBody["params"],
  ): void {
    const current = defaults.get("vm_id");
    if (current !== undefined && current !== "") return;
    const prevParam = params.find((p) => p.name === "previous_vm_id");
    if (prevParam && prevParam.value !== undefined && prevParam.value !== null && prevParam.value !== "") {
      defaults.set("vm_id", String(prevParam.value));
    }
  }

  /**
   * Per-deploy identity / transient parameter names that must NOT be carried
   * into a later reconfigure baseline — they identify the container instance or
   * the current run, and reusing them would be wrong (e.g. restoring a stale
   * previous_vm_id). Excluded from the persisted snapshot.
   */
  private static readonly SNAPSHOT_EXCLUDED_NAMES = new Set<string>([
    "vm_id",
    "previous_vm_id",
    "stack_id",
    "all_stack_ids",
    "debug_level",
    "deploy_params_b64",
  ]);

  /**
   * Builds the base64-encoded JSON snapshot of the submitted deploy payload,
   * persisted into the container notes (`proxvex:deploy-params` marker) so a
   * later reconfigure can reuse the originally-deployed parameter values.
   *
   * Source is the raw `body.params` (before processParameters injects file/cert
   * blobs), so large upload/cert payloads never enter the snapshot. By project
   * decision the snapshot stores everything else INCLUDING secure params.
   * Excluded: per-deploy identity/transient keys (see SNAPSHOT_EXCLUDED_NAMES),
   * empty values, and `upload` params (their value is a transient `local:` path
   * whose content already lives on the migrated volume — restoring the stale
   * reference would break processParameters).
   *
   * Returns "" when there is nothing worth persisting.
   */
  buildDeployParamsSnapshot(
    params: IPostVeConfigurationBody["params"],
    loadedParameters: IParameter[],
    selectedAddons: string[],
    disabledAddons: string[],
    stackIds: string[],
  ): string {
    const keep = (params ?? []).filter((p) => {
      if (WebAppVeParameterProcessor.SNAPSHOT_EXCLUDED_NAMES.has(p.name)) {
        return false;
      }
      if (p.value === undefined || p.value === null || String(p.value) === "") {
        return false;
      }
      const def = loadedParameters.find((d) => d.id === p.name);
      if (def?.upload) {
        return false;
      }
      return true;
    });

    if (
      keep.length === 0 &&
      selectedAddons.length === 0 &&
      disabledAddons.length === 0 &&
      stackIds.length === 0
    ) {
      return "";
    }

    const snapshot: IDeployParamsSnapshot = {
      v: 1,
      params: keep.map((p) => ({ name: p.name, value: p.value })),
      selectedAddons,
      disabledAddons,
      stackIds,
    };
    return Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64");
  }

  /**
   * Decodes a `proxvex:deploy-params` base64 marker into an
   * IDeployParamsSnapshot. Returns undefined for any failure (absent,
   * malformed base64/JSON, or unknown schema version) so callers fall back to
   * today's behavior (no baseline).
   */
  decodeDeployParams(b64?: string): IDeployParamsSnapshot | undefined {
    if (!b64) {
      return undefined;
    }
    try {
      const json = Buffer.from(b64, "base64").toString("utf8");
      const parsed = JSON.parse(json) as IDeployParamsSnapshot;
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.params)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Merges a persisted deploy snapshot into the current request params as a
   * baseline: start from the snapshot params, then overlay the request params
   * by name (request wins). Baseline-only params are appended; a request entry
   * with an empty value does not clobber the baseline. An undefined baseline is
   * an identity no-op.
   *
   * Precedence (highest first): request params > snapshot baseline > defaults
   * map > parameter-definition default (the last two are unchanged downstream).
   */
  mergeDeployBaseline(
    requestParams: IPostVeConfigurationBody["params"],
    baseline: IDeployParamsSnapshot | undefined,
  ): IPostVeConfigurationBody["params"] {
    const request = requestParams ?? [];
    if (!baseline?.params?.length) {
      return request;
    }
    const byName = new Map<string, { name: string; value: IParameterValue }>();
    for (const p of baseline.params) {
      byName.set(p.name, { name: p.name, value: p.value });
    }
    for (const p of request) {
      // An empty request value must not overwrite a real baseline value.
      if (
        byName.has(p.name) &&
        (p.value === undefined || p.value === null || String(p.value) === "")
      ) {
        continue;
      }
      byName.set(p.name, { name: p.name, value: p.value });
    }
    return Array.from(byName.values());
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

import type {
  IParameter,
  IParameterValue,
  IAddonWithParameters,
  IStack,
} from "./types.mjs";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export class ParameterValidator {
  validate(input: {
    params: { name: string; value: IParameterValue }[];
    parameterDefs: IParameter[];
    selectedAddons?: string[];
    availableAddons?: IAddonWithParameters[];
    applicationParamIds?: Set<string>;
    /**
     * Resolved values for parameters set on the application (via property
     * `value:` or `default:`). Used as a third fallback in the addon
     * required-parameter check below: a value the application pins on the
     * parameter satisfies the addon's `required: true` even when the user
     * did not pass it explicitly and the addon's own definition has no
     * default. Without this, applications that override addon parameters
     * (e.g. gitea pinning oidc_redirect_uri to a hostname-based URL) would
     * fail validation.
     */
    applicationParamValues?: Map<string, IParameterValue>;
    knownPropertyIds?: Set<string>;
    stackId?: string;
    availableStacks?: IStack[];
  }): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const {
      params,
      parameterDefs,
      selectedAddons,
      availableAddons,
      stackId,
      availableStacks,
    } = input;

    const paramMap = new Map<string, IParameterValue>();
    for (const p of params) {
      paramMap.set(p.name, p.value);
    }

    // Check required params
    for (const def of parameterDefs) {
      if (!def.required) continue;

      // Conditional requirement: if 'if' is set, only require when the
      // referenced parameter/property has a truthy value
      if (def.if) {
        const condValue = paramMap.get(def.if);
        if (!condValue || condValue === "false" || condValue === "0") continue;
      }

      // Treat the parameter's own default as a fallback for required-checks.
      // Without this, `default: "..."` overrides (used heavily in extends-style
      // applications like zitadel for compose_file) would always fail the
      // required-check because the CLI/frontend sends only explicit user
      // input — defaults live on the parameter definition itself.
      let value: unknown = paramMap.get(def.id);
      if (value === undefined && def.default !== undefined && def.default !== "") {
        value = def.default;
      }
      if (value === undefined || value === "" || value === null) {
        errors.push({
          field: def.id,
          message: `Required parameter '${def.name || def.id}' is missing or empty`,
        });
      }
    }

    // Type checks and enum validation
    for (const p of params) {
      const def = parameterDefs.find((d) => d.id === p.name);
      if (!def) {
        if (!input.knownPropertyIds?.has(p.name)) {
          warnings.push({
            field: p.name,
            message: `Unknown parameter '${p.name}'`,
          });
        }
        continue;
      }

      // Skip type check for empty optional values
      if (
        p.value === "" ||
        p.value === undefined ||
        p.value === null
      ) {
        continue;
      }

      // Type match
      if (def.type === "number") {
        const num =
          typeof p.value === "number"
            ? p.value
            : Number(p.value);
        if (isNaN(num)) {
          errors.push({
            field: p.name,
            message: `Parameter '${def.name || def.id}' must be a number, got '${p.value}'`,
          });
        }
      } else if (def.type === "boolean") {
        if (
          typeof p.value !== "boolean" &&
          p.value !== "true" &&
          p.value !== "false"
        ) {
          errors.push({
            field: p.name,
            message: `Parameter '${def.name || def.id}' must be a boolean, got '${p.value}'`,
          });
        }
      } else if (def.type === "enum") {
        if (def.enumValues && def.enumValues.length > 0) {
          const validValues = def.enumValues.map((ev) =>
            typeof ev === "string" ? ev : String(ev.value),
          );
          if (!validValues.includes(String(p.value))) {
            errors.push({
              field: p.name,
              message: `Parameter '${def.name || def.id}' must be one of [${validValues.join(", ")}], got '${p.value}'`,
            });
          }
        }
      }
    }

    // Validate addon IDs and required_parameters
    if (selectedAddons && selectedAddons.length > 0 && availableAddons) {
      const addonIds = new Set(availableAddons.map((a) => a.id));
      for (const addonId of selectedAddons) {
        if (!addonIds.has(addonId)) {
          errors.push({
            field: "addons",
            message: `Unknown addon '${addonId}'`,
          });
          continue;
        }

        // Check required_parameters: application must define all of them
        if (input.applicationParamIds) {
          const addon = availableAddons.find((a) => a.id === addonId);
          if (addon?.required_parameters?.length) {
            const missing = addon.required_parameters.filter(
              (id) => !input.applicationParamIds!.has(id),
            );
            if (missing.length > 0) {
              errors.push({
                field: "addons",
                message: `Addon '${addon.name}' requires parameters [${missing.join(", ")}] to be defined in the application`,
              });
            }
          }
        }

        // Check the addon's own required:true parameters have a value.
        // Mirrors the application-level required check above (including the
        // default-fallback) so addons with required inputs (e.g. addon-acme's
        // acme_san) fail deploy-time validation instead of silently skipping
        // at pre_start time.
        const addon = availableAddons.find((a) => a.id === addonId);
        if (addon?.parameters?.length) {
          for (const def of addon.parameters) {
            if (!def.required) continue;
            if (def.if) {
              const condValue = paramMap.get(def.if);
              if (!condValue || condValue === "false" || condValue === "0")
                continue;
            }
            // Resolution order (first non-empty wins):
            //   1. Explicit user param (paramMap)
            //   2. Application-level pin (applicationParamValues): set when
            //      the app declares a property with `value:` or `default:`
            //      for this parameter ID — that satisfies the addon's
            //      requirement even though the addon's own definition lacks
            //      a default.
            //   3. The addon's own default
            let value: unknown = paramMap.get(def.id);
            if ((value === undefined || value === "") && input.applicationParamValues) {
              const pinned = input.applicationParamValues.get(def.id);
              if (pinned !== undefined && pinned !== "") {
                value = pinned;
              }
            }
            if ((value === undefined || value === "") && def.default !== undefined && def.default !== "") {
              value = def.default;
            }
            if (value === undefined || value === "" || value === null) {
              errors.push({
                field: def.id,
                message: `Addon '${addon.name}' requires parameter '${def.name || def.id}' to be set`,
              });
            }
          }
        }
      }
    }

    // Validate stack ID (match by id only — use stackId consistently)
    if (stackId && availableStacks) {
      const found = availableStacks.some((s) => s.id === stackId);
      if (!found) {
        errors.push({
          field: "stackId",
          message: `Unknown stack '${stackId}'`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

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

      const value = paramMap.get(def.id);
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
        warnings.push({
          field: p.name,
          message: `Unknown parameter '${p.name}'`,
        });
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
      }
    }

    // Validate stack ID
    if (stackId && availableStacks) {
      const stackIds = new Set(availableStacks.map((s) => s.id));
      if (!stackIds.has(stackId)) {
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

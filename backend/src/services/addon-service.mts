import { IApplication } from "../backend-types.mjs";
import {
  IAddon,
  IAddonWithParameters,
  AddonTemplateReference,
  IParameter,
} from "../types.mjs";
import {
  IAddonPersistence,
  ITemplatePersistence,
} from "../persistence/interfaces.mjs";

/**
 * Service layer for addon operations
 * Provides business logic for addon compatibility and template merging
 */
export class AddonService {
  constructor(
    private persistence: IAddonPersistence,
    private templatePersistence?: ITemplatePersistence,
  ) {}

  /**
   * Returns all addon IDs
   */
  getAddonIds(): string[] {
    return this.persistence.getAddonIds();
  }

  /**
   * Loads an addon by ID
   */
  getAddon(addonId: string): IAddon {
    return this.persistence.loadAddon(addonId);
  }

  /**
   * Returns all addons
   */
  getAllAddons(): IAddon[] {
    return this.persistence.getAllAddons();
  }

  /**
   * Returns addons compatible with the given application
   */
  getCompatibleAddons(application: IApplication): IAddon[] {
    return this.getAllAddons().filter((addon) =>
      this.isAddonCompatible(addon, application),
    );
  }

  /**
   * Returns all addons with extracted parameters (no compatibility filtering)
   */
  getAllAddonsWithParameters(): IAddonWithParameters[] {
    return this.getAllAddons().map((addon) => this.extractAddonParameters(addon));
  }

  /**
   * Returns addons compatible with the given application, including extracted parameters.
   * Parameters already set by the application's properties (with value) are removed
   * from the addon's parameter list so they don't appear in the UI.
   *
   * When installedAddonIds is provided, those addons are always included
   * regardless of compatibility (needed for reconfigure to allow disabling).
   */
  getCompatibleAddonsWithParameters(
    application: IApplication,
    installedAddonIds?: string[],
  ): IAddonWithParameters[] {
    // Collect parameter IDs that the application already provides.
    // These are removed from addon parameter lists so the UI doesn't show duplicates.
    // Includes: parameters from application.json + properties with explicit value.
    const appResolvedIds = new Set<string>();
    for (const p of application.parameters ?? []) {
      appResolvedIds.add(p.id);
    }
    for (const prop of application.properties ?? []) {
      if (prop.value !== undefined) {
        appResolvedIds.add(prop.id);
      }
    }

    const compatibleAddons = this.getCompatibleAddons(application);
    const compatibleIds = new Set(compatibleAddons.map((a) => a.id));

    // Add installed addons that are not already in the compatible list
    const allAddons = [...compatibleAddons];
    if (installedAddonIds?.length) {
      for (const addonId of installedAddonIds) {
        if (!compatibleIds.has(addonId)) {
          try {
            const addon = this.getAddon(addonId);
            allAddons.push(addon);
          } catch {
            // Addon no longer exists, skip
          }
        }
      }
    }

    return allAddons.map((addon) => {
      const withParams = this.extractAddonParameters(addon);
      if (withParams.parameters && appResolvedIds.size > 0) {
        withParams.parameters = withParams.parameters.filter(
          (p) => !appResolvedIds.has(p.id),
        );
      }
      return withParams;
    });
  }

  /**
   * Gets parameters for an addon.
   * Prefers parameters defined directly in addon JSON over extracting from templates.
   */
  extractAddonParameters(addon: IAddon): IAddonWithParameters {
    let parameters: IParameter[];

    // If addon has parameters defined directly, use those (new approach)
    if (addon.parameters && addon.parameters.length > 0) {
      parameters = [...addon.parameters];
    } else if (!this.templatePersistence) {
      // No template persistence, no parameters to extract
      return this.applyParameterOverrides(addon, []);
    } else {
      // Fallback: extract parameters from addon templates (legacy approach)
      // Collect templates from all phases (installation, reconfigure, upgrade)
      const allTemplateRefs: AddonTemplateReference[] = [
        ...(addon.installation?.pre_start ?? []),
        ...(addon.installation?.post_start ?? []),
        ...(addon.reconfigure?.pre_start ?? []),
        ...(addon.reconfigure?.post_start ?? []),
        ...(addon.upgrade ?? []),
      ];

      parameters = [];
      const seenParamIds = new Set<string>();

      for (const templateRef of allTemplateRefs) {
        const templateName = this.getTemplateName(templateRef);
        const extractedParams =
          this.extractParametersFromTemplate(templateName);

        for (const param of extractedParams) {
          // Avoid duplicate parameters
          if (!seenParamIds.has(param.id)) {
            seenParamIds.add(param.id);
            parameters.push(param);
          }
        }
      }
    }

    return this.applyParameterOverrides(addon, parameters);
  }

  /**
   * Applies parameterOverrides from addon to the given parameters
   */
  private applyParameterOverrides(
    addon: IAddon,
    parameters: IParameter[],
  ): IAddonWithParameters {
    // Apply addon-level parameter overrides
    if (addon.parameterOverrides) {
      for (const override of addon.parameterOverrides) {
        const param = parameters.find((p) => p.id === override.id);
        if (param) {
          if (override.name) param.name = override.name;
          if (override.description) param.description = override.description;
        }
      }
    }

    // Internal parameters never reach the UI — strip them from the response.
    const visible = parameters.filter((p) => !p.internal);

    if (visible.length === 0) {
      return addon;
    }

    return {
      ...addon,
      parameters: visible,
    };
  }

  /**
   * Extracts parameters from a single template by name
   */
  private extractParametersFromTemplate(templateName: string): IParameter[] {
    if (!this.templatePersistence) {
      return [];
    }

    try {
      // Addon templates are typically shared templates
      const templatePath = this.templatePersistence.resolveTemplatePath(
        templateName,
        true,
      );
      if (!templatePath) {
        return [];
      }

      const template = this.templatePersistence.loadTemplate(templatePath);
      if (!template || !template.parameters) {
        return [];
      }

      return template.parameters;
    } catch {
      // Template not found or invalid
      return [];
    }
  }

  /**
   * Checks if an addon is compatible with an application
   *
   * Compatibility is determined by the application's supported_addons list.
   * The addon's ID must be included in the application's supported_addons array.
   * supported_addons is inherited and merged through the extends chain.
   */
  isAddonCompatible(addon: IAddon, application: IApplication): boolean {
    // Check required_parameters: application must define all of them
    if (addon.required_parameters?.length) {
      const appParamIds = new Set<string>();
      for (const p of application.parameters ?? []) appParamIds.add(p.id);
      for (const p of application.properties ?? []) appParamIds.add(p.id);
      if (!addon.required_parameters.every((id) => appParamIds.has(id))) {
        return false;
      }
    }

    // Application must explicitly list addon in supported_addons
    return application.supported_addons?.includes(addon.id) ?? false;
  }

  /**
   * Merges addon templates into base templates
   *
   * @param baseTemplates The application's base template list
   * @param addon The addon to merge
   * @param taskKey The task context: "installation", "reconfigure", or "upgrade"
   * @param phase Which phase templates to merge (pre_start, post_start) - not used for upgrade
   * @returns New template list with addon templates inserted
   */
  mergeAddonTemplates(
    baseTemplates: AddonTemplateReference[],
    addon: IAddon,
    taskKey: "installation" | "reconfigure" | "upgrade",
    phase?: "pre_start" | "post_start",
  ): AddonTemplateReference[] {
    let addonTemplates: AddonTemplateReference[] | undefined;

    if (taskKey === "upgrade") {
      addonTemplates = addon.upgrade;
    } else if (phase) {
      addonTemplates = addon[taskKey]?.[phase];
    }

    if (!addonTemplates || addonTemplates.length === 0) {
      return baseTemplates;
    }

    const result = [...baseTemplates];

    for (const template of addonTemplates) {
      this.insertTemplate(result, template);
    }

    return result;
  }

  /**
   * Inserts a template at the correct position based on before/after references
   */
  private insertTemplate(
    templates: AddonTemplateReference[],
    template: AddonTemplateReference,
  ): void {
    // If it's just a string, append to end
    if (typeof template === "string") {
      templates.push(template);
      return;
    }

    // Handle before reference
    if (template.before) {
      const idx = this.findTemplateIndex(templates, template.before);
      if (idx >= 0) {
        templates.splice(idx, 0, template.name);
        return;
      }
    }

    // Handle after reference
    if (template.after) {
      const idx = this.findTemplateIndex(templates, template.after);
      if (idx >= 0) {
        templates.splice(idx + 1, 0, template.name);
        return;
      }
    }

    // Default: append to end
    templates.push(typeof template === "string" ? template : template.name);
  }

  /**
   * Finds the index of a template by name in the template list
   */
  private findTemplateIndex(
    templates: AddonTemplateReference[],
    targetName: string,
  ): number {
    return templates.findIndex((t) => {
      const name = typeof t === "string" ? t : t.name;
      return name === targetName;
    });
  }

  /**
   * Extracts template name from a reference
   */
  getTemplateName(template: AddonTemplateReference): string {
    return typeof template === "string" ? template : template.name;
  }
}

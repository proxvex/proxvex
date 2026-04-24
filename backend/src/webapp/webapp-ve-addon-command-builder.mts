import {
  TaskType,
  ICommand,
  ITemplate,
  IOutputObject,
} from "@src/types.mjs";
import { IApplication } from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateResolver } from "@src/templates/template-resolver.mjs";

/**
 * Builds and inserts addon commands into the command pipeline.
 * Handles pre_start/post_start phase placement, notes updates,
 * and addon disable/removal flows.
 */
export class WebAppVeAddonCommandBuilder {
  private pm: PersistenceManager;

  constructor() {
    this.pm = PersistenceManager.getInstance();
  }

  /**
   * Maps task types to addon configuration keys.
   */
  private getAddonKeyForTask(
    task: TaskType,
  ): "installation" | "reconfigure" | "upgrade" | null {
    switch (task) {
      case "installation":
        return "installation";
      case "reconfigure":
        return "reconfigure";
      case "upgrade":
        return "upgrade";
      default:
        return null;
    }
  }

  /**
   * Loads addon commands for a specific phase (pre_start or post_start).
   * Returns an array of ICommand objects ready for execution.
   */
  private async loadAddonCommandsForPhase(
    addonIds: string[],
    task: TaskType,
    phase: "pre_start" | "post_start",
    application?: IApplication,
  ): Promise<ICommand[]> {
    const addonKey = this.getAddonKeyForTask(task);
    if (!addonKey) {
      return [];
    }

    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();
    const resolver = new TemplateResolver(repositories);
    const commands: ICommand[] = [];

    for (const addonId of addonIds) {
      let addon;
      try {
        addon = addonService.getAddon(addonId);
      } catch {
        console.warn(`Addon not found: ${addonId}, skipping`);
        continue;
      }

      // Get templates for the phase from the appropriate addon key
      let templateRefs;
      if (addonKey === "upgrade") {
        // upgrade is flat — load for both pre_start and post_start phases
        // (templates may be in either category directory)
        templateRefs = (phase === "pre_start" || phase === "post_start") ? addon.upgrade : undefined;
      } else {
        // installation and reconfigure have nested structure
        const addonConfig = addon[addonKey];
        templateRefs = addonConfig?.[phase];
      }

      if (!templateRefs || templateRefs.length === 0) {
        continue;
      }

      // Add addon properties as commands first (only for pre_start to avoid duplicates)
      // Always inject if addon has notes_key (for has_addon_* marker property)
      if (phase === "pre_start" && (addon.properties?.length || addon.notes_key)) {
        const appProperties = application?.properties ?? [];
        const resolvedProps: IOutputObject[] = (addon.properties ?? []).map((prop) => {
          // Check if application overrides this addon property
          const appOverride = appProperties.find((p: IOutputObject) => p.id === prop.id);
          const value = appOverride?.value !== undefined ? appOverride.value : prop.value;
          return {
            id: prop.id,
            value: value as string | number | boolean,
          };
        });

        // Auto-inject unprefixed aliases for shared scripts
        // e.g. "ssl.addon_volumes" also injects "addon_volumes"
        const aliasProps: IOutputObject[] = [];
        for (const prop of resolvedProps) {
          const dotIdx = String(prop.id).indexOf(".");
          if (dotIdx > 0) {
            const unprefixed = String(prop.id).substring(dotIdx + 1);
            if (!resolvedProps.find((p) => p.id === unprefixed)) {
              aliasProps.push({
                id: unprefixed,
                value: prop.value as string | number | boolean,
              });
            }
          }
        }
        resolvedProps.push(...aliasProps);

        // Auto-inject addon marker property for check templates
        // e.g. has_addon_ssl, has_addon_oidc — used by skip_if_all_missing
        if (addon.notes_key) {
          resolvedProps.push({ id: `has_addon_${addon.notes_key}`, value: "true" });
        }

        // Inject oidc_roles from application as JSON string for role creation in Zitadel
        if (addonId === "addon-oidc" && application?.oidc_roles?.length) {
          resolvedProps.push({
            id: "oidc_roles",
            value: JSON.stringify(application.oidc_roles),
          });
        }

        const propertiesCommand: ICommand = {
          name: `${addon.name} Properties`,
          properties: resolvedProps,
        };
        commands.push(propertiesCommand);
      }

      // Load templates and build commands
      // Map phase to template category directory
      const categoryMap: Record<string, string> = {
        pre_start: "pre_start",
        post_start: "post_start",
      };
      const category = categoryMap[phase] ?? "root";

      for (const templateRef of templateRefs) {
        const templateName =
          typeof templateRef === "string" ? templateRef : templateRef.name;

        // For upgrade templates, try the phase category first, then fallback
        // to the other category (upgrade templates may be in pre_start or post_start)
        let template = repositories.getTemplate({
          name: templateName,
          scope: "shared",
          category,
        }) as ITemplate | null;

        if (!template && addonKey === "upgrade") {
          const fallbackCategory = category === "post_start" ? "pre_start" : "post_start";
          template = repositories.getTemplate({
            name: templateName,
            scope: "shared",
            category: fallbackCategory,
          }) as ITemplate | null;
        }

        if (template && template.commands) {
          // Determine the actual category where the template was found
          // (may differ from phase for upgrade templates with fallback)
          const resolvedCategory = repositories.getTemplate({
            name: templateName, scope: "shared", category,
          }) ? category : (category === "post_start" ? "pre_start" : "post_start");

          for (const cmd of template.commands) {
            const command: ICommand = { ...cmd };

            // Set command name from template name if missing (same logic as TemplateProcessor)
            if (!command.name || command.name.trim() === "") {
              command.name = template.name || templateName;
            }

            // Set execute_on from template if not on command
            if (!command.execute_on && template.execute_on) {
              command.execute_on = template.execute_on;
            }

            // Resolve script content with application-scope fallback
            // (allows applications to override shared addon scripts)
            if (cmd.script && !cmd.scriptContent) {
              const appId = application?.id ?? "";
              if (appId) {
                const resolved = resolver.resolveScriptContent(appId, cmd.script, resolvedCategory);
                if (resolved.content) {
                  command.scriptContent = resolved.content;
                }
              } else {
                const scriptContent = repositories.getScript({
                  name: cmd.script,
                  scope: "shared",
                  category: resolvedCategory,
                });
                if (scriptContent) {
                  command.scriptContent = scriptContent;
                }
              }
            }

            // Resolve library content with application-scope fallback
            if (cmd.library && !cmd.libraryContent) {
              const libraries = Array.isArray(cmd.library) ? cmd.library : [cmd.library];
              const allContents: string[] = [];
              const appId = application?.id ?? "";
              for (const lib of libraries) {
                if (appId) {
                  const resolved = resolver.resolveLibraryContent(appId, lib);
                  if (resolved.content) {
                    allContents.push(resolved.content);
                  }
                } else {
                  const libraryContent = repositories.getScript({
                    name: lib,
                    scope: "shared",
                    category: "library",
                  });
                  if (libraryContent) {
                    allContents.push(libraryContent);
                  }
                }
              }
              if (allContents.length > 0) {
                command.libraryContent = allContents.join("\n\n");
              }
            }

            commands.push(command);
          }
        }
      }
    }

    return commands;
  }

  /**
   * Adds notes update commands for all selected addons.
   */
  private addAddonNotesCommands(
    commands: ICommand[],
    addonIds: string[],
    notesIndex: number
  ): void {
    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();

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
      for (const addonId of addonIds) {
        let addon;
        try {
          addon = addonService.getAddon(addonId);
        } catch {
          continue;
        }
        // Properties command sets addon_id (must be separate from script command
        // because VeExecution skips script execution for commands with properties)
        commands.splice(notesIndex, 0,
          {
            name: `Set Addon ID: ${addon.name}`,
            properties: [{ id: "addon_id", value: addonId }],
          },
          {
            name: `Update LXC Notes with Addon: ${addon.name}`,
            execute_on: "ve",
            script: "host-update-lxc-notes-addon.py",
            scriptContent: notesUpdateScript,
            libraryContent: notesUpdateLibrary,
            outputs: ["success"],
          },
        );
        notesIndex += 2; // Advance past the two commands we just inserted
      }
    }
  }

  /**
   * Finds the insertion index for addon commands based on phase.
   * Uses command.category (set by TemplateProcessor) for reliable phase detection.
   * pre_start: insert BEFORE the first "pre_start_finalize" or "start" command —
   *   pre_start_finalize is reserved for framework cleanup (volume unmount) that
   *   must remain the last pre-boot step, so addon pre_start commands have to
   *   land ahead of it.
   * post_start: insert BEFORE the first "replace_ct" category command (if present).
   */
  private findAddonInsertionIndex(
    commands: ICommand[],
    phase: "pre_start" | "post_start",
  ): number {
    if (phase === "pre_start") {
      for (let i = 0; i < commands.length; i++) {
        const cat = commands[i]?.category;
        if (cat === "pre_start_finalize" || cat === "start") return i;
      }
    }

    if (phase === "post_start") {
      for (let i = 0; i < commands.length; i++) {
        if (commands[i]?.category === "replace_ct") return i;
      }
    }

    return commands.length;
  }

  /**
   * Inserts addon commands at the correct position for the given phase.
   */
  async insertAddonCommands(
    commands: ICommand[],
    addonIds: string[],
    task: TaskType,
    application?: IApplication,
  ): Promise<ICommand[]> {
    if (addonIds.length === 0) {
      return commands;
    }

    const result = [...commands];

    // Load and insert pre_start commands
    const preStartCommands = await this.loadAddonCommandsForPhase(
      addonIds,
      task,
      "pre_start",
      application,
    );
    if (preStartCommands.length > 0) {
      // Addon property commands (e.g. addon_volumes from SSL addon) must be
      // injected at the beginning of the pipeline so their values are available
      // to application templates like 150-conf-create-storage-volumes-for-lxc.
      // Script commands are inserted at the normal pre_start position (before Start LXC).
      const propertyCommands = preStartCommands.filter(
        (cmd) => cmd.properties && !cmd.script && !cmd.scriptContent,
      );
      const scriptCommands = preStartCommands.filter(
        (cmd) => !cmd.properties || cmd.script || cmd.scriptContent,
      );

      if (propertyCommands.length > 0) {
        result.splice(0, 0, ...propertyCommands);
      }
      if (scriptCommands.length > 0) {
        const preStartIndex = this.findAddonInsertionIndex(result, "pre_start");
        result.splice(preStartIndex, 0, ...scriptCommands);
      }
    }

    // Load and insert post_start commands
    const postStartCommands = await this.loadAddonCommandsForPhase(
      addonIds,
      task,
      "post_start",
      application,
    );
    if (postStartCommands.length > 0) {
      const postStartIndex = this.findAddonInsertionIndex(result, "post_start");
      result.splice(postStartIndex, 0, ...postStartCommands);
    }

    // Add notes update commands BEFORE "Start LXC Container" (pre_start position).
    // Must run AFTER "Write LXC Notes" (from conf-create-configure-lxc) which is
    // already in the result array before the addon commands are inserted.
    // Skip for hidden apps (e.g. proxmox host) which have no LXC container notes.
    if (
      (preStartCommands.length > 0 || postStartCommands.length > 0) &&
      !application?.hidden
    ) {
      const notesIndex = this.findAddonInsertionIndex(result, "pre_start");
      this.addAddonNotesCommands(result, addonIds, notesIndex);
    }

    return result;
  }

  /**
   * Loads disable commands for a specific phase from all disabled addons.
   */
  private loadDisableCommandsForPhase(
    disabledAddonIds: string[],
    phase: "pre_start" | "post_start",
    application?: IApplication,
  ): ICommand[] {
    const addonService = this.pm.getAddonService();
    const repositories = this.pm.getRepositories();
    const resolver = new TemplateResolver(repositories);
    const commands: ICommand[] = [];

    for (const addonId of disabledAddonIds) {
      let addon;
      try {
        addon = addonService.getAddon(addonId);
      } catch {
        console.warn(`Addon not found for disable: ${addonId}, skipping`);
        continue;
      }

      const templateRefs = addon.disable?.[phase];
      if (!templateRefs || templateRefs.length === 0) {
        continue;
      }

      for (const templateRef of templateRefs) {
        const templateName =
          typeof templateRef === "string" ? templateRef : templateRef.name;

        const template = repositories.getTemplate({
          name: templateName,
          scope: "shared",
          category: phase,
        }) as ITemplate | null;

        if (template && template.commands) {
          for (const cmd of template.commands) {
            const command: ICommand = { ...cmd };

            if (!command.name || command.name.trim() === "") {
              command.name = template.name || templateName;
            }
            if (!command.execute_on && template.execute_on) {
              command.execute_on = template.execute_on;
            }
            if (cmd.script && !cmd.scriptContent) {
              const appId = application?.id ?? "";
              if (appId) {
                const resolved = resolver.resolveScriptContent(appId, cmd.script, phase);
                if (resolved.content) {
                  command.scriptContent = resolved.content;
                }
              } else {
                const scriptContent = repositories.getScript({
                  name: cmd.script,
                  scope: "shared",
                  category: phase,
                });
                if (scriptContent) {
                  command.scriptContent = scriptContent;
                }
              }
            }
            if (cmd.library && !cmd.libraryContent) {
              const libraries = Array.isArray(cmd.library) ? cmd.library : [cmd.library];
              const allContents: string[] = [];
              const appId = application?.id ?? "";
              for (const lib of libraries) {
                if (appId) {
                  const resolved = resolver.resolveLibraryContent(appId, lib);
                  if (resolved.content) {
                    allContents.push(resolved.content);
                  }
                } else {
                  const libraryContent = repositories.getScript({
                    name: lib,
                    scope: "shared",
                    category: "library",
                  });
                  if (libraryContent) {
                    allContents.push(libraryContent);
                  }
                }
              }
              if (allContents.length > 0) {
                command.libraryContent = allContents.join("\n\n");
              }
            }

            commands.push(command);
          }
        }
      }
    }

    return commands;
  }

  /**
   * Inserts addon disable commands and notes removal commands for disabled addons.
   * Supports both pre_start (before container start) and post_start (after start) phases.
   */
  async insertAddonDisableCommands(
    commands: ICommand[],
    disabledAddonIds: string[],
    application?: IApplication,
  ): Promise<ICommand[]> {
    if (disabledAddonIds.length === 0) {
      return commands;
    }

    const result = [...commands];

    // Load and insert pre_start disable commands (before container start)
    const preStartCommands = this.loadDisableCommandsForPhase(disabledAddonIds, "pre_start", application);
    if (preStartCommands.length > 0) {
      const preStartIndex = this.findAddonInsertionIndex(result, "pre_start");
      result.splice(preStartIndex, 0, ...preStartCommands);
    }

    // Load and append post_start disable commands (after container start)
    const postStartCommands = this.loadDisableCommandsForPhase(disabledAddonIds, "post_start", application);
    if (postStartCommands.length > 0) {
      result.push(...postStartCommands);
    }

    // Add notes removal commands BEFORE "Start LXC Container" (pre_start position)
    const removalNotesIndex = this.findAddonInsertionIndex(result, "pre_start");
    this.addAddonNotesRemovalCommands(result, disabledAddonIds, removalNotesIndex);

    return result;
  }

  /**
   * Adds notes removal commands for disabled addons.
   */
  private addAddonNotesRemovalCommands(
    commands: ICommand[],
    addonIds: string[],
    notesIndex: number,
  ): void {
    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();

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
      for (const addonId of addonIds) {
        let addon;
        try {
          addon = addonService.getAddon(addonId);
        } catch {
          continue;
        }
        // Properties command sets addon_id and addon_action (must be separate from
        // script command because VeExecution skips script execution for commands with properties)
        commands.splice(notesIndex, 0,
          {
            name: `Set Addon ID for Removal: ${addon.name}`,
            properties: [
              { id: "addon_id", value: addonId },
              { id: "addon_action", value: "remove" },
            ],
          },
          {
            name: `Remove Addon from Notes: ${addon.name}`,
            execute_on: "ve",
            script: "host-update-lxc-notes-addon.py",
            scriptContent: notesUpdateScript,
            libraryContent: notesUpdateLibrary,
            outputs: ["success"],
          },
        );
        notesIndex += 2;
      }
    }
  }
}

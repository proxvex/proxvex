import { ICommand, IVeExecuteMessage } from "../types.mjs";
import { VariableResolver } from "../variable-resolver.mjs";
import { getNextMessageIndex } from "./ve-execution-constants.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";

export interface CommandProcessorDependencies {
  outputs: Map<string, string | number | boolean>;
  inputs: Record<string, string | number | boolean>;
  /**
   * Defaults map — auto-injected values like deployer_base_url,
   * application_id, ve_context_key. Exposed on deps so the debug-dump hook
   * can show exactly what the variable resolver sees. Optional to keep
   * existing tests/instantiations working; debug dump falls back to an empty
   * map when not provided.
   */
  defaults?: Map<string, string | number | boolean>;
  variableResolver: VariableResolver;
  messageEmitter: VeExecutionMessageEmitter;
  runOnLxc: (
    vm_id: string | number,
    command: string,
    tmplCommand: ICommand,
    execUid?: number,
    execGid?: number,
    timeoutMs?: number,
  ) => Promise<IVeExecuteMessage>;
  runOnVeHost: (
    input: string,
    tmplCommand: ICommand,
    timeoutMs?: number,
  ) => Promise<IVeExecuteMessage>;
  executeOnHost: (
    hostname: string,
    command: string,
    tmplCommand: ICommand,
  ) => Promise<void>;
  outputsRaw: { name: string; value: string | number | boolean }[] | undefined;
  setOutputsRaw: (
    raw: { name: string; value: string | number | boolean }[],
  ) => void;
  /**
   * Resolves an application_id to a vm_id by finding the container with that app-id.
   * Throws if 0 or 2+ containers match.
   */
  resolveApplicationToVmId?: (appId: string) => Promise<number>;
  /** Global VE libraries keyed by language: "sh" -> content, "py" -> content */
  globalVeLibraries?: Map<string, string>;
}

/**
 * Handles command processing for VeExecution.
 */
export class VeExecutionCommandProcessor {
  constructor(private deps: CommandProcessorDependencies) {}

  /**
   * Debug-dump the command's inputs/defaults (before) or outputs (after) if
   * the user enabled it via the `ve_debug_commands` parameter. Matching is
   * case-insensitive substring against `cmd.name`; the entry `*` matches
   * everything. Leave the parameter empty to disable.
   *
   * Configured via an advanced input field (declared in
   * 100-conf-create-configure-lxc.json), so it can be flipped on per-deploy
   * from the UI/CLI/params file without code changes. Kept deliberately
   * lenient — never throws, swallows any error.
   *
   * Examples:
   *   "ve_debug_commands": "Write Docker Compose Notes"
   *   "ve_debug_commands": "notes,acme"
   *   "ve_debug_commands": "*"
   */
  private debugDumpContext(
    cmd: ICommand,
    phase: "before" | "after",
  ): void {
    const defaults = this.deps.defaults ?? new Map();
    const raw =
      (this.deps.inputs["ve_debug_commands"] as string | undefined) ??
      (defaults.get("ve_debug_commands") as string | undefined) ??
      "";
    if (!raw || typeof raw !== "string") return;

    const filters = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (filters.length === 0) return;

    const cmdName = (cmd.name ?? "").toLowerCase();
    const match =
      filters.includes("*") ||
      filters.some((f) => cmdName.includes(f.toLowerCase()));
    if (!match) return;

    try {
      const payload: Record<string, unknown> = {
        command: cmd.name ?? "",
        phase,
      };
      if (phase === "before") {
        payload.inputs = { ...this.deps.inputs };
        payload.defaults = Object.fromEntries(defaults);
      } else {
        payload.outputs = Object.fromEntries(this.deps.outputs);
      }
      const serialized = JSON.stringify(payload, null, 2);
      process.stderr.write(
        `[VE_DEBUG ${phase}] ${cmd.name ?? ""}\n${serialized}\n`,
      );
    } catch {
      /* debug-only; never break execution */
    }
  }

  /**
   * Handles a skipped command by emitting a message.
   */
  handleSkippedCommand(cmd: ICommand, msgIndex: number): number {
    // Use getNextMessageIndex() to ensure consistency with other commands
    const index = getNextMessageIndex();
    this.deps.messageEmitter.emitStandardMessage(
      cmd,
      cmd.description || "Skipped: all required parameters missing",
      null,
      0,
      index,
    );
    return msgIndex + 1;
  }

  /**
   * Processes a single property entry and sets it in outputs if valid.
   */
  private processPropertyEntry(entry: { id: string; value?: any }): void {
    if (
      !entry ||
      typeof entry !== "object" ||
      !entry.id ||
      entry.value === undefined
    ) {
      return;
    }

    let value = entry.value;
    // Replace variables in value if it's a string
    if (typeof value === "string") {
      value = this.deps.variableResolver.replaceVars(value);
      // Skip property if value is "NOT_DEFINED" (optional parameter not set)
      if (value === "NOT_DEFINED") {
        return; // Skip this property
      }
    }
    // Only set if value is a primitive type (not array)
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      this.deps.outputs.set(entry.id, value);
    }
  }

  /**
   * Handles a properties command by processing all properties and emitting a message.
   */
  handlePropertiesCommand(cmd: ICommand, msgIndex: number): number {
    try {
      if (Array.isArray(cmd.properties)) {
        // Array of {id, value} objects
        for (const entry of cmd.properties) {
          this.processPropertyEntry(entry);
        }
      } else if (
        cmd.properties &&
        typeof cmd.properties === "object" &&
        "id" in cmd.properties
      ) {
        // Single object with id and value
        this.processPropertyEntry(
          cmd.properties as { id: string; value?: any },
        );
      }

      // Emit success message
      // Use command name (which should be set from template name) or fallback to "properties"
      const commandName =
        cmd.name && cmd.name.trim() !== "" ? cmd.name : "properties";
      const propertiesCmd = { ...cmd, name: commandName };
      // Use getNextMessageIndex() to ensure consistency with other commands
      const index = getNextMessageIndex();
      this.deps.messageEmitter.emitStandardMessage(
        propertiesCmd,
        "",
        JSON.stringify(cmd.properties),
        0,
        index,
      );
      return msgIndex + 1;
    } catch (err: any) {
      const msg = `Failed to process properties: ${err?.message || err}`;
      // Use command name (which should be set from template name) or fallback to "properties"
      const commandName =
        cmd.name && cmd.name.trim() !== "" ? cmd.name : "properties";
      const propertiesCmd = { ...cmd, name: commandName };
      // Use getNextMessageIndex() to ensure consistency with other commands
      const index = getNextMessageIndex();
      this.deps.messageEmitter.emitStandardMessage(
        propertiesCmd,
        msg,
        null,
        -1,
        index,
      );
      return msgIndex + 1;
    }
  }

  /**
   * Extracts interpreter from shebang line.
   * Returns the interpreter array or null if no shebang found.
   */
  private extractInterpreterFromShebang(content: string): string[] | null {
    const lines = content.split("\n");
    const firstLine = lines[0];
    if (!firstLine || !firstLine.startsWith("#!")) {
      return null;
    }

    const shebang = firstLine.substring(2).trim();
    // Parse shebang: /usr/bin/env python3 -> ['python3']
    // or /usr/bin/python3 -> ['/usr/bin/python3']
    // or /usr/bin/env -S perl -w -> ['perl', '-w']
    let interpreter: string[] = [];

    if (shebang.includes(" ")) {
      const parts = shebang.split(/\s+/).filter((s) => s.length > 0);
      // Handle /usr/bin/env python3 -> extract 'python3'
      if (parts.length > 0 && parts[0]) {
        const firstPart = parts[0];
        if (
          firstPart === "/usr/bin/env" ||
          firstPart === "/bin/env" ||
          firstPart === "env"
        ) {
          interpreter = parts.slice(1); // Skip 'env', take rest
        } else if (firstPart.endsWith("/env")) {
          interpreter = parts.slice(1); // Handle any path ending with /env
        } else {
          interpreter = parts; // Use all parts for explicit paths
        }
      }
    } else {
      interpreter = [shebang];
    }

    return interpreter.length > 0 ? interpreter : null;
  }

  /**
   * Detect script language from filename extension.
   * Returns "sh" for shell, "py" for Python.
   */
  private detectLanguage(filename?: string): "sh" | "py" {
    if (filename && /\.py$/.test(filename)) return "py";
    return "sh";
  }

  /**
   * Get global VE library content for the given language, if available.
   */
  private getGlobalVeLibrary(cmd: ICommand): string | null {
    if (!this.deps.globalVeLibraries) return null;
    const lang = this.detectLanguage(cmd.script ?? cmd.library);
    return this.deps.globalVeLibraries.get(lang) ?? null;
  }

  /**
   * Check if command targets the VE host (execute_on: "ve").
   */
  private isVeTarget(cmd: ICommand): boolean {
    return cmd.execute_on === "ve";
  }

  /**
   * Loads command content from script file or command string.
   * If a library is specified, it will be prepended to the content.
   * For VE-target commands, the global VE library is always prepended.
   * Extracts interpreter from library's shebang when library is present,
   * otherwise from script's shebang.
   */
  loadCommandContent(cmd: ICommand): string | null {
    // Check if library is specified but content is missing
    if (
      (cmd.library !== undefined || cmd.libraryPath !== undefined) &&
      cmd.libraryContent === undefined
    ) {
      throw new Error("Library content missing for command");
    }

    // Extract interpreter from library's shebang when library is present
    // (the library determines the language, not the script/command)
    // If library has no shebang, fall back to script's shebang
    let interpreterSet = false;
    if (cmd.libraryContent !== undefined) {
      const interpreter = this.extractInterpreterFromShebang(
        cmd.libraryContent,
      );
      if (interpreter) {
        (cmd as any)._interpreter = interpreter;
        interpreterSet = true;
      }
    }

    if (cmd.scriptContent !== undefined) {
      const scriptContent = cmd.scriptContent;

      // Extract interpreter from script's shebang if:
      // - No library is present, OR
      // - Library is present but has no shebang (fallback)
      if (!interpreterSet) {
        const interpreter = this.extractInterpreterFromShebang(scriptContent);
        if (interpreter) {
          (cmd as any)._interpreter = interpreter;
        }
      }

      // Assemble: global VE library + template library + script
      const globalLib = this.isVeTarget(cmd)
        ? this.getGlobalVeLibrary(cmd)
        : null;

      if (globalLib || cmd.libraryContent !== undefined) {
        const parts: string[] = [];
        if (globalLib) parts.push(globalLib);
        if (cmd.libraryContent !== undefined) parts.push(cmd.libraryContent);
        const libBlock = parts.join("\n\n");
        return `${libBlock}\n\n# --- Script starts here ---\n${scriptContent}`;
      }

      return scriptContent;
    } else if (cmd.script !== undefined) {
      throw new Error(`Script content missing for ${cmd.script}`);
    } else if (cmd.command !== undefined) {
      // Assemble: global VE library + template library + command
      const globalLib = this.isVeTarget(cmd)
        ? this.getGlobalVeLibrary(cmd)
        : null;

      if (globalLib || cmd.libraryContent !== undefined) {
        const parts: string[] = [];
        if (globalLib) parts.push(globalLib);
        if (cmd.libraryContent !== undefined) parts.push(cmd.libraryContent);
        const libBlock = parts.join("\n\n");
        return `${libBlock}\n\n# --- Command starts here ---\n${cmd.command}`;
      }

      return cmd.command;
    }
    return null;
  }

  /**
   * Gets vm_id from inputs or outputs.
   * Falls back to previouse_vm_id for upgrade/reconfigure tasks
   * where vm_id is not yet assigned (e.g. image phase before clone).
   */
  getVmId(): string | number | undefined {
    if (
      typeof this.deps.inputs["vm_id"] === "string" ||
      typeof this.deps.inputs["vm_id"] === "number"
    ) {
      return this.deps.inputs["vm_id"];
    }
    if (this.deps.outputs.has("vm_id")) {
      const v = this.deps.outputs.get("vm_id");
      if (typeof v === "string" || typeof v === "number") {
        return v;
      }
    }
    // Fallback: use previouse_vm_id (old container) for pre-clone commands
    if (
      typeof this.deps.inputs["previouse_vm_id"] === "string" ||
      typeof this.deps.inputs["previouse_vm_id"] === "number"
    ) {
      return this.deps.inputs["previouse_vm_id"];
    }
    return undefined;
  }

  /**
   * Executes a command based on its execute_on target.
   */
  async executeCommandByTarget(
    cmd: ICommand,
    rawStr: string,
  ): Promise<IVeExecuteMessage | undefined> {
    if (!cmd.execute_on) {
      throw new Error(cmd.name + " is missing the execute_on property");
    }

    // Debug-dump inputs + defaults before execution (gated by ve_debug_commands).
    this.debugDumpContext(cmd, "before");

    // Normalize execute_on: extract target string and optional uid/gid flags
    let target: string;
    let useUid = false;
    let useGid = false;
    if (typeof cmd.execute_on === "object" && cmd.execute_on !== null) {
      target = (cmd.execute_on as { where: string }).where;
      useUid = !!(cmd.execute_on as { uid?: boolean }).uid;
      useGid = !!(cmd.execute_on as { gid?: boolean }).gid;
    } else {
      target = cmd.execute_on as string;
    }

    // Resolve uid/gid from application config if flags are set
    let execUid: number | undefined;
    let execGid: number | undefined;
    if (useUid || useGid) {
      const resolvedUid = this.deps.variableResolver.replaceVars("{{ uid }}");
      const resolvedGid = this.deps.variableResolver.replaceVars("{{ gid }}");
      if (useUid && resolvedUid && resolvedUid !== "NOT_DEFINED" && !resolvedUid.includes("{{")) {
        execUid = parseInt(resolvedUid, 10);
      }
      if (useGid && resolvedGid && resolvedGid !== "NOT_DEFINED" && !resolvedGid.includes("{{")) {
        execGid = parseInt(resolvedGid, 10);
      }
    }

    try {
      switch (target) {
        case "lxc": {
          const execStrLxc = this.deps.variableResolver.replaceVars(rawStr);
          const vm_id = this.getVmId();
          if (!vm_id) {
            const msg =
              "vm_id is required for LXC execution but was not found in inputs or outputs.";
            this.deps.messageEmitter.emitStandardMessage(cmd, msg, null, -1, -1);
            throw new Error(msg);
          }
          await this.deps.runOnLxc(vm_id, execStrLxc, cmd, execUid, execGid);
          return undefined;
        }
        case "ve": {
          const execStrVe = this.deps.variableResolver.replaceVars(rawStr);
          return await this.deps.runOnVeHost(execStrVe, cmd);
        }
        default: {
          if (/^host:.*/.test(target)) {
            const hostname = target.split(":")[1] ?? "";
            await this.deps.executeOnHost(hostname, rawStr, cmd);
            return undefined;
          } else if (/^application:.*/.test(target)) {
            const appId = target.slice("application:".length).trim();
            if (!this.deps.resolveApplicationToVmId) {
              throw new Error("resolveApplicationToVmId is not configured");
            }
            const vm_id = await this.deps.resolveApplicationToVmId(appId);
            const execStr = this.deps.variableResolver.replaceVars(rawStr);
            await this.deps.runOnLxc(vm_id, execStr, cmd, execUid, execGid);
            return undefined;
          } else {
            throw new Error(
              cmd.name + " has invalid execute_on: " + target,
            );
          }
        }
      }
    } finally {
      // Debug-dump outputs after execution (gated by ve_debug_commands).
      // Runs even on error so we see the state at failure point.
      this.debugDumpContext(cmd, "after");
    }
  }

  /**
   * Parses fallback outputs from echo JSON format.
   * This is a fallback if parseAndUpdateOutputs didn't produce any outputs.
   * Note: lastMsg.result contains the stdout from the command execution.
   */
  parseFallbackOutputs(lastMsg: IVeExecuteMessage | undefined): void {
    if (
      this.deps.outputs.size === 0 &&
      lastMsg &&
      typeof lastMsg.result === "string" &&
      lastMsg.result.trim().length > 0
    ) {
      // Try to parse as JSON array or object
      let cleaned = lastMsg.result.trim();

      // Remove unique marker if present (from SSH execution)
      // The marker is typically at the beginning, followed by the actual JSON output
      const markerMatch = cleaned.match(/^[A-Z0-9_]+\n(.*)$/s);
      if (markerMatch && markerMatch[1]) {
        cleaned = markerMatch[1].trim();
      }

      try {
        const parsed = JSON.parse(cleaned);

        // Handle array of {id, value} objects (like get-latest-os-template.sh output)
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];
          if (
            first &&
            typeof first === "object" &&
            "id" in first &&
            "value" in first
          ) {
            // Array of IOutput objects
            for (const entry of parsed as Array<{
              id: string;
              value: string | number | boolean;
            }>) {
              if (entry.value !== undefined) {
                this.deps.outputs.set(entry.id, entry.value);
              }
            }
            return;
          } else if (
            first &&
            typeof first === "object" &&
            "name" in first &&
            "value" in first
          ) {
            // Array of {name, value} objects
            const raw: { name: string; value: string | number | boolean }[] =
              [];
            for (const entry of parsed as Array<{
              name: string;
              value: string | number | boolean;
            }>) {
              this.deps.outputs.set(entry.name, entry.value);
              raw.push({ name: entry.name, value: entry.value });
            }
            this.deps.setOutputsRaw(raw);
            return;
          }
        }

        // Handle object format (legacy fallback)
        const raw: { name: string; value: string | number | boolean }[] = [];
        for (const [name, value] of Object.entries(parsed)) {
          const v = value as string | number | boolean;
          this.deps.outputs.set(name, v);
          raw.push({ name, value: v });
        }
        this.deps.setOutputsRaw(raw);
      } catch {
        // Ignore parse errors
      }
    }
  }
}

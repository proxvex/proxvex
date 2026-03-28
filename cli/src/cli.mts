import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type {
  IParameter,
  IParameterValue,
  IAddonWithParameters,
  IStack,
} from "@shared/types.mjs";
import { CliApiClient } from "./cli-api-client.mjs";
import { CliTemplateGenerator } from "./cli-template-generator.mjs";
import { CliProgress } from "./cli-progress.mjs";
import type { CliOptions } from "./cli-types.mjs";
import {
  CliError,
  NotFoundError,
  ValidationCliError,
} from "./cli-types.mjs";

export class RemoteCli {
  private client: CliApiClient;

  constructor(private options: CliOptions) {
    this.client = new CliApiClient(
      options.server,
      options.token,
      options.insecure,
      options.fixturePath,
      options.oidcCredentials,
    );
  }

  async run(): Promise<void> {
    // Authenticate via OIDC if credentials are provided
    await this.client.authenticateOidc();

    // 1. Read parameters file first to get application and task (unless generate-template mode)
    let paramsInput: {
      application: string;
      task: string;
      params: { name: string; value: IParameterValue }[];
      selectedAddons?: string[];
      stackId?: string;
    } | undefined;

    if (!this.options.generateTemplate) {
      if (!this.options.parametersFile) {
        throw new CliError("Parameters file is required", 1);
      }
      const fileData = this.readParametersFile(this.options.parametersFile);
      this.options.application = fileData.application;
      this.options.task = fileData.task;
      paramsInput = fileData;
    }

    const application = this.options.application!;
    const task = this.options.task!;

    // 2. Resolve VE context
    const veContext = await this.resolveVeContext();

    // 3. Fetch unresolved parameters (filter out addon_ prefixed)
    const unresolvedResp = await this.client.getUnresolvedParameters(
      veContext,
      application,
      task,
    );
    const parameterDefs = unresolvedResp.unresolvedParameters.filter(
      (p) => !p.id.startsWith("addon_"),
    );

    // 4. Resolve enum values
    const enumResp = await this.client.postEnumValues(
      veContext,
      application,
      task,
    );
    for (const entry of enumResp.enumValues) {
      const def = parameterDefs.find((p) => p.id === entry.id);
      if (def) {
        def.enumValues = entry.enumValues;
        if (entry.default !== undefined) def.default = entry.default;
      }
    }

    // 5. Fetch compatible addons
    let addons: IAddonWithParameters[] = [];
    try {
      const addonsResp = await this.client.getCompatibleAddons(
        application,
      );
      addons = addonsResp.addons;
    } catch {
      // Addons may not be available
    }

    // 6. Fetch stacks and detect stacktype
    // Effective stacktypes (app + addon) are computed server-side during validation.
    // CLI only needs stacks for auto-creation and --generate-template.
    let stacks: IStack[] = [];
    let appStacktype: string | string[] | undefined;
    try {
      const apps = await this.client.getApplications();
      const app = apps.find(
        (a) => a.name === application || a.id === application,
      );
      appStacktype = app?.stacktype;
      // Also include addon stacktypes for stack resolution
      const selectedAddonIds = paramsInput?.selectedAddons ?? [];
      for (const addonId of selectedAddonIds) {
        const addon = addons.find(a => a.id === addonId);
        if (addon?.stacktype) {
          const addonTypes = Array.isArray(addon.stacktype) ? addon.stacktype : [addon.stacktype];
          if (!appStacktype) {
            appStacktype = addonTypes;
          } else {
            const current = Array.isArray(appStacktype) ? appStacktype : [appStacktype];
            for (const st of addonTypes) {
              if (!current.includes(st)) current.push(st);
            }
            appStacktype = current;
          }
        }
      }
      if (appStacktype) {
        const stacktypes = Array.isArray(appStacktype) ? appStacktype : [appStacktype];
        for (const st of stacktypes) {
          const stacksResp = await this.client.getStacks(st);
          for (const stack of stacksResp.stacks) {
            if (!stacks.some(s => s.id === stack.id)) {
              stacks.push(stack);
            }
          }
        }
      }
    } catch {
      // Stacks may not be available
    }

    // 7a. Generate template mode
    if (this.options.generateTemplate) {
      await this.generateTemplate(parameterDefs, addons, stacks, appStacktype);
      return;
    }

    // 7b. paramsInput was already read at the top of run()
    if (!paramsInput) {
      throw new CliError("Parameters file is required", 1);
    }

    // 7c. If previous_vm_id is in params, fetch previous container config as defaults
    const previousVmId = paramsInput.params.find(p => p.name === "previous_vm_id");
    if (previousVmId) {
      try {
        const containerConfig = await this.client.getContainerConfig(
          veContext, Number(previousVmId.value),
        );
        const configKeys = ["bridge", "memory", "cores", "rootfs_storage",
                            "disk_size", "hostname", "static_ip", "static_gw"];
        for (const def of parameterDefs) {
          if (configKeys.includes(def.id) && containerConfig[def.id] != null) {
            def.default = containerConfig[def.id];
          }
        }
        if (!this.options.quiet) {
          process.stderr.write(`Using previous container ${previousVmId.value} config as defaults.\n`);
        }
      } catch {
        // Container config not available — use template defaults
      }
    }

    // 6c. Fill in defaults for missing parameters
    for (const def of parameterDefs) {
      if (def.default !== undefined && !paramsInput.params.some((p) => p.name === def.id)) {
        paramsInput.params.push({ name: def.id, value: def.default });
      }
    }

    // 7. Process file uploads (resolve relative to uploads/ next to params file)
    const paramsDir = this.options.parametersFile
      ? path.dirname(
          path.isAbsolute(this.options.parametersFile)
            ? this.options.parametersFile
            : path.join(process.cwd(), this.options.parametersFile),
        )
      : process.cwd();
    const processedParams = this.processFileUploads(paramsInput.params, paramsDir);

    // 7b. Auto-resolve stack(s) if app has stacktype
    // Support both stackId (single) and stackIds (multi-stack apps like zitadel)
    let resolvedStackId: string | undefined;
    let resolvedStackIds: string[] | undefined;
    if (paramsInput.stackIds && paramsInput.stackIds.length > 0) {
      // Multi-stack: resolve each stackId individually
      resolvedStackIds = [];
      for (const sid of paramsInput.stackIds) {
        const resolved = await this.resolveStack(sid, appStacktype, stacks);
        if (resolved) resolvedStackIds.push(resolved);
      }
    } else {
      resolvedStackId = await this.resolveStack(
        paramsInput.stackId,
        appStacktype,
        stacks,
      );
    }

    // Build stack params for API calls
    const stackParams = resolvedStackIds && resolvedStackIds.length > 0
      ? { stackIds: resolvedStackIds }
      : resolvedStackId
        ? { stackId: resolvedStackId }
        : {};

    // 7c. Merge addons from CLI flags with addons from parameters file
    const selectedAddons = [
      ...(paramsInput.selectedAddons ?? []),
      ...(this.options.enableAddons ?? []),
    ];
    const disabledAddons = this.options.disableAddons ?? [];

    // 8. Validate
    const validationResult = await this.client.postValidateParameters(
      veContext,
      application,
      task,
      {
        params: processedParams,
        ...(selectedAddons.length > 0 ? { selectedAddons } : {}),
        ...(disabledAddons.length > 0 ? { disabledAddons } : {}),
        ...stackParams,
      },
    );

    if (!validationResult.valid) {
      const lines = validationResult.errors.map(
        (e) => `  - ${e.field}: ${e.message}`,
      );
      throw new ValidationCliError(
        `Parameter validation failed:\n${lines.join("\n")}`,
      );
    }

    if (validationResult.warnings.length > 0 && !this.options.quiet) {
      for (const w of validationResult.warnings) {
        process.stderr.write(`Warning: ${w.field}: ${w.message}\n`);
      }
    }

    // 9. Submit
    const configResp = await this.client.postVeConfiguration(
      veContext,
      application,
      task,
      {
        params: processedParams,
        ...(selectedAddons.length > 0 ? { selectedAddons } : {}),
        ...(disabledAddons.length > 0 ? { disabledAddons } : {}),
        ...stackParams,
      },
    );

    if (!configResp.success) {
      throw new CliError("Failed to submit configuration", 5);
    }

    if (!this.options.quiet) {
      process.stderr.write("Execution started. Polling for progress...\n");
    }

    // 10. Poll for progress
    const progress = new CliProgress(this.client, veContext, {
      quiet: this.options.quiet ?? false,
      json: this.options.json ?? false,
      verbose: this.options.verbose ?? false,
      timeout: this.options.timeout,
    });

    const result = await progress.poll();

    // 11. Output final result
    if (this.options.quiet || this.options.json) {
      process.stdout.write(
        JSON.stringify({ success: result.success, vmId: result.vmId }) + "\n",
      );
    }
  }

  private async resolveVeContext(): Promise<string> {
    try {
      const resp = await this.client.getSshConfigKey(this.options.ve);
      return resp.key;
    } catch (err) {
      if (err instanceof NotFoundError) {
        // List available hosts
        const configs = await this.client.getSshConfigs();
        const hosts = configs.sshs.map((s) => s.host);
        throw new NotFoundError(
          `VE host '${this.options.ve}' not found. Available: ${hosts.join(", ") || "(none)"}`,
        );
      }
      throw err;
    }
  }

  private async generateTemplate(
    parameterDefs: IParameter[],
    addons: IAddonWithParameters[],
    stacks: IStack[],
    stacktype?: string | string[],
  ): Promise<void> {
    const generator = new CliTemplateGenerator();
    const primaryStacktype = Array.isArray(stacktype) ? stacktype[0] : stacktype;
    const template = generator.generate({
      application: this.options.application!,
      task: this.options.task!,
      parameters: parameterDefs,
      addons,
      stacks,
      ...(primaryStacktype ? { stacktype: primaryStacktype } : {}),
    });

    const json = JSON.stringify(template, null, 2) + "\n";

    if (this.options.templateOutput) {
      writeFileSync(this.options.templateOutput, json, "utf-8");
      process.stderr.write(
        `Template written to ${this.options.templateOutput}\n`,
      );
    } else {
      process.stdout.write(json);
    }
  }

  private async resolveStack(
    requestedStackId: string | undefined,
    appStacktype: string | string[] | undefined,
    existingStacks: IStack[],
  ): Promise<string | undefined> {
    if (!appStacktype) return requestedStackId;
    // Use the first stacktype for auto-creation
    const primaryStacktype = Array.isArray(appStacktype) ? appStacktype[0] : appStacktype;
    if (!primaryStacktype) return requestedStackId;

    if (requestedStackId) {
      // Check if the requested stack exists (by id)
      const found = existingStacks.find((s) => s.id === requestedStackId);
      if (found) return found.id;

      // Auto-create the requested stack (name = requestedStackId, server generates the id)
      if (!this.options.quiet) {
        process.stderr.write(
          `Stack '${requestedStackId}' not found. Creating stack '${requestedStackId}' (type: ${primaryStacktype})...\n`,
        );
      }
      const created = await this.client.postCreateStack({
        name: requestedStackId,
        stacktype: primaryStacktype,
      });
      // Return the server-generated stackId (e.g. "postgres_production")
      return created?.key?.replace(/^stack_/, "") ?? requestedStackId;
    }

    // No stackId given — use existing or create default
    if (existingStacks.length > 0) {
      const stack = existingStacks[0]!;
      if (!this.options.quiet) {
        process.stderr.write(`Using existing stack '${stack.id}'.\n`);
      }
      return stack.id;
    }

    // No stacks exist — create "default"
    const defaultName = "default";
    if (!this.options.quiet) {
      process.stderr.write(
        `No stacks found. Creating stack '${defaultName}' (type: ${primaryStacktype})...\n`,
      );
    }
    const created = await this.client.postCreateStack({
      name: defaultName,
      stacktype: primaryStacktype,
    });
    return created?.key?.replace(/^stack_/, "") ?? defaultName;
  }

  private readParametersFile(filePath: string): {
    application: string;
    task: string;
    params: { name: string; value: IParameterValue }[];
    selectedAddons?: string[];
    stackId?: string;
    stackIds?: string[];
  } {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    if (!existsSync(absPath)) {
      throw new CliError(`Parameters file not found: ${absPath}`, 1);
    }

    const content = readFileSync(absPath, "utf-8");
    const parsed = JSON.parse(content);

    if (!parsed.application || typeof parsed.application !== "string") {
      throw new CliError(
        "Parameters file must contain an 'application' field",
        1,
      );
    }
    if (!parsed.task || typeof parsed.task !== "string") {
      throw new CliError(
        "Parameters file must contain a 'task' field",
        1,
      );
    }

    if (!parsed.params || !Array.isArray(parsed.params)) {
      throw new CliError(
        "Parameters file must contain a 'params' array",
        1,
      );
    }

    // Strip $-prefixed metadata fields from params
    // Support both "name" and "id" keys (generate-template outputs "id")
    const params = parsed.params.map(
      (p: Record<string, unknown>) => ({
        name: (p.name ?? p.id) as string,
        value: p.value as IParameterValue,
      }),
    );

    return {
      application: parsed.application,
      task: parsed.task,
      params,
      selectedAddons: parsed.selectedAddons,
      stackId: parsed.stackId,
      stackIds: parsed.stackIds,
    };
  }

  private processFileUploads(
    params: { name: string; value: IParameterValue }[],
    paramsDir: string,
  ): { name: string; value: IParameterValue }[] {
    return params.map((p) => {
      if (typeof p.value === "string" && p.value.startsWith("file:")) {
        const filePath = p.value.slice(5);
        const uploadsDir = path.join(paramsDir, "uploads");
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : existsSync(path.join(uploadsDir, filePath))
            ? path.join(uploadsDir, filePath)
            : path.join(paramsDir, filePath);

        if (!existsSync(absPath)) {
          throw new CliError(
            `File not found for parameter '${p.name}': ${absPath}`,
            1,
          );
        }

        const content = readFileSync(absPath);
        const base64 = content.toString("base64");
        const filename = path.basename(absPath);

        return {
          name: p.name,
          value: `file:${filename}:content:${base64}`,
        };
      }
      return p;
    });
  }
}

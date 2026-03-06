import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type {
  IParameter,
  IParameterValue,
  IAddonWithParameters,
  IStack,
} from "../types.mjs";
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
    );
  }

  async run(): Promise<void> {
    // 1. Resolve VE context
    const veContext = await this.resolveVeContext();

    // 2. Fetch unresolved parameters (filter out addon_ prefixed)
    const unresolvedResp = await this.client.getUnresolvedParameters(
      veContext,
      this.options.application,
      this.options.task,
    );
    const parameterDefs = unresolvedResp.unresolvedParameters.filter(
      (p) => !p.id.startsWith("addon_"),
    );

    // 3. Resolve enum values
    const enumResp = await this.client.postEnumValues(
      veContext,
      this.options.application,
      this.options.task,
      {},
    );
    for (const entry of enumResp.enumValues) {
      const def = parameterDefs.find((p) => p.id === entry.id);
      if (def) {
        def.enumValues = entry.enumValues;
        if (entry.default !== undefined) def.default = entry.default;
      }
    }

    // 4. Fetch compatible addons
    let addons: IAddonWithParameters[] = [];
    try {
      const addonsResp = await this.client.getCompatibleAddons(
        this.options.application,
      );
      addons = addonsResp.addons;
    } catch {
      // Addons may not be available
    }

    // 5. Fetch stacks and detect stacktype
    let stacks: IStack[] = [];
    let appStacktype: string | undefined;
    try {
      const apps = await this.client.getApplications();
      const app = apps.find(
        (a) => a.name === this.options.application || a.id === this.options.application,
      );
      appStacktype = app?.stacktype;
      if (appStacktype) {
        const stacksResp = await this.client.getStacks(appStacktype);
        stacks = stacksResp.stacks;
      }
    } catch {
      // Stacks may not be available
    }

    // 6a. Generate template mode
    if (this.options.generateTemplate) {
      await this.generateTemplate(parameterDefs, addons, stacks, appStacktype);
      return;
    }

    // 6b. Execute mode — read parameters file (optional, defaults to empty params)
    const paramsInput = this.options.parametersFile
      ? this.readParametersFile(this.options.parametersFile)
      : { params: [] };

    // 6c. Fill in defaults for missing parameters
    for (const def of parameterDefs) {
      if (def.default !== undefined && !paramsInput.params.some((p) => p.name === def.id)) {
        paramsInput.params.push({ name: def.id, value: def.default });
      }
    }

    // 7. Process file uploads
    const processedParams = this.processFileUploads(paramsInput.params);

    // 7b. Auto-resolve stack if app has stacktype
    const resolvedStackId = await this.resolveStack(
      paramsInput.stackId,
      appStacktype,
      stacks,
    );

    // 8. Validate
    const validationResult = await this.client.postValidateParameters(
      veContext,
      this.options.application,
      this.options.task,
      {
        params: processedParams,
        ...(paramsInput.addons ? { selectedAddons: paramsInput.addons } : {}),
        ...(resolvedStackId ? { stackId: resolvedStackId } : {}),
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
      this.options.application,
      this.options.task,
      {
        params: processedParams,
        ...(paramsInput.addons ? { selectedAddons: paramsInput.addons } : {}),
        ...(resolvedStackId ? { stackId: resolvedStackId } : {}),
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
    stacktype?: string,
  ): Promise<void> {
    const generator = new CliTemplateGenerator();
    const template = generator.generate({
      application: this.options.application,
      task: this.options.task,
      parameters: parameterDefs,
      addons,
      stacks,
      ...(stacktype ? { stacktype } : {}),
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
    appStacktype: string | undefined,
    existingStacks: IStack[],
  ): Promise<string | undefined> {
    if (!appStacktype) return requestedStackId;

    if (requestedStackId) {
      // Check if the requested stack exists
      const exists = existingStacks.some(
        (s) => s.id === requestedStackId || s.name === requestedStackId,
      );
      if (exists) return requestedStackId;

      // Auto-create the requested stack
      if (!this.options.quiet) {
        process.stderr.write(
          `Stack '${requestedStackId}' not found. Creating stack '${requestedStackId}' (type: ${appStacktype})...\n`,
        );
      }
      await this.client.postCreateStack({
        name: requestedStackId,
        stacktype: appStacktype,
      });
      return requestedStackId;
    }

    // No stackId given — use existing or create default
    if (existingStacks.length > 0) {
      const stack = existingStacks[0]!;
      const stackId = stack.id || stack.name;
      if (!this.options.quiet) {
        process.stderr.write(`Using existing stack '${stackId}'.\n`);
      }
      return stackId;
    }

    // No stacks exist — create "default"
    const defaultName = "default";
    if (!this.options.quiet) {
      process.stderr.write(
        `No stacks found. Creating stack '${defaultName}' (type: ${appStacktype})...\n`,
      );
    }
    await this.client.postCreateStack({
      name: defaultName,
      stacktype: appStacktype,
    });
    return defaultName;
  }

  private readParametersFile(filePath: string): {
    params: { name: string; value: IParameterValue }[];
    addons?: string[];
    stackId?: string;
  } {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    if (!existsSync(absPath)) {
      throw new CliError(`Parameters file not found: ${absPath}`, 1);
    }

    const content = readFileSync(absPath, "utf-8");
    const parsed = JSON.parse(content);

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
      params,
      addons: parsed.addons,
      stackId: parsed.stackId,
    };
  }

  private processFileUploads(
    params: { name: string; value: IParameterValue }[],
  ): { name: string; value: IParameterValue }[] {
    return params.map((p) => {
      if (typeof p.value === "string" && p.value.startsWith("file:")) {
        const filePath = p.value.slice(5);
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(process.cwd(), filePath);

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

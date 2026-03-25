import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnAsync } from "@src/spawn-utils.mjs";
import { VariableResolver } from "@src/variable-resolver.mjs";
import type { TemplateTestConfig } from "./template-test-config.mjs";

export interface TemplateTestResult {
  success: boolean;
  outputs: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TemplateJson {
  execute_on: string;
  commands: Array<{
    script: string;
    library?: string | string[];
    outputs?: string[];
  }>;
}

export class TemplateTestHelper {
  private sshBaseArgs: string[];
  private sshArgs: string[];

  constructor(private config: TemplateTestConfig) {
    this.sshBaseArgs = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-p",
      String(config.sshPort),
      `root@${config.host}`,
    ];
    this.sshArgs = [...this.sshBaseArgs, "sh"];
  }

  prepareScript(opts: {
    templatePath: string;
    commandIndex?: number;
    inputs?: Record<string, string | number | boolean>;
  }): { script: string; executeOn: string; interpreter: string } {
    const fullTemplatePath = join(
      this.config.repoRoot,
      "json",
      opts.templatePath,
    );
    const template: TemplateJson = JSON.parse(
      readFileSync(fullTemplatePath, "utf-8"),
    );
    const command = template.commands[opts.commandIndex ?? 0]!;

    // Build script path: replace "templates" with "scripts" in the path
    const parts = opts.templatePath.split("/");
    const templatesIdx = parts.indexOf("templates");
    if (templatesIdx === -1) {
      throw new Error(
        `Invalid template path: ${opts.templatePath} (missing "templates" segment)`,
      );
    }
    const scriptParts = [...parts];
    scriptParts[templatesIdx] = "scripts";
    scriptParts[scriptParts.length - 1] = command.script;
    const scriptPath = join(this.config.repoRoot, "json", ...scriptParts);

    let script = readFileSync(scriptPath, "utf-8");

    // Prepend library/libraries if defined
    if (command.library) {
      const libraries = Array.isArray(command.library) ? command.library : [command.library];
      for (const lib of libraries) {
        const libraryPath = join(
          this.config.repoRoot,
          "json",
          "shared",
          "scripts",
          "library",
          lib,
        );
        const library = readFileSync(libraryPath, "utf-8");
        script = library + "\n" + script;
      }
    }

    // Substitute template variables {{ key }} using production VariableResolver
    const inputs = opts.inputs ?? {};
    const resolver = new VariableResolver(
      () => new Map(),
      () => inputs,
      () => new Map(),
    );
    script = resolver.replaceVars(script);

    // Detect interpreter from shebang (sh, python3, etc.)
    // Library may be prepended before the shebang, so check the script file directly
    let interpreter = "sh";
    if (command.script.endsWith(".py")) {
      interpreter = "python3";
    }

    return { script, executeOn: template.execute_on, interpreter };
  }

  private parseOutputs(stdout: string): Record<string, string> {
    try {
      const jsonMatch = stdout.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return {};

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id: string;
        value: string | number | boolean;
      }>;
      const outputs: Record<string, string> = {};
      for (const item of parsed) {
        if (item.id && item.value !== undefined) {
          outputs[item.id] = String(item.value);
        }
      }
      return outputs;
    } catch {
      return {};
    }
  }

  /**
   * Write an OCI version cache file on the PVE host.
   * In test mode, this prevents any skopeo calls and returns deterministic versions.
   */
  async setupOciVersionCache(
    versions: Record<string, string>,
  ): Promise<void> {
    const cache = {
      _meta: { mode: "test" },
      versions,
      inspect: {},
      tags: {},
    };
    await spawnAsync("ssh", [...this.sshBaseArgs, "sh"], {
      input: `cat > /tmp/.oci-version-cache.json << 'EOFCACHE'\n${JSON.stringify(cache, null, 2)}\nEOFCACHE`,
      timeout: 10000,
    });
  }

  async executeOnVe(
    script: string,
    timeout = 120000,
    interpreter = "sh",
  ): Promise<TemplateTestResult> {
    const sshArgs = [...this.sshBaseArgs, interpreter];
    const result = await spawnAsync("ssh", sshArgs, {
      input: script,
      timeout,
    });

    return {
      success: result.exitCode === 0,
      outputs: this.parseOutputs(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  async executeInContainer(
    vmId: string,
    script: string,
    timeout = 120000,
  ): Promise<TemplateTestResult> {
    const result = await spawnAsync(
      "ssh",
      [...this.sshBaseArgs, `pct exec ${vmId} -- sh`],
      { input: script, timeout },
    );

    return {
      success: result.exitCode === 0,
      outputs: this.parseOutputs(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  async runTemplate(opts: {
    templatePath: string;
    commandIndex?: number;
    inputs?: Record<string, string | number | boolean>;
    vmId?: string;
    timeout?: number;
  }): Promise<TemplateTestResult> {
    const { script, executeOn, interpreter } = this.prepareScript(opts);

    if (executeOn === "ve") {
      return this.executeOnVe(script, opts.timeout, interpreter);
    }

    if (executeOn === "lxc") {
      if (!opts.vmId) {
        throw new Error("vmId required for lxc execution");
      }
      return this.executeInContainer(opts.vmId, script, opts.timeout);
    }

    throw new Error(`Unsupported execute_on: ${executeOn}`);
  }
}

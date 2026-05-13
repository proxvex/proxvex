import { JsonValidator } from "./jsonvalidator.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { ICommand } from "./types.mjs";
import {
  ExecutionMode,
  determineExecutionMode,
} from "./ve-execution/ve-execution-constants.mjs";

// IOutput interface moved here to avoid circular dependency
export interface IOutput {
  id: string;
  value?: string;
  default?: string;
}

/**
 * Processes script outputs, including JSON parsing, validation, and local file handling.
 */
export class OutputProcessor {
  private validator: JsonValidator;

  constructor(
    private outputs: Map<string, string | number | boolean>,
    private outputsRaw:
      | { name: string; value: string | number | boolean }[]
      | undefined,
    private defaults: Map<string, string | number | boolean>,
    private executionMode?: ExecutionMode,
  ) {
    this.validator = PersistenceManager.getInstance().getJsonValidator();
    // Default to PRODUCTION if not specified
    if (!this.executionMode) {
      this.executionMode = determineExecutionMode();
    }
  }

  /**
   * Processes a value: if it's a string starting with "local:", reads the file and returns base64 encoded content.
   * Only processes files when executing locally (ExecutionMode.TEST). When executing on VE host,
   * the "local:" prefix is preserved so the file can be read on the VE host.
   */
  processLocalFileValue(
    value: string | number | boolean,
  ): string | number | boolean {
    if (typeof value === "string" && value.startsWith("local:")) {
      // Only process local files when executing locally (e.g., in tests)
      // When executing on VE host, preserve the "local:" prefix so the file can be read on the VE host
      if (this.executionMode === ExecutionMode.TEST) {
        const filePath = value.substring(6); // Remove "local:" prefix
        const repositories = PersistenceManager.getInstance().getRepositories();
        try {
          const fileContent = repositories.getLocalResource({ path: filePath });
          if (!fileContent) {
            throw new Error("Local file not found");
          }
          return fileContent.toString("base64");
        } catch (err: any) {
          throw new Error(
            `Failed to read local resource ${filePath}: ${err.message}`,
          );
        }
      }
      // When executing on VE host, return the value as-is (with "local:" prefix)
      // The file will be read on the VE host, not locally
    }
    return value;
  }

  /**
   * Validates that all expected outputs from the command are present.
   * @param expectedOutputs Expected output IDs from the command definition
   * @param actualOutputIds Actual output IDs that were parsed
   * @param commandName Command name for error messages
   */
  private validateExpectedOutputs(
    expectedOutputs:
      | Array<{ id: string; default?: boolean; optional?: boolean } | string>
      | undefined,
    actualOutputIds: Set<string>,
    commandName: string,
  ): void {
    if (!expectedOutputs || expectedOutputs.length === 0) {
      return; // No expected outputs, nothing to validate
    }

    const expectedIds = new Set<string>();
    for (const output of expectedOutputs) {
      const id = typeof output === "string" ? output : output.id;
      // Skip optional outputs (marked with default or optional flag)
      if (typeof output === "object" && (output.default !== undefined || output.optional)) {
        continue;
      }
      expectedIds.add(id);
    }

    if (expectedIds.size === 0) {
      return; // All outputs have defaults, nothing required
    }

    // Check for missing outputs
    const missingOutputs: string[] = [];
    for (const expectedId of expectedIds) {
      if (!actualOutputIds.has(expectedId)) {
        missingOutputs.push(expectedId);
      }
    }

    if (missingOutputs.length > 0) {
      throw new Error(
        `Command "${commandName}" is missing expected outputs: ${missingOutputs.join(", ")}. ` +
          `Expected: ${Array.from(expectedIds).join(", ")}, ` +
          `Received: ${Array.from(actualOutputIds).join(", ") || "(none)"}`,
      );
    }
  }

  /**
   * Parses JSON output from stdout, validates it, and updates outputs map.
   * Handles multiple output formats: IOutput, IOutput[], or Array<{name, value}>.
   * Validates that all expected outputs from the command are present.
   */
  parseAndUpdateOutputs(
    stdout: string,
    tmplCommand: ICommand,
    uniqueMarker?: string,
  ): void {
    if (stdout.trim().length === 0) {
      return; // No outputs to parse
    }

    try {
      // Strip banner text by finding the unique marker we prepended
      // Everything before the marker is banner text (SSH MOTD, etc.)
      let cleaned = stdout.trim();
      if (uniqueMarker) {
        const markerIndex = cleaned.indexOf(uniqueMarker);
        if (markerIndex >= 0) {
          // Remove everything up to and including the marker and the newline after it
          cleaned = cleaned.slice(markerIndex + uniqueMarker.length).trim();
        }
      }

      if (cleaned.length === 0) {
        return; // Nothing left after cleaning
      }

      const parsed = JSON.parse(cleaned);
      // Validate against schema; may be one of:
      // - IOutput
      // - IOutput[]
      // - Array<{name, value}>
      const outputsJson = this.validator.serializeJsonWithSchema<any>(
        parsed,
        "outputs",
        "Outputs " + tmplCommand.name,
      );

      const actualOutputIds = new Set<string>();

      if (Array.isArray(outputsJson)) {
        // Scripts emit `[]` when their enum is legitimately empty (e.g. no USB
        // adapters plugged in on the host). Accept this as a valid enumValues
        // result instead of failing the "missing expected outputs" check.
        if (outputsJson.length === 0 && tmplCommand.outputs?.length === 1) {
          const onlyOutput = tmplCommand.outputs[0];
          const expectedId =
            typeof onlyOutput === "string" ? onlyOutput : onlyOutput?.id;
          if (expectedId === "enumValues") {
            (this as any).outputsRawResult = [];
            return;
          }
        }
        const first = outputsJson[0];
        if (
          first &&
          typeof first === "object" &&
          "name" in first &&
          !("id" in first)
        ) {
          // name/value array: pass through 1:1 to outputsRaw and also map for substitutions
          // Note: outputsRaw is managed by the caller, so we need to return this
          const raw: { name: string; value: string | number | boolean }[] = [];
          for (const nv of outputsJson as {
            name: string;
            value: string | number | boolean;
          }[]) {
            const processedValue = this.processLocalFileValue(nv.value);
            raw.push({ name: nv.name, value: processedValue });
            this.outputs.set(nv.name, processedValue);
            actualOutputIds.add(nv.name);
          }
          // Store in a way that the caller can access it
          (this as any).outputsRawResult = raw;
          // For name/value format, if expected output is "enumValues", consider it valid if we have any outputs
          if (tmplCommand.outputs && tmplCommand.outputs.length === 1) {
            const output = tmplCommand.outputs[0];
            const expectedId = typeof output === "string" ? output : output?.id;
            if (!expectedId) return;
            if (expectedId === "enumValues" && actualOutputIds.size > 0) {
              // Special case: enumValues is valid if we have any name/value pairs
              return;
            }
          }
        } else {
          // Array of outputObject {id, value}
          for (const entry of outputsJson as IOutput[]) {
            if (entry.value !== undefined) {
              const processedValue = this.processLocalFileValue(entry.value);
              this.outputs.set(entry.id, processedValue);
              actualOutputIds.add(entry.id);
            }
            if ((entry as any).default !== undefined)
              this.defaults.set(entry.id, (entry as any).default as any);
          }
        }
      } else if (typeof outputsJson === "object" && outputsJson !== null) {
        const obj = outputsJson as IOutput;
        if (obj.value !== undefined) {
          const processedValue = this.processLocalFileValue(obj.value);
          this.outputs.set(obj.id, processedValue);
          actualOutputIds.add(obj.id);
        }
        if ((obj as any).default !== undefined)
          this.defaults.set(obj.id, (obj as any).default as any);
      }

      // Validate expected outputs after parsing
      this.validateExpectedOutputs(
        tmplCommand.outputs,
        actualOutputIds,
        tmplCommand.name || "unnamed",
      );
    } catch (e) {
      // Re-throw with context
      throw e;
    }
  }

  /**
   * Gets the outputsRaw result from the last parse operation (for name/value arrays).
   */
  getOutputsRawResult():
    | { name: string; value: string | number | boolean }[]
    | undefined {
    return (this as any).outputsRawResult;
  }
}

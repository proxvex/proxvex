/**
 * Variable resolver for replacing {{ variable }} placeholders in strings.
 * Supports regular variables and list variables (e.g., {{ volumes }}).
 *
 * Variable names must start with a letter or underscore ([a-zA-Z_]).
 * This excludes Go/Docker template syntax like {{.Repository}}, {{.Tag}}.
 */

/** Captures deployer variables: {{ var_name }}, {{ list.foo.bar }} etc. */
const VAR_CAPTURE_RE = /{{\s*([a-zA-Z_][^}\s]*)\s*}}/g;
/** Tests whether a string still contains unresolved deployer variables. */
const VAR_TEST_RE = /{{\s*[a-zA-Z_][^}\s]*\s*}}/;

/**
 * Substitution record produced by `replaceVarsAnnotated`. Tells the
 * DebugCollector which variable was placed at which 1-based line of the
 * annotated output (the redacted twin). `secure` reflects whether the
 * parameter is flagged `secure: true` and got redacted in the twin.
 */
export interface IVarSubstitution {
  var: string;
  redactedValue: string;
  line: number;
  secure: boolean;
}

export interface IAnnotatedReplaceResult {
  /** Real resolved string (identical to what `replaceVars()` returns). */
  resolved: string;
  /** Redacted twin with `# vars: ...` annotations at end of each touched line. */
  redactedAnnotated: string;
  substitutions: IVarSubstitution[];
}

export class VariableResolver {
  private getSecureParamIds: () => Set<string>;

  constructor(
    private getOutputs: () => Map<string, string | number | boolean>,
    private getInputs: () => Record<string, string | number | boolean>,
    private getDefaults: () => Map<string, string | number | boolean>,
    getSecureParamIds?: () => Set<string>,
  ) {
    this.getSecureParamIds = getSecureParamIds ?? (() => new Set<string>());
  }

  private get outputs() {
    return this.getOutputs();
  }

  private get inputs() {
    return this.getInputs();
  }

  private get defaults() {
    return this.getDefaults();
  }

  /**
   * Replaces {{var}} in a string with values from inputs or outputs.
   * Performs a second pass if the first replacement introduced new {{ }} markers
   * (e.g., when {{ envs }} contains "POSTGRES_PASSWORD={{ POSTGRES_PASSWORD }}").
   */
  replaceVars(str: string): string {
    const result = this.replaceVarsWithContext(str, {});
    if (result !== str && VAR_TEST_RE.test(result)) {
      return this.replaceVarsWithContext(result, {});
    }
    return result;
  }

  /**
   * Resolves a list variable by collecting all entries that start with "list.<varName>."
   * from context, outputs, inputs, and defaults, then formats them as a newline-separated
   * list of "parameter-id=value" lines.
   *
   * Example:
   * - list.volumes.volume1 = "/var/libs/myapp/data"
   * - list.volumes.volume2 = "/var/libs/myapp/log"
   * - resolveListVariable("volumes", ctx) returns:
   *   volume1=/var/libs/myapp/data
   *   volume2=/var/libs/myapp/log
   *
   * @param varName The variable name (e.g., "volumes" for {{ volumes }})
   * @param ctx The context map to check first
   * @returns The formatted list string, or null if no list entries found
   */
  resolveListVariable(
    varName: string,
    ctx: Record<string, any>,
  ): string | null {
    const listPrefix = `list.${varName}.`;

    // Collect all matching entries from context, outputs, inputs, and defaults
    const listEntries: Array<{ key: string; value: string }> = [];

    // Check context first
    if (ctx) {
      for (const [key, value] of Object.entries(ctx)) {
        if (
          key.startsWith(listPrefix) &&
          value !== undefined &&
          value !== null
        ) {
          const paramId = key.substring(listPrefix.length);
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // Check outputs
    for (const [key, value] of this.outputs.entries()) {
      if (key.startsWith(listPrefix) && value !== undefined && value !== null) {
        const paramId = key.substring(listPrefix.length);
        // Avoid duplicates (context takes precedence)
        if (!listEntries.some((e) => e.key === paramId)) {
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // Check inputs
    for (const [key, value] of Object.entries(this.inputs)) {
      if (key.startsWith(listPrefix) && value !== undefined && value !== null) {
        const paramId = key.substring(listPrefix.length);
        // Avoid duplicates (context and outputs take precedence)
        if (!listEntries.some((e) => e.key === paramId)) {
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // Check defaults
    for (const [key, value] of this.defaults.entries()) {
      if (key.startsWith(listPrefix) && value !== undefined && value !== null) {
        const paramId = key.substring(listPrefix.length);
        // Avoid duplicates (context, outputs, and inputs take precedence)
        if (!listEntries.some((e) => e.key === paramId)) {
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // If we found list entries, format them as "key=value" lines
    if (listEntries.length > 0) {
      // Sort by key for consistent output
      listEntries.sort((a, b) => a.key.localeCompare(b.key));
      return listEntries.map((e) => `${e.key}=${e.value}`).join("\n");
    }

    return null;
  }

  /**
   * Replace variables using a provided context map first (e.g., vmctx.data),
   * then fall back to outputs, inputs, and defaults.
   *
   * Special handling for list variables: Variables like {{ volumes }} will collect
   * all outputs/inputs/defaults that start with "list.volumes." and format them
   * as a newline-separated list of "parameter-id=value" lines.
   *
   * Example:
   * - list.volumes.volume1 = "/var/libs/myapp/data"
   * - list.volumes.volume2 = "/var/libs/myapp/log"
   * - {{ volumes }} becomes:
   *   volume1=/var/libs/myapp/data
   *   volume2=/var/libs/myapp/log
   */
  /**
   * Resolves {{ }} template markers embedded inside base64-encoded string values
   * in inputs and outputs. Handles upload parameters like compose_file
   * whose base64-decoded content may contain {{ variable }} placeholders.
   *
   * Must process both inputs (Record) and outputs (Map) because properties
   * commands copy base64 values to outputs early, before markers can be resolved.
   * The script template resolution checks outputs first, so unresolved base64
   * in outputs would shadow resolved values in inputs.
   *
   * Modifies both collections in-place. Safe to call multiple times (idempotent).
   */
  resolveBase64Inputs(
    inputs: Record<string, string | number | boolean>,
    outputs?: Map<string, string | number | boolean>,
  ): void {
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== "string" || value.length < 20) continue;
      try {
        const decoded = Buffer.from(value, "base64").toString("utf-8");
        if (!VAR_TEST_RE.test(decoded)) continue;
        const resolved = this.replaceVarsPreserveUnresolved(decoded);
        if (resolved !== decoded) {
          inputs[key] = Buffer.from(resolved).toString("base64");
        }
      } catch {
        // Not valid base64, skip
      }
    }
    if (outputs) {
      for (const [key, value] of outputs.entries()) {
        if (typeof value !== "string" || value.length < 20) continue;
        try {
          const decoded = Buffer.from(value, "base64").toString("utf-8");
          if (!VAR_TEST_RE.test(decoded)) continue;
          const resolved = this.replaceVarsPreserveUnresolved(decoded);
          if (resolved !== decoded) {
            outputs.set(key, Buffer.from(resolved).toString("base64"));
          }
        } catch {
          // Not valid base64, skip
        }
      }
    }
  }

  /**
   * Like replaceVars but preserves unresolved variables as {{ var }} instead of
   * replacing with NOT_DEFINED. Used by resolveBase64Inputs so that variables
   * from later script outputs (e.g., POSTGRES_HOST from script 185) remain as
   * placeholders until the producing script has run.
   */
  private replaceVarsPreserveUnresolved(str: string): string {
    const result = str.replace(VAR_CAPTURE_RE, (match: string, v: string) => {
      const listResult = this.resolveListVariable(v, {});
      if (listResult !== null) return listResult;
      if (this.outputs.has(v)) return String(this.outputs.get(v));
      if (this.inputs[v] !== undefined) return String(this.inputs[v]);
      if (this.defaults.has(v)) return String(this.defaults.get(v));
      return match; // Preserve {{ var }} for later resolution
    });
    if (result !== str && VAR_TEST_RE.test(result)) {
      return this.replaceVarsPreserveUnresolved(result);
    }
    return result;
  }

  replaceVarsWithContext(str: string, ctx: Record<string, any>): string {
    return str.replace(VAR_CAPTURE_RE, (_: string, v: string) => {
      // Try to resolve as list variable first
      const listResult = this.resolveListVariable(v, ctx);
      if (listResult !== null) {
        return listResult;
      }

      // Fall back to regular variable resolution
      if (ctx && Object.prototype.hasOwnProperty.call(ctx, v)) {
        const val = ctx[v];
        if (val !== undefined && val !== null) return String(val);
      }
      if (this.outputs.has(v)) return String(this.outputs.get(v));
      if (this.inputs[v] !== undefined) return String(this.inputs[v]);
      if (this.defaults.has(v)) return String(this.defaults.get(v));
      // Return "NOT_DEFINED" for undefined variables instead of throwing error
      // Scripts must check for this value and generate appropriate error messages
      return "NOT_DEFINED";
    });
  }

  /**
   * Produce both the real resolved string and a redacted twin with
   * `# vars: …` annotations at the end of every line that had at least one
   * `{{ var }}` substitution. The annotations are only ever applied to the
   * twin — the executed script returned by `replaceVars()` stays untouched
   * to avoid breaking heredocs, backslash continuations, or string literals.
   *
   * Secure parameters (flagged `secure: true`) appear as `*** redacted ***`
   * in the twin and as `<name>=***` inside the comment.
   *
   * List variables (e.g. `{{ volumes }}`) expand to multi-line content; the
   * annotation is attached to the line where the marker originally sat and
   * the expanded body is left un-annotated.
   *
   * Performs a second annotation pass when expansion introduces new markers
   * (matches `replaceVars`'s two-pass behavior for cases like
   * `{{ envs }}` → `FOO={{ FOO }}`).
   */
  replaceVarsAnnotated(str: string): IAnnotatedReplaceResult {
    const secureSet = this.getSecureParamIds();
    const resolved = this.replaceVars(str);

    const firstPass = this.annotateOnePass(str, secureSet, 0);
    let { redactedAnnotated, substitutions } = firstPass;

    if (VAR_TEST_RE.test(redactedAnnotated)) {
      const secondPass = this.annotateOnePass(
        redactedAnnotated,
        secureSet,
        substitutions.length,
      );
      redactedAnnotated = secondPass.redactedAnnotated;
      substitutions = substitutions.concat(secondPass.substitutions);
    }

    return { resolved, redactedAnnotated, substitutions };
  }

  private annotateOnePass(
    str: string,
    secureSet: Set<string>,
    _substOffset: number,
  ): { redactedAnnotated: string; substitutions: IVarSubstitution[] } {
    const lines = str.split("\n");
    const outLines: string[] = [];
    const substitutions: IVarSubstitution[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineVars: Array<{ name: string; secure: boolean }> = [];

      const redactedLine = line.replace(
        VAR_CAPTURE_RE,
        (_match: string, v: string) => {
          const isSecure = secureSet.has(v);
          const listResult = this.resolveListVariable(v, {});
          let redactedValue: string;
          if (listResult !== null) {
            redactedValue = isSecure ? "*** redacted ***" : listResult;
          } else if (isSecure) {
            redactedValue = "*** redacted ***";
          } else if (this.outputs.has(v)) {
            redactedValue = String(this.outputs.get(v));
          } else if (this.inputs[v] !== undefined) {
            redactedValue = String(this.inputs[v]);
          } else if (this.defaults.has(v)) {
            redactedValue = String(this.defaults.get(v));
          } else {
            redactedValue = "NOT_DEFINED";
          }
          lineVars.push({ name: v, secure: isSecure });
          substitutions.push({
            var: v,
            redactedValue,
            line: outLines.length + 1,
            secure: isSecure,
          });
          return redactedValue;
        },
      );

      if (lineVars.length === 0) {
        outLines.push(redactedLine);
        continue;
      }

      const annotation = lineVars
        .map((v) => (v.secure ? `${v.name}=***` : v.name))
        .join(", ");

      // Multi-line redacted value (list variable): keep the annotation on the
      // first expanded line; the rest of the expansion stays un-annotated.
      const expanded = redactedLine.split("\n");
      if (expanded.length === 1) {
        outLines.push(`${redactedLine}  # vars: ${annotation}`);
      } else {
        outLines.push(`${expanded[0]}  # vars: ${annotation}`);
        for (let j = 1; j < expanded.length; j++) outLines.push(expanded[j]!);
      }
    }

    return { redactedAnnotated: outLines.join("\n"), substitutions };
  }
}

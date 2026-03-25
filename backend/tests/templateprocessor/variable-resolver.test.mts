import { describe, it, expect } from "vitest";
import { VariableResolver } from "@src/variable-resolver.mjs";

describe("VariableResolver", () => {
  it("should resolve variables from outputs, inputs, and defaults in all combinations", () => {
    type Combo = {
      output?: string | number | boolean;
      input?: string | number | boolean;
      def?: string | number | boolean;
      expected?: string | number | boolean;
    };
    // Priority: output > input > default > NOT_DEFINED
    const combos: Combo[] = [
      // Only output
      { output: "Only output", expected: "Only output" },
      // Only input
      { input: "Only input", expected: "Only input" },
      // Only default
      { def: "Only default", expected: "Only default" },
      // Output and input
      { output: "Output and input", input: "in", expected: "Output and input" },
      // Output and default
      {
        output: "Output and default",
        def: "def",
        expected: "Output and default",
      },
      // Input and default
      { input: "Input and default", def: "def", expected: "Input and default" },
      // Output, input, and default
      {
        output: "Output, input, and default",
        input: "in",
        def: "def",
        expected: "Output, input, and default",
      },
      // None (should return NOT_DEFINED)
      { expected: "NOT_DEFINED" },
    ];

    for (const combo of combos) {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();

      if (combo.output !== undefined) outputs.set("foo", combo.output);
      if (combo.input !== undefined) inputs["foo"] = combo.input;
      if (combo.def !== undefined) defaults.set("foo", combo.def);

      const resolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );

      const result = resolver.replaceVars("Value: {{ foo }}");
      expect(result).toBe("Value: " + combo.expected);
    }
  });

  it("should resolve variables with context", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    outputs.set("outputVar", "outputValue");
    inputs["inputVar"] = "inputValue";
    defaults.set("defaultVar", "defaultValue");

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    // Context should take precedence
    const ctx = { outputVar: "contextValue", newVar: "newValue" };
    const result = resolver.replaceVarsWithContext(
      "{{ outputVar }} and {{ newVar }}",
      ctx,
    );
    expect(result).toBe("contextValue and newValue");

    // Without context, should use outputs/inputs/defaults
    const result2 = resolver.replaceVarsWithContext(
      "{{ outputVar }} and {{ inputVar }}",
      {},
    );
    expect(result2).toBe("outputValue and inputValue");
  });

  it("should resolve list variables", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    outputs.set("list.volumes.volume1", "/var/libs/myapp/data");
    outputs.set("list.volumes.volume2", "/var/libs/myapp/log");
    outputs.set("list.envs.ENV1", "value1");
    outputs.set("list.envs.ENV2", "value2");

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    const result = resolver.replaceVars("{{ volumes }}");
    expect(result).toContain("volume1=/var/libs/myapp/data");
    expect(result).toContain("volume2=/var/libs/myapp/log");
    expect(result.split("\n").length).toBe(2);

    const result2 = resolver.replaceVars("{{ envs }}");
    expect(result2).toContain("ENV1=value1");
    expect(result2).toContain("ENV2=value2");
    expect(result2.split("\n").length).toBe(2);
  });

  it("should resolve nested {{ }} markers in a second pass", () => {
    const outputs = new Map<string, string | number | boolean>();
    const defaults = new Map<string, string | number | boolean>();
    defaults.set("POSTGRES_PASSWORD", "stack-secret-pw");
    defaults.set("JWT_SECRET", "stack-jwt-64chars");

    const inputs: Record<string, string | number | boolean> = {
      envs: "POSTGRES_DB=postgres\nPOSTGRES_PASSWORD={{ POSTGRES_PASSWORD }}\nJWT={{ JWT_SECRET }}",
    };

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    // Simulates script template: ENVS="{{ envs }}"
    const script = 'ENVS="{{ envs }}"';
    const result = resolver.replaceVars(script);

    expect(result).toContain("POSTGRES_PASSWORD=stack-secret-pw");
    expect(result).toContain("JWT=stack-jwt-64chars");
    expect(result).toContain("POSTGRES_DB=postgres");
    expect(result).not.toContain("{{ POSTGRES_PASSWORD }}");
    expect(result).not.toContain("{{ JWT_SECRET }}");
  });

  describe("resolveBase64Inputs", () => {
    it("should resolve {{ }} markers inside base64-encoded input values", () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {
        POSTGRES_PASSWORD: "secret123",
        POSTGRES_HOST: "10.0.0.50",
      };
      const defaults = new Map<string, string | number | boolean>();
      const resolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );

      const yamlContent =
        'PGRST_DB_URI: "postgres://postgres:{{ POSTGRES_PASSWORD }}@{{ POSTGRES_HOST }}:5432/postgres"';
      const base64Content = Buffer.from(yamlContent).toString("base64");

      const testInputs: Record<string, string | number | boolean> = {
        ...inputs,
        compose_file: base64Content,
      };

      resolver.resolveBase64Inputs(testInputs);

      const resolved = Buffer.from(
        testInputs.compose_file as string,
        "base64",
      ).toString("utf-8");
      expect(resolved).toBe(
        'PGRST_DB_URI: "postgres://postgres:secret123@10.0.0.50:5432/postgres"',
      );
    });

    it("should preserve Docker ${} env vars while resolving {{ }} markers", () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {
        POSTGRES_PASSWORD: "secret",
        POSTGRES_HOST: "db.local",
      };
      const defaults = new Map<string, string | number | boolean>();
      const resolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );

      const yamlContent =
        'PGRST_DB_URI: "postgres://{{ POSTGRES_PASSWORD }}@{{ POSTGRES_HOST }}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-postgres}"';
      const base64Content = Buffer.from(yamlContent).toString("base64");

      const testInputs: Record<string, string | number | boolean> = {
        ...inputs,
        compose_file: base64Content,
      };

      resolver.resolveBase64Inputs(testInputs);

      const resolved = Buffer.from(
        testInputs.compose_file as string,
        "base64",
      ).toString("utf-8");
      expect(resolved).toContain("secret@db.local");
      expect(resolved).toContain("${POSTGRES_PORT:-5432}");
      expect(resolved).toContain("${POSTGRES_DB:-postgres}");
    });

    it("should not modify base64 content without {{ }} markers", () => {
      const resolver = new VariableResolver(
        () => new Map(),
        () => ({}),
        () => new Map(),
      );

      const yamlContent = "image: postgrest/postgrest:latest";
      const base64Content = Buffer.from(yamlContent).toString("base64");

      const testInputs: Record<string, string | number | boolean> = {
        compose_file: base64Content,
      };

      resolver.resolveBase64Inputs(testInputs);
      expect(testInputs.compose_file).toBe(base64Content);
    });

    it("should skip non-string and short values", () => {
      const resolver = new VariableResolver(
        () => new Map(),
        () => ({}),
        () => new Map(),
      );

      const testInputs: Record<string, string | number | boolean> = {
        vm_id: 101,
        short: "abc",
        flag: true,
      };

      resolver.resolveBase64Inputs(testInputs);

      expect(testInputs.vm_id).toBe(101);
      expect(testInputs.short).toBe("abc");
      expect(testInputs.flag).toBe(true);
    });

    it("should resolve {{ }} markers inside base64 values in outputs map", () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {
        POSTGRES_PASSWORD: "stack-generated-pw",
        JWT_SECRET: "stack-generated-jwt-secret-min-32-chars!",
      };
      const resolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => new Map(),
      );

      // Simulate properties command storing unresolved base64 in outputs
      const yamlContent =
        'PGRST_DB_URI: "postgres://postgres:{{ POSTGRES_PASSWORD }}@${POSTGRES_HOST:-postgres}:5432/postgres"\nPGRST_JWT_SECRET: "{{ JWT_SECRET }}"';
      const base64Content = Buffer.from(yamlContent).toString("base64");
      outputs.set("compose_file", base64Content);
      outputs.set("hostname", "postgrest");

      const testInputs: Record<string, string | number | boolean> = {
        ...inputs,
      };

      resolver.resolveBase64Inputs(testInputs, outputs);

      const resolved = Buffer.from(
        outputs.get("compose_file") as string,
        "base64",
      ).toString("utf-8");
      expect(resolved).toContain("stack-generated-pw");
      expect(resolved).toContain("stack-generated-jwt-secret-min-32-chars!");
      expect(resolved).toContain("${POSTGRES_HOST:-postgres}");
      expect(outputs.get("hostname")).toBe("postgrest"); // non-base64 unchanged
    });

    it("should be idempotent", () => {
      const inputs: Record<string, string | number | boolean> = {
        JWT_SECRET: "my-jwt-secret-that-is-long-enough",
      };
      const resolver = new VariableResolver(
        () => new Map(),
        () => inputs,
        () => new Map(),
      );

      const yamlContent = 'PGRST_JWT_SECRET: "{{ JWT_SECRET }}"';
      const base64Content = Buffer.from(yamlContent).toString("base64");

      const testInputs: Record<string, string | number | boolean> = {
        ...inputs,
        compose_file: base64Content,
      };

      resolver.resolveBase64Inputs(testInputs);
      const afterFirst = testInputs.compose_file;

      resolver.resolveBase64Inputs(testInputs);
      expect(testInputs.compose_file).toBe(afterFirst);
    });
  });

  it("should not treat Go/Docker template syntax like {{.Repository}} as deployer variables", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    // Docker CLI uses Go templates: {{.Repository}}, {{.Tag}}, etc.
    // These must NOT be treated as deployer {{ variable }} placeholders.
    const dockerFormat = "docker images --format {{.Repository}}:{{.Tag}}";
    const result = resolver.replaceVars(dockerFormat);
    expect(result).toBe(dockerFormat);

    // Also test with spaces (should still be preserved)
    const withSpaces = "docker images --format {{ .Repository }}:{{ .Tag }}";
    const result2 = resolver.replaceVars(withSpaces);
    expect(result2).toBe(withSpaces);

    // Nested Go template syntax used in docker inspect
    const inspectFormat = '{{index .Config.Labels "org.opencontainers.image.version"}}';
    const result3 = resolver.replaceVars(inspectFormat);
    expect(result3).toBe(inspectFormat);
  });

  it("should not treat Go/Docker template syntax as deployer variables inside base64", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      vm_id: "201",
    };
    const defaults = new Map<string, string | number | boolean>();

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    // Script content with both deployer variables and Go template syntax
    const scriptContent = [
      'VM_ID="{{ vm_id }}"',
      'docker images --format {{.Repository}}:{{.Tag}}',
    ].join("\n");
    const base64Content = Buffer.from(scriptContent).toString("base64");

    const testInputs: Record<string, string | number | boolean> = {
      ...inputs,
      script_file: base64Content,
    };

    resolver.resolveBase64Inputs(testInputs);

    const resolved = Buffer.from(
      testInputs.script_file as string,
      "base64",
    ).toString("utf-8");
    expect(resolved).toContain('VM_ID="201"');
    expect(resolved).toContain("{{.Repository}}");
    expect(resolved).toContain("{{.Tag}}");
  });

  it("should return NOT_DEFINED for undefined variables", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    const result = resolver.replaceVars("Value: {{ undefinedVar }}");
    expect(result).toBe("Value: NOT_DEFINED");
  });
});

import { describe, it, expect } from "vitest";
import {
  collectWithDeps,
  selectScenarios,
  buildParams,
  type ResolvedScenario,
} from "./live-test-runner.mjs";

// ── Tests ──

describe("collectWithDeps", () => {
  function makeScenarios(
    defs: Record<string, { depends_on?: string[] }>,
  ): Map<string, ResolvedScenario> {
    const all = new Map<string, ResolvedScenario>();
    for (const [id, def] of Object.entries(defs)) {
      const [app] = id.split("/");
      all.set(id, {
        id,
        application: app!,
        description: `Test ${id}`,
        ...def,
      });
    }
    return all;
  }

  it("single scenario without deps returns just that scenario", () => {
    const all = makeScenarios({ "app/default": {} });
    const result = collectWithDeps(["app/default"], all);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("app/default");
  });

  it("scenario with deps returns deps first (topological order)", () => {
    const all = makeScenarios({
      "postgres/default": {},
      "zitadel/default": { depends_on: ["postgres/default"] },
    });

    const result = collectWithDeps(["zitadel/default"], all);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("postgres/default");
    expect(result[1]!.id).toBe("zitadel/default");
  });

  it("transitive deps: A→B→C returns [C, B, A]", () => {
    const all = makeScenarios({
      "c/default": {},
      "b/default": { depends_on: ["c/default"] },
      "a/default": { depends_on: ["b/default"] },
    });

    const result = collectWithDeps(["a/default"], all);
    expect(result.map((s) => s.id)).toEqual([
      "c/default",
      "b/default",
      "a/default",
    ]);
  });

  it("circular dependency throws error", () => {
    const all = makeScenarios({
      "a/default": { depends_on: ["b/default"] },
      "b/default": { depends_on: ["a/default"] },
    });

    expect(() => collectWithDeps(["a/default"], all)).toThrow(
      /Circular dependency/,
    );
  });

  it("unknown dependency reference throws error", () => {
    const all = makeScenarios({
      "app/default": { depends_on: ["missing/default"] },
    });

    expect(() => collectWithDeps(["app/default"], all)).toThrow(
      /Unknown test scenario: missing\/default/,
    );
  });

  it("shared deps are included only once", () => {
    const all = makeScenarios({
      "postgres/default": {},
      "app-a/default": { depends_on: ["postgres/default"] },
      "app-b/default": { depends_on: ["postgres/default"] },
    });

    const result = collectWithDeps(["app-a/default", "app-b/default"], all);
    expect(result).toHaveLength(3);
    const ids = result.map((s) => s.id);
    expect(ids.filter((id) => id === "postgres/default")).toHaveLength(1);
  });
});

describe("selectScenarios", () => {
  function makeAll(): Map<string, ResolvedScenario> {
    const entries: [string, ResolvedScenario][] = [
      "pgadmin/ssl",
      "postgres/default",
      "postgres/ssl",
      "zitadel/default",
      "zitadel/ssl",
    ].map((id) => {
      const [app] = id.split("/");
      return [id, {
        id,
        application: app!,
        description: `Test ${id}`,
      }];
    });
    return new Map(entries);
  }

  it("--all returns everything", () => {
    const all = makeAll();
    const result = selectScenarios("--all", all);
    expect(result).toHaveLength(5);
  });

  it("app/scenario returns exact match", () => {
    const all = makeAll();
    const result = selectScenarios("pgadmin/ssl", all);
    expect(result).toEqual(["pgadmin/ssl"]);
  });

  it("app name returns all scenarios under app/*", () => {
    const all = makeAll();
    const result = selectScenarios("postgres", all);
    expect(result).toEqual(["postgres/default", "postgres/ssl"]);
  });

  it("unknown app throws error", () => {
    const all = makeAll();
    expect(() => selectScenarios("nonexistent", all)).toThrow(
      /No test scenarios found for 'nonexistent'/,
    );
  });

  it("unknown exact scenario throws error", () => {
    const all = makeAll();
    expect(() => selectScenarios("pgadmin/nonexistent", all)).toThrow(
      /Unknown test scenario/,
    );
  });
});

describe("buildParams", () => {
  const defaultBase = [
    { name: "hostname", value: "test-host" },
    { name: "bridge", value: "vmbr0" },
    { name: "vm_id", value: "200" },
  ];

  const defaultVars = {
    vm_id: "200",
    hostname: "test-host",
    stack_name: "200",
  };

  it("base params always present when no scenario params", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params).toEqual(defaultBase);
  });

  it("set mode: adds new param", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [{ name: "custom_param", value: "custom_value" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params).toContainEqual({ name: "custom_param", value: "custom_value" });
  });

  it("set mode: overrides existing param", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [{ name: "hostname", value: "overridden" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "hostname")!.value).toBe("overridden");
  });

  it("append mode: builds multiline value", () => {
    const scenario: ResolvedScenario = {
      id: "pgadmin/ssl",
      application: "pgadmin",
      description: "Test pgadmin/ssl",
      params: [
        { name: "envs", append: "PGADMIN_DEFAULT_EMAIL", value: "admin@test.local" },
        { name: "envs", append: "PGADMIN_DEFAULT_PASSWORD", value: "testpass123" },
      ],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    const envs = result.params.find((p) => p.name === "envs")!;
    expect(envs.value).toBe(
      "PGADMIN_DEFAULT_EMAIL=admin@test.local\nPGADMIN_DEFAULT_PASSWORD=testpass123",
    );
  });

  it("append mode: appends to existing value", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [
        { name: "envs", append: "NEW_VAR", value: "new_value" },
      ],
    };

    const base = [
      ...defaultBase,
      { name: "envs", value: "EXISTING=old" },
    ];

    const result = buildParams(scenario, base, defaultVars);
    const envs = result.params.find((p) => p.name === "envs")!;
    expect(envs.value).toBe("EXISTING=old\nNEW_VAR=new_value");
  });

  it("selectedAddons extracted from scenario", () => {
    const scenario: ResolvedScenario = {
      id: "mosquitto/default",
      application: "mosquitto",
      description: "Test mosquitto/default",
      params: [],
      selectedAddons: ["addon-ssl"],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.selectedAddons).toEqual(["addon-ssl"]);
  });

  it("template variable substitution works", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [{ name: "custom", value: "host-{{ vm_id }}-{{ hostname }}" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "custom")!.value).toBe("host-200-test-host");
  });
});

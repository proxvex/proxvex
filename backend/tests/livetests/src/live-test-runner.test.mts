import { describe, it, expect } from "vitest";
import {
  collectWithDeps,
  selectScenarios,
  buildParams,
  planScenarios,
  partitionAfterFailure,
  type ResolvedScenario,
  type PlannedScenario,
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

  it("comma list combines entries (scenarios + apps)", () => {
    const all = makeAll();
    const result = selectScenarios("postgres/ssl, zitadel", all);
    expect(result).toEqual(["postgres/ssl", "zitadel/default", "zitadel/ssl"]);
  });

  it("comma list deduplicates", () => {
    const all = makeAll();
    const result = selectScenarios("postgres, postgres/ssl", all);
    expect(result).toEqual(["postgres/default", "postgres/ssl"]);
  });

  it("comma list trims whitespace", () => {
    const all = makeAll();
    const result = selectScenarios("  postgres/ssl  ,  zitadel/default  ", all);
    expect(result).toEqual(["postgres/ssl", "zitadel/default"]);
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
    stack_name: "default",
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
      params: [{ name: "bridge", value: "vmbr99" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "bridge")!.value).toBe("vmbr99");
  });

  it("runner-controlled params (vm_id, hostname) are not overridden by scenario", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [
        { name: "vm_id", value: "999" },
        { name: "hostname", value: "overridden" },
      ],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "vm_id")!.value).toBe("200");
    expect(result.params.find((p) => p.name === "hostname")!.value).toBe("test-host");
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

// ── planScenarios ──

describe("planScenarios", () => {
  function makeResolved(id: string, opts?: Partial<ResolvedScenario>): ResolvedScenario {
    const [app] = id.split("/");
    return { id, application: app!, description: `Test ${id}`, ...opts };
  }

  it("assigns sequential VM IDs starting at 200", () => {
    const scenarios = [makeResolved("postgres/default"), makeResolved("zitadel/default")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.vmId).toBe(200);
    expect(result[1]!.vmId).toBe(201);
  });

  it("uses explicit vm_id from scenario when set", () => {
    const scenarios = [makeResolved("myapp/default", { vm_id: 500 })];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.vmId).toBe(500);
  });

  it("generates hostname from app + variant", () => {
    const scenarios = [makeResolved("postgres/ssl")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.hostname).toBe("postgres-ssl");
  });

  it("stack name is the scenario variant", () => {
    const scenarios = [makeResolved("gitea/ssl")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.stackName).toBe("ssl");
  });

  it("detects hasStacktype from appStacktypes map", () => {
    const stacktypes = new Map<string, string | string[]>([["postgres", "postgres"]]);
    const scenarios = [makeResolved("postgres/default"), makeResolved("nginx/default")];
    const result = planScenarios(scenarios, stacktypes);
    expect(result[0]!.hasStacktype).toBe(true);
    expect(result[1]!.hasStacktype).toBe(false);
  });

  it("initializes isDependency and skipExecution to false", () => {
    const scenarios = [makeResolved("myapp/default")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.isDependency).toBe(false);
    expect(result[0]!.skipExecution).toBe(false);
  });
});

// ── Snapshot naming ──

describe("snapshot naming", () => {
  /** Reproduces the snapshot name logic from live-test-runner.mts */
  function snapshotName(scenarioId: string): string {
    return "dep-" + scenarioId.replace(/\//g, "-");
  }

  it("generates correct name for default scenario", () => {
    expect(snapshotName("postgres/default")).toBe("dep-postgres-default");
  });

  it("generates correct name for ssl scenario", () => {
    expect(snapshotName("zitadel/ssl")).toBe("dep-zitadel-ssl");
  });

  it("finds best snapshot: latest dependency in chain", () => {
    // Given deps: postgres/default → zitadel/default
    // If dep-zitadel-default exists, it's the best (includes postgres state)
    const deps = ["postgres/default", "zitadel/default"];
    const existingSnapshots = new Set(["dep-postgres-default", "dep-zitadel-default"]);

    // Walk backwards to find the latest existing snapshot
    let bestSnap: string | null = null;
    for (let i = deps.length - 1; i >= 0; i--) {
      const name = snapshotName(deps[i]!);
      if (existingSnapshots.has(name)) {
        bestSnap = name;
        break;
      }
    }
    expect(bestSnap).toBe("dep-zitadel-default");
  });

  it("falls back to earlier snapshot if latest missing", () => {
    const deps = ["postgres/default", "zitadel/default"];
    const existingSnapshots = new Set(["dep-postgres-default"]);

    let bestSnap: string | null = null;
    for (let i = deps.length - 1; i >= 0; i--) {
      const name = snapshotName(deps[i]!);
      if (existingSnapshots.has(name)) {
        bestSnap = name;
        break;
      }
    }
    expect(bestSnap).toBe("dep-postgres-default");
  });

  it("returns null if no snapshot exists", () => {
    const deps = ["postgres/default"];
    const existingSnapshots = new Set<string>();

    let bestSnap: string | null = null;
    for (let i = deps.length - 1; i >= 0; i--) {
      const name = snapshotName(deps[i]!);
      if (existingSnapshots.has(name)) {
        bestSnap = name;
        break;
      }
    }
    expect(bestSnap).toBeNull();
  });

  it("skip logic: all deps up to best snapshot are skipped", () => {
    const deps = ["postgres/default", "zitadel/default", "gitea/default"];
    const bestSnap = "dep-zitadel-default";

    const skipped: string[] = [];
    for (const dep of deps) {
      skipped.push(dep);
      if (snapshotName(dep) === bestSnap) break;
    }
    expect(skipped).toEqual(["postgres/default", "zitadel/default"]);
    // gitea/default is NOT skipped — it needs to be installed
  });
});

// ── partitionAfterFailure ──

describe("partitionAfterFailure", () => {
  function makeResolved(id: string, opts?: Partial<ResolvedScenario>): ResolvedScenario {
    const [app] = id.split("/");
    return { id, application: app!, description: `Test ${id}`, ...opts };
  }

  function makePlanned(id: string, vmId: number, opts?: Partial<ResolvedScenario>): PlannedScenario {
    return {
      vmId,
      hostname: id.replace("/", "-"),
      stackName: id.split("/")[1] ?? "default",
      scenario: makeResolved(id, opts),
      hasStacktype: false,
      isDependency: false,
      skipExecution: false,
    };
  }

  it("separates unaffected from blocked when a dependency fails", () => {
    const all = new Map<string, ResolvedScenario>([
      ["postgres/default", makeResolved("postgres/default")],
      ["zitadel/default", makeResolved("zitadel/default", { depends_on: ["postgres/default"] })],
      ["gitea/default", makeResolved("gitea/default", { depends_on: ["zitadel/default"] })],
      ["nginx/default", makeResolved("nginx/default")],
      ["postgrest/default", makeResolved("postgrest/default", { depends_on: ["postgres/default"] })],
    ]);

    const remaining = [
      makePlanned("gitea/default", 203, { depends_on: ["zitadel/default"] }),
      makePlanned("nginx/default", 204),
      makePlanned("postgrest/default", 205, { depends_on: ["postgres/default"] }),
    ];

    // zitadel failed → gitea is blocked, nginx + postgrest are unaffected
    const { unaffected, blocked } = partitionAfterFailure("zitadel/default", remaining, all);
    expect(unaffected.map((p) => p.scenario.id)).toEqual(["nginx/default", "postgrest/default"]);
    expect(blocked.map((p) => p.scenario.id)).toEqual(["gitea/default"]);
  });

  it("all tests blocked when root dependency fails", () => {
    const all = new Map<string, ResolvedScenario>([
      ["postgres/default", makeResolved("postgres/default")],
      ["zitadel/default", makeResolved("zitadel/default", { depends_on: ["postgres/default"] })],
      ["gitea/default", makeResolved("gitea/default", { depends_on: ["zitadel/default", "postgres/default"] })],
    ]);

    const remaining = [
      makePlanned("zitadel/default", 201, { depends_on: ["postgres/default"] }),
      makePlanned("gitea/default", 202, { depends_on: ["zitadel/default", "postgres/default"] }),
    ];

    const { unaffected, blocked } = partitionAfterFailure("postgres/default", remaining, all);
    expect(unaffected).toHaveLength(0);
    expect(blocked.map((p) => p.scenario.id)).toEqual(["zitadel/default", "gitea/default"]);
  });

  it("no tests blocked when independent scenario fails", () => {
    const all = new Map<string, ResolvedScenario>([
      ["nginx/default", makeResolved("nginx/default")],
      ["postgres/default", makeResolved("postgres/default")],
    ]);

    const remaining = [
      makePlanned("postgres/default", 201),
    ];

    const { unaffected, blocked } = partitionAfterFailure("nginx/default", remaining, all);
    expect(unaffected.map((p) => p.scenario.id)).toEqual(["postgres/default"]);
    expect(blocked).toHaveLength(0);
  });
});

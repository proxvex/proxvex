import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverTests,
  collectWithDeps,
  selectScenarios,
  buildParams,
  type ResolvedScenario,
} from "./live-test-runner.mjs";

// ── Helpers ──

function createFixtureDir(): string {
  return mkdtempSync(path.join(tmpdir(), "livetest-fixture-"));
}

function writeTestJson(
  fixtureRoot: string,
  appName: string,
  scenarios: Record<string, unknown>,
) {
  const dir = path.join(fixtureRoot, "json/applications", appName, "tests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "test.json"), JSON.stringify(scenarios));
}

function writeParamsJson(
  fixtureRoot: string,
  appName: string,
  scenarioName: string,
  params: { params: unknown[] },
) {
  const dir = path.join(fixtureRoot, "json/applications", appName, "tests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${scenarioName}.json`), JSON.stringify(params));
}

function writeTestFile(
  fixtureRoot: string,
  appName: string,
  filename: string,
  content: string,
) {
  const dir = path.join(fixtureRoot, "json/applications", appName, "tests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), content);
}

// ── Tests ──

describe("discoverTests", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = createFixtureDir();
    // Create the applications dir
    mkdirSync(path.join(fixtureRoot, "json/applications"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("discovers test.json from multiple app dirs", () => {
    writeTestJson(fixtureRoot, "app-a", {
      default: { description: "App A default" },
    });
    writeTestJson(fixtureRoot, "app-b", {
      default: { description: "App B default" },
      ssl: { description: "App B ssl" },
    });

    const result = discoverTests(fixtureRoot);
    expect(result.size).toBe(3);
    expect(result.has("app-a/default")).toBe(true);
    expect(result.has("app-b/default")).toBe(true);
    expect(result.has("app-b/ssl")).toBe(true);
  });

  it("scenario IDs are <app>/<scenario>", () => {
    writeTestJson(fixtureRoot, "postgres", {
      default: { description: "Postgres default" },
    });

    const result = discoverTests(fixtureRoot);
    const scenario = result.get("postgres/default")!;
    expect(scenario.id).toBe("postgres/default");
    expect(scenario.application).toBe("postgres");
    expect(scenario.description).toBe("Postgres default");
  });

  it("apps without tests/test.json are skipped", () => {
    // Create app dir without tests/
    mkdirSync(path.join(fixtureRoot, "json/applications/no-test-app"), { recursive: true });
    writeTestJson(fixtureRoot, "has-tests", {
      default: { description: "Has tests" },
    });

    const result = discoverTests(fixtureRoot);
    expect(result.size).toBe(1);
    expect(result.has("has-tests/default")).toBe(true);
  });

  it("preserves all scenario fields", () => {
    writeTestJson(fixtureRoot, "myapp", {
      ssl: {
        description: "With SSL",
        depends_on: ["other/default"],
        addons: ["addon-ssl"],
        wait_seconds: 30,
        verify: { container_running: true, tls_connect: 443 },
      },
    });

    const result = discoverTests(fixtureRoot);
    const scenario = result.get("myapp/ssl")!;
    expect(scenario.depends_on).toEqual(["other/default"]);
    expect(scenario.addons).toEqual(["addon-ssl"]);
    expect(scenario.wait_seconds).toBe(30);
    expect(scenario.verify).toEqual({ container_running: true, tls_connect: 443 });
  });
});

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
        appTestDir: `/fake/${app}/tests`,
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
        appTestDir: `/fake/${app}/tests`,
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
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = createFixtureDir();
    mkdirSync(path.join(fixtureRoot, "json/applications"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function makeScenario(appName: string, scenarioName: string): ResolvedScenario {
    return {
      id: `${appName}/${scenarioName}`,
      application: appName,
      appTestDir: path.join(fixtureRoot, "json/applications", appName, "tests"),
      description: `Test ${appName}/${scenarioName}`,
    };
  }

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

  it("base params always present when no params file exists", () => {
    const scenario = makeScenario("myapp", "default");
    // Don't create a params file
    mkdirSync(scenario.appTestDir, { recursive: true });

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result).toEqual(defaultBase);
  });

  it("set mode: adds new param", () => {
    const scenario = makeScenario("myapp", "default");
    writeParamsJson(fixtureRoot, "myapp", "default", {
      params: [{ name: "custom_param", value: "custom_value" }],
    });

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result).toContainEqual({ name: "custom_param", value: "custom_value" });
  });

  it("set mode: overrides existing param", () => {
    const scenario = makeScenario("myapp", "default");
    writeParamsJson(fixtureRoot, "myapp", "default", {
      params: [{ name: "hostname", value: "overridden" }],
    });

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.find((p) => p.name === "hostname")!.value).toBe("overridden");
  });

  it("append mode: builds multiline value", () => {
    const scenario = makeScenario("pgadmin", "ssl");
    writeParamsJson(fixtureRoot, "pgadmin", "ssl", {
      params: [
        { name: "envs", append: "PGADMIN_DEFAULT_EMAIL", value: "admin@test.local" },
        { name: "envs", append: "PGADMIN_DEFAULT_PASSWORD", value: "testpass123" },
      ],
    });

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    const envs = result.find((p) => p.name === "envs")!;
    expect(envs.value).toBe(
      "PGADMIN_DEFAULT_EMAIL=admin@test.local\nPGADMIN_DEFAULT_PASSWORD=testpass123",
    );
  });

  it("append mode: appends to existing value", () => {
    const scenario = makeScenario("myapp", "default");
    writeParamsJson(fixtureRoot, "myapp", "default", {
      params: [
        { name: "envs", append: "NEW_VAR", value: "new_value" },
      ],
    });

    const base = [
      ...defaultBase,
      { name: "envs", value: "EXISTING=old" },
    ];

    const result = buildParams(scenario, base, defaultVars);
    const envs = result.find((p) => p.name === "envs")!;
    expect(envs.value).toBe("EXISTING=old\nNEW_VAR=new_value");
  });

  it("file: prefix resolves to absolute path relative to tests dir", () => {
    const scenario = makeScenario("mosquitto", "default");
    writeParamsJson(fixtureRoot, "mosquitto", "default", {
      params: [{ name: "upload_config", value: "file:mosquitto.conf" }],
    });
    writeTestFile(fixtureRoot, "mosquitto", "mosquitto.conf", "listener 1883");

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    const upload = result.find((p) => p.name === "upload_config")!;
    expect(upload.value).toBe(
      `file:${path.join(scenario.appTestDir, "mosquitto.conf")}`,
    );
  });

  it("template variable substitution works", () => {
    const scenario = makeScenario("myapp", "default");
    writeParamsJson(fixtureRoot, "myapp", "default", {
      params: [{ name: "custom", value: "host-{{ vm_id }}-{{ hostname }}" }],
    });

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.find((p) => p.name === "custom")!.value).toBe("host-200-test-host");
  });
});

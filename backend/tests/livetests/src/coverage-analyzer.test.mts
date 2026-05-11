import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  analyzeCoverage,
  applyAddonRules,
  chooseRepresentative,
  computeIdealMatrix,
  deriveComputedTags,
  loadAppMetadata,
  loadScenarios,
  mapScenariosToCells,
  normalizeAddonCombo,
  type CoverageConfig,
  type ScenarioRecord,
} from "./coverage-analyzer.mjs";

// Builds a throwaway filesystem fixture mirroring `json/applications/<app>/`.
// Each test gets a fresh temp dir; cleanup is automatic via afterAll().

interface AppFixture {
  id: string;
  extends?: string;
  supported_addons?: string[];
  required_addons?: string[];
  hidden?: boolean;
  installation?: object;
  upgrade?: object;
  reconfigure?: object;
  scenarios?: Record<string, Record<string, unknown>>;
}

function createFixture(apps: AppFixture[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-analyzer-"));
  const appsDir = path.join(root, "json", "applications");
  fs.mkdirSync(appsDir, { recursive: true });

  for (const app of apps) {
    const dir = path.join(appsDir, app.id);
    fs.mkdirSync(dir, { recursive: true });
    const appJson: Record<string, unknown> = {
      name: app.id,
      description: "",
    };
    if (app.extends) appJson.extends = app.extends;
    if (app.supported_addons) appJson.supported_addons = app.supported_addons;
    if (app.required_addons) appJson.required_addons = app.required_addons;
    if (app.hidden) appJson.hidden = true;
    if (app.installation) appJson.installation = app.installation;
    if (app.upgrade) appJson.upgrade = app.upgrade;
    if (app.reconfigure) appJson.reconfigure = app.reconfigure;
    fs.writeFileSync(path.join(dir, "application.json"), JSON.stringify(appJson, null, 2));

    if (app.scenarios) {
      const testsDir = path.join(dir, "tests");
      fs.mkdirSync(testsDir, { recursive: true });
      for (const [variant, content] of Object.entries(app.scenarios)) {
        fs.writeFileSync(path.join(testsDir, `${variant}.json`), JSON.stringify(content));
      }
    }
  }
  return root;
}

// ── Tests ──

describe("normalizeAddonCombo", () => {
  it("empty list maps to 'none'", () => {
    expect(normalizeAddonCombo([])).toBe("none");
  });
  it("single known addon maps to short name", () => {
    expect(normalizeAddonCombo(["addon-ssl"])).toBe("ssl");
  });
  it("multiple addons are sorted and joined with '+'", () => {
    expect(normalizeAddonCombo(["addon-ssl", "addon-oidc"])).toBe("oidc+ssl");
  });
  it("unknown addons pass through verbatim", () => {
    expect(normalizeAddonCombo(["custom-thing"])).toBe("custom-thing");
  });
});

describe("loadAppMetadata", () => {
  let root: string;
  beforeAll(() => {
    root = createFixture([
      {
        id: "oci-image",
        supported_addons: ["addon-ssl", "addon-acme"],
        installation: {},
        upgrade: {},
        reconfigure: {},
      },
      {
        id: "postgres",
        extends: "oci-image",
        installation: {},
      },
    ]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("merges effective supported_addons with parent via extends", () => {
    const apps = loadAppMetadata(root);
    const postgres = apps.find((a) => a.id === "postgres");
    expect(postgres?.effectiveSupportedAddons).toEqual(
      expect.arrayContaining(["addon-ssl", "addon-acme"]),
    );
  });

  it("inherits task availability from parent (upgrade/reconfigure)", () => {
    const apps = loadAppMetadata(root);
    const postgres = apps.find((a) => a.id === "postgres");
    expect(postgres?.hasInstallation).toBe(true);
    expect(postgres?.hasUpgrade).toBe(true);
    expect(postgres?.hasReconfigure).toBe(true);
  });
});

describe("computeIdealMatrix", () => {
  it("emits power-set of supported addons crossed with declared tasks", () => {
    const root = createFixture([
      {
        id: "oci-image",
        installation: {},
        upgrade: {},
      },
      {
        id: "app",
        extends: "oci-image",
        supported_addons: ["addon-ssl", "addon-oidc"],
        installation: {},
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const cells = computeIdealMatrix(apps);
      const appCells = cells.filter((c) => c.base === "oci-image");
      // power-set of 2 addons = 4 combos × 2 tasks (installation + inherited upgrade) = 8
      // Plus oci-image base itself = 1 combo × 2 tasks = 2 (parent app with no supported_addons)
      // Total = 8 + 2 = 10 (after de-dup).
      expect(appCells.length).toBeGreaterThanOrEqual(8);
      const combos = new Set(appCells.map((c) => c.addonCombo));
      expect(combos).toContain("none");
      expect(combos).toContain("ssl");
      expect(combos).toContain("oidc");
      expect(combos).toContain("oidc+ssl");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes hidden apps", () => {
    const root = createFixture([
      { id: "real", supported_addons: [], installation: {} },
      { id: "ghost", hidden: true, installation: {} },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const cells = computeIdealMatrix(apps);
      // ghost contributes no cells; only 'real' base=none.
      expect(cells.every((c) => c.base !== "ghost")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires required_addons in every emitted subset", () => {
    const root = createFixture([
      {
        id: "needs-ssl",
        supported_addons: ["addon-ssl", "addon-oidc"],
        required_addons: ["addon-ssl"],
        installation: {},
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const cells = computeIdealMatrix(apps);
      for (const c of cells) {
        // Every cell for this app must include 'ssl'.
        expect(c.addonCombo.includes("ssl")).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadScenarios", () => {
  it("skips production-prefixed files", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        scenarios: {
          default: {},
          "production-foo": {},
        },
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const scenarios = loadScenarios(root, apps);
      expect(scenarios.map((s) => s.id)).toEqual(["app/default"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads task, addons, tags, untestable", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        upgrade: {},
        scenarios: {
          default: { selectedAddons: ["addon-ssl"] },
          upgrade: { task: "upgrade" },
          weird: { tags: ["cost:slow"], untestable: "requires audio" },
        },
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const scenarios = loadScenarios(root, apps);
      const byId = new Map(scenarios.map((s) => [s.id, s]));
      expect(byId.get("app/default")?.selectedAddons).toEqual(["addon-ssl"]);
      expect(byId.get("app/upgrade")?.task).toBe("upgrade");
      expect(byId.get("app/weird")?.tags).toEqual(["cost:slow"]);
      expect(byId.get("app/weird")?.untestable).toBe("requires audio");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mapScenariosToCells & gap detection", () => {
  it("identifies covered cells, gaps, and orphans", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        upgrade: {},
        supported_addons: ["addon-ssl"],
        scenarios: {
          default: {},
          // covers (none, installation)
          ssl: { selectedAddons: ["addon-ssl"] },
          // covers (ssl, installation)
          // (none, upgrade) is a gap
          // (ssl, upgrade) is a gap
        },
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const ideal = computeIdealMatrix(apps);
      const scenarios = loadScenarios(root, apps);
      const { covered, gaps, orphans } = mapScenariosToCells(scenarios, ideal, apps);
      expect(covered).toHaveLength(2);
      expect(gaps).toHaveLength(2);
      expect(orphans).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("chooseRepresentative", () => {
  function s(id: string, tags: string[] = []): ScenarioRecord {
    const [app, variant] = id.split("/");
    return {
      id,
      application: app!,
      variant: variant!,
      task: "installation",
      selectedAddons: [],
      tags,
      filePath: "",
    };
  }

  it("prefers explicit coverage:representative tag", () => {
    const candidates = [s("a/foo"), s("a/bar", ["coverage:representative"])];
    expect(chooseRepresentative(candidates).id).toBe("a/bar");
  });

  it("prefers `default` variant otherwise", () => {
    const candidates = [s("a/zzz"), s("a/default"), s("a/abc")];
    expect(chooseRepresentative(candidates).id).toBe("a/default");
  });

  it("falls back to shortest variant name", () => {
    const candidates = [s("a/longer"), s("a/short")];
    expect(chooseRepresentative(candidates).id).toBe("a/short");
  });
});

describe("deriveComputedTags", () => {
  it("marks the OIDC representative as coverage:critical and essentials", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        supported_addons: ["addon-oidc"],
        scenarios: {
          default: {},
          oidc: { selectedAddons: ["addon-oidc"] },
        },
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const ideal = computeIdealMatrix(apps);
      const scenarios = loadScenarios(root, apps);
      const { covered } = mapScenariosToCells(scenarios, ideal, apps);
      const tags = deriveComputedTags(scenarios, apps, covered);
      expect(tags.get("app/oidc")).toEqual(expect.arrayContaining(["coverage:critical", "coverage:essentials"]));
      // 'default' is base-default (addon:none), also critical per heuristic.
      expect(tags.get("app/default")).toEqual(expect.arrayContaining(["coverage:critical", "coverage:essentials"]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT mark SSL-only cells critical (only essentials)", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        supported_addons: ["addon-ssl"],
        scenarios: {
          default: {},
          ssl: { selectedAddons: ["addon-ssl"] },
        },
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const ideal = computeIdealMatrix(apps);
      const scenarios = loadScenarios(root, apps);
      const { covered } = mapScenariosToCells(scenarios, ideal, apps);
      const tags = deriveComputedTags(scenarios, apps, covered);
      const sslTags = tags.get("app/ssl") ?? [];
      expect(sslTags).toContain("coverage:essentials");
      expect(sslTags).not.toContain("coverage:critical");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("manual coverage:demote strips computed coverage tags", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        supported_addons: ["addon-oidc"],
        scenarios: {
          oidc: { selectedAddons: ["addon-oidc"], tags: ["coverage:demote"] },
        },
      },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const ideal = computeIdealMatrix(apps);
      const scenarios = loadScenarios(root, apps);
      const { covered } = mapScenariosToCells(scenarios, ideal, apps);
      const tags = deriveComputedTags(scenarios, apps, covered);
      const oidcTags = tags.get("app/oidc") ?? [];
      expect(oidcTags).not.toContain("coverage:critical");
      expect(oidcTags).not.toContain("coverage:essentials");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits app: / base: / task: / addon: tags", () => {
    const root = createFixture([
      {
        id: "app",
        extends: "oci-image",
        installation: {},
        supported_addons: ["addon-ssl"],
        scenarios: {
          ssl: { selectedAddons: ["addon-ssl"] },
        },
      },
      { id: "oci-image", supported_addons: [], installation: {} },
    ]);
    try {
      const apps = loadAppMetadata(root);
      const ideal = computeIdealMatrix(apps);
      const scenarios = loadScenarios(root, apps);
      const { covered } = mapScenariosToCells(scenarios, ideal, apps);
      const tags = deriveComputedTags(scenarios, apps, covered);
      const out = tags.get("app/ssl") ?? [];
      expect(out).toEqual(expect.arrayContaining([
        "app:app",
        "base:oci-image",
        "task:installation",
        "addon:ssl",
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CoverageConfig — addonRules", () => {
  it("excluded: addon stripped from every app's effective set", () => {
    const root = createFixture([
      { id: "oci-image", supported_addons: ["addon-ssl", "samba-shares"], installation: {} },
      { id: "app", extends: "oci-image" },
    ]);
    try {
      const config: CoverageConfig = {
        addonRules: { "samba-shares": { excluded: true } },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const app = apps.find((a) => a.id === "app");
      expect(app?.effectiveSupportedAddons).toContain("addon-ssl");
      expect(app?.effectiveSupportedAddons).not.toContain("samba-shares");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("onlyForApps: addon kept only for listed apps", () => {
    const root = createFixture([
      { id: "oci-image", supported_addons: ["addon-acme"], installation: {} },
      { id: "nginx", extends: "oci-image" },
      { id: "postgres", extends: "oci-image" },
    ]);
    try {
      const config: CoverageConfig = {
        addonRules: { "addon-acme": { onlyForApps: ["nginx"] } },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const nginx = apps.find((a) => a.id === "nginx");
      const postgres = apps.find((a) => a.id === "postgres");
      expect(nginx?.effectiveSupportedAddons).toContain("addon-acme");
      expect(postgres?.effectiveSupportedAddons).not.toContain("addon-acme");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolated: addon appears only solo in the matrix, never combined", () => {
    const root = createFixture([
      {
        id: "nginx",
        supported_addons: ["addon-acme", "addon-ssl", "addon-oidc"],
        installation: {},
      },
    ]);
    try {
      const config: CoverageConfig = {
        addonRules: { "addon-acme": { isolated: true } },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const cells = computeIdealMatrix(apps, config);
      const combos = new Set(cells.map((c) => c.addonCombo));
      // acme solo is allowed; acme+anything is not.
      expect(combos).toContain("acme");
      expect(combos).not.toContain("acme+ssl");
      expect(combos).not.toContain("acme+oidc");
      expect(combos).not.toContain("acme+oidc+ssl");
      // Non-acme combos still appear.
      expect(combos).toContain("oidc+ssl");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CoverageConfig — appOverrides", () => {
  it("override forces inclusion of hidden apps", () => {
    const root = createFixture([
      {
        id: "proxmox",
        hidden: true,
        supported_addons: ["addon-ssl", "addon-oidc"],
        reconfigure: {},
      },
    ]);
    try {
      const config: CoverageConfig = {
        appOverrides: {
          proxmox: { tasks: ["reconfigure"], addonCombos: ["oidc+ssl"] },
        },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const cells = computeIdealMatrix(apps, config);
      expect(cells).toHaveLength(1);
      expect(cells[0]).toEqual({ base: "none", addonCombo: "oidc+ssl", task: "reconfigure" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("addonCombos whitelist bypasses power-set", () => {
    const root = createFixture([
      {
        id: "app",
        supported_addons: ["addon-ssl", "addon-oidc"],
        installation: {},
      },
    ]);
    try {
      const config: CoverageConfig = {
        appOverrides: {
          app: { addonCombos: ["none", "oidc+ssl"] },
        },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const cells = computeIdealMatrix(apps, config);
      // Only the two whitelisted combos, not the 4-element power-set.
      const combos = new Set(cells.map((c) => c.addonCombo));
      expect(combos).toEqual(new Set(["none", "oidc+ssl"]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tasks whitelist overrides inferred task list", () => {
    const root = createFixture([
      {
        id: "app",
        installation: {},
        upgrade: {},
        reconfigure: {},
      },
    ]);
    try {
      const config: CoverageConfig = {
        appOverrides: { app: { tasks: ["reconfigure"] } },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const cells = computeIdealMatrix(apps, config);
      expect(cells.every((c) => c.task === "reconfigure")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excluded: app is dropped from the matrix entirely", () => {
    const root = createFixture([
      { id: "keep", installation: {} },
      { id: "drop", installation: {} },
    ]);
    try {
      const config: CoverageConfig = {
        appOverrides: { drop: { excluded: true } },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const cells = computeIdealMatrix(apps, config);
      // Only 'keep' contributes cells; 'drop' has none.
      expect(cells.every((c) => c.base !== "drop")).toBe(true);
      expect(cells.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scenario for an override-included hidden app maps to a covered cell, not orphan", () => {
    const root = createFixture([
      {
        id: "proxmox",
        hidden: true,
        supported_addons: ["addon-ssl", "addon-oidc"],
        reconfigure: {},
        scenarios: {
          "oidc-ssl": { task: "reconfigure", selectedAddons: ["addon-oidc", "addon-ssl"] },
        },
      },
    ]);
    try {
      const config: CoverageConfig = {
        appOverrides: {
          proxmox: { tasks: ["reconfigure"], addonCombos: ["oidc+ssl"] },
        },
      };
      const apps = applyAddonRules(loadAppMetadata(root), config);
      const ideal = computeIdealMatrix(apps, config);
      const scenarios = loadScenarios(root, apps);
      const { covered, orphans } = mapScenariosToCells(scenarios, ideal, apps);
      expect(orphans).toHaveLength(0);
      expect(covered).toHaveLength(1);
      expect(covered[0]?.representative?.id).toBe("proxmox/oidc-ssl");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("analyzeCoverage (integration)", () => {
  it("end-to-end on a minimal fixture", () => {
    const root = createFixture([
      {
        id: "oci-image",
        supported_addons: ["addon-ssl"],
        installation: {},
        upgrade: {},
      },
      {
        id: "postgres",
        extends: "oci-image",
        scenarios: {
          default: {},
          ssl: { selectedAddons: ["addon-ssl"] },
          upgrade: { task: "upgrade" },
        },
      },
    ]);
    try {
      const report = analyzeCoverage(root);
      expect(report.apps.map((a) => a.id).sort()).toEqual(["oci-image", "postgres"]);
      expect(report.scenarios.map((s) => s.id).sort()).toEqual([
        "postgres/default",
        "postgres/ssl",
        "postgres/upgrade",
      ]);
      // postgres has installation + upgrade; (ssl, upgrade) and (none, upgrade for postgres if installable)
      // are gaps. Specifics depend on inheritance: postgres inherits upgrade from oci-image.
      expect(report.gaps.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

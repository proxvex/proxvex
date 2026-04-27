import { describe, it, expect } from "vitest";
import {
  classifyFile,
  computeAffectedTests,
  parseDirective,
  buildFilter,
  type ResolverContext,
} from "./affected-tests-resolver.mjs";

/**
 * A small fixture mirroring the relevant slice of the real repo:
 * - oci-image is a base for postgres, gitea, nginx, ...
 * - addon-ssl is selected by gitea/ssl, eclipse-mosquitto/default, postgres/ssl
 * - addon-oidc is selected by gitea/default, nginx/oidc-ssl, gptwol/reconf-oidc
 * - shared template 200-start-lxc.json is used by oci-image (and thus all extenders)
 * - shared script lxc-start.sh is referenced by 200-start-lxc.json
 * - shared library pkg-common.sh is used by templates 305-post-set-pkg-mirror et al
 * - shared library cert-common.sh is used by addon-ssl templates only
 * - shared template 354-post-trust-oci-ca-in-system used by addon-oidc only
 */
const ociExtenders = [
  "oci-image",
  "postgres",
  "gitea",
  "nginx",
  "node-red",
  "eclipse-mosquitto",
  "postgrest",
  "modbus2mqtt",
  "gptwol",
  "pgadmin",
];

function makeContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  const base: ResolverContext = {
    appsUsingTemplate: () => [],
    appsUsingScript: () => [],
    appsInheritingFrom: (id) => {
      if (id === "oci-image") return ociExtenders.slice();
      return [id];
    },
    addonsUsingTemplate: () => [],
    addonsUsingScript: () => [],
    scenariosUsingAddon: (id) => {
      if (id === "addon-ssl") return ["gitea/ssl", "eclipse-mosquitto/default", "postgres/ssl"];
      if (id === "addon-oidc") return ["gitea/default", "nginx/oidc-ssl", "gptwol/reconf-oidc"];
      return [];
    },
  };
  return { ...base, ...overrides };
}

describe("parseDirective", () => {
  it("returns null for empty body", () => {
    expect(parseDirective("")).toBeNull();
    expect(parseDirective(null)).toBeNull();
    expect(parseDirective(undefined)).toBeNull();
  });

  it("matches case-insensitive Livetest:", () => {
    expect(parseDirective("Livetest: --all")).toBe("--all");
    expect(parseDirective("livetest: skip")).toBe("skip");
    expect(parseDirective("LIVETEST:zitadel/ssl")).toBe("zitadel/ssl");
  });

  it("first match wins on multi-line body", () => {
    const body = "Some context\n\nLivetest: zitadel/ssl\nLivetest: postgres/default";
    expect(parseDirective(body)).toBe("zitadel/ssl");
  });

  it("extracts comma-list value verbatim", () => {
    expect(parseDirective("Livetest: zitadel/ssl, postgres/default")).toBe(
      "zitadel/ssl, postgres/default",
    );
  });
});

describe("buildFilter", () => {
  it("empty inputs → empty filter", () => {
    expect(buildFilter([], [])).toBe("");
  });
  it("one app → /^app\\//", () => {
    expect(buildFilter(["postgres"], [])).toBe("/^postgres\\//");
  });
  it("one scenario → /^app\\/variant$/", () => {
    expect(buildFilter([], ["postgres/ssl"])).toBe("/^postgres\\/ssl$/");
  });
  it("multiple scenarios → alternation", () => {
    expect(buildFilter([], ["postgres/ssl", "zitadel/default"])).toBe(
      "/^(postgres\\/ssl|zitadel\\/default)$/",
    );
  });
  it("apps + scenarios → mixed alternation", () => {
    expect(buildFilter(["postgres"], ["zitadel/default"])).toBe(
      "/^(postgres\\/.*|zitadel\\/default)$/",
    );
  });
});

describe("classifyFile", () => {
  const ctx = makeContext();

  it("frontend file → skip", () => {
    expect(classifyFile("frontend/src/App.tsx", ctx).kind).toBe("skip");
  });
  it("docs file → skip", () => {
    expect(classifyFile("docs/intro.md", ctx).kind).toBe("skip");
  });
  it("CHANGELOG.md → skip", () => {
    expect(classifyFile("CHANGELOG.md", ctx).kind).toBe("skip");
  });
  it("test scenario file → select scenario", () => {
    const cls = classifyFile("json/applications/postgres/tests/ssl.json", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") {
      expect(cls.scenarios).toEqual(["postgres/ssl"]);
      expect(cls.apps).toEqual([]);
    }
  });
  it("production test scenario → skip", () => {
    expect(classifyFile("json/applications/postgres/tests/production.json", ctx).kind).toBe("skip");
  });
  it("non-base app template → select that app", () => {
    const cls = classifyFile("json/applications/postgres/templates/foo.json", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") expect(cls.apps).toEqual(["postgres"]);
  });
  it("oci-image template → select all extenders", () => {
    const cls = classifyFile("json/applications/oci-image/templates/foo.json", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") {
      expect(cls.apps.length).toBeGreaterThan(5);
      expect(cls.apps).toContain("postgres");
      expect(cls.apps).toContain("gitea");
    }
  });
  it("app script → only that app", () => {
    const cls = classifyFile("json/applications/postgres/scripts/init.sh", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") expect(cls.apps).toEqual(["postgres"]);
  });
  it("application.json change → app + extenders", () => {
    const cls = classifyFile("json/applications/postgres/application.json", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") expect(cls.apps).toEqual(["postgres"]);
  });
  it("backend code change → directive-required", () => {
    expect(classifyFile("backend/src/templates/foo.mts", ctx).kind).toBe("directive-required");
  });
  it("schema change → directive-required", () => {
    expect(classifyFile("schemas/test.schema.json", ctx).kind).toBe("directive-required");
  });
  it("e2e change → directive-required", () => {
    expect(classifyFile("e2e/step1-setup.sh", ctx).kind).toBe("directive-required");
  });
  it("backend doc → skip", () => {
    expect(classifyFile("backend/CHANGELOG.md", ctx).kind).toBe("skip");
  });
  it("frameworks change → directive-required", () => {
    expect(classifyFile("json/frameworks/oci-image.json", ctx).kind).toBe("directive-required");
  });
  it("addon-ssl.json → scenarios using addon-ssl", () => {
    const cls = classifyFile("json/addons/addon-ssl.json", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") {
      expect(cls.scenarios.sort()).toEqual([
        "eclipse-mosquitto/default",
        "gitea/ssl",
        "postgres/ssl",
      ]);
    }
  });
  it("addon-oidc.json → scenarios using addon-oidc", () => {
    const cls = classifyFile("json/addons/addon-oidc.json", ctx);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") expect(cls.scenarios).toContain("gitea/default");
  });
  it("addon .md → skip", () => {
    expect(classifyFile("json/addons/addon-ssl.md", ctx).kind).toBe("skip");
  });
  it("workflow non-livetest → skip", () => {
    expect(classifyFile(".github/workflows/release-please-on-push.yml", ctx).kind).toBe("skip");
  });
  it("workflow livetest-on-pr.yml → directive-required", () => {
    expect(classifyFile(".github/workflows/livetest-on-pr.yml", ctx).kind).toBe(
      "directive-required",
    );
  });
  it("shared template with no users → skip with warning", () => {
    const ctxNoUsers = makeContext({
      appsUsingTemplate: () => [],
      addonsUsingTemplate: () => [],
    });
    const cls = classifyFile("json/shared/templates/post_start/orphan.json", ctxNoUsers);
    expect(cls.kind).toBe("skip");
    if (cls.kind === "skip") expect(cls.warning).toBe(true);
  });
  it("shared template used by oci-extenders → select those apps", () => {
    const ctxApps = makeContext({
      appsUsingTemplate: (n) => (n === "200-start-lxc" ? ociExtenders.slice() : []),
    });
    const cls = classifyFile("json/shared/templates/start/200-start-lxc.json", ctxApps);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") expect(cls.apps).toContain("postgres");
  });
  it("shared script used by apps → select apps", () => {
    const ctxApps = makeContext({
      appsUsingScript: (n) => (n === "lxc-start.sh" ? ["postgres", "gitea"] : []),
    });
    const cls = classifyFile("json/shared/scripts/start/lxc-start.sh", ctxApps);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") expect(cls.apps.sort()).toEqual(["gitea", "postgres"]);
  });
  it("shared library only used by addons → select scenarios via addon", () => {
    const ctxAddon = makeContext({
      appsUsingScript: () => [],
      addonsUsingScript: (n) => (n === "cert-common.sh" ? ["addon-ssl"] : []),
    });
    const cls = classifyFile("json/shared/scripts/library/cert-common.sh", ctxAddon);
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") {
      expect(cls.scenarios).toContain("postgres/ssl");
      expect(cls.scenarios).toContain("gitea/ssl");
    }
  });
  it("shared template referenced by addon-oidc → all oidc scenarios", () => {
    const ctxAddon = makeContext({
      appsUsingTemplate: () => [],
      addonsUsingTemplate: (n) =>
        n === "354-post-trust-oci-ca-in-system" ? ["addon-oidc"] : [],
    });
    const cls = classifyFile(
      "json/shared/templates/post_start/354-post-trust-oci-ca-in-system.json",
      ctxAddon,
    );
    expect(cls.kind).toBe("select");
    if (cls.kind === "select") {
      expect(cls.scenarios).toContain("gitea/default");
      expect(cls.scenarios).toContain("nginx/oidc-ssl");
    }
  });
  it("unknown json/ path → directive-required", () => {
    expect(classifyFile("json/something/unknown.json", makeContext()).kind).toBe(
      "directive-required",
    );
  });
});

describe("computeAffectedTests", () => {
  const ctx = makeContext({
    appsUsingTemplate: (n) => (n === "200-start-lxc" ? ociExtenders.slice() : []),
    appsUsingScript: (n) => (n === "lxc-start.sh" ? ociExtenders.slice() : []),
    addonsUsingScript: (n) => (n === "cert-common.sh" ? ["addon-ssl"] : []),
  });

  it("only frontend changes → skip", () => {
    const r = computeAffectedTests({ changedFiles: ["frontend/src/App.tsx"], context: ctx });
    expect(r.skip).toBe(true);
    expect(r.filter).toBe("");
  });
  it("only scenario file → run that scenario", () => {
    const r = computeAffectedTests({
      changedFiles: ["json/applications/postgres/tests/ssl.json"],
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.scenarios).toEqual(["postgres/ssl"]);
    expect(r.filter).toBe("/^postgres\\/ssl$/");
  });
  it("multiple scenarios → alternation filter", () => {
    const r = computeAffectedTests({
      changedFiles: [
        "json/applications/postgres/tests/ssl.json",
        "json/applications/zitadel/tests/default.json",
      ],
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.filter).toBe("/^(postgres\\/ssl|zitadel\\/default)$/");
  });
  it("app subsumes its scenario", () => {
    const r = computeAffectedTests({
      changedFiles: [
        "json/applications/postgres/templates/foo.json",
        "json/applications/postgres/tests/ssl.json",
      ],
      context: ctx,
    });
    expect(r.apps).toEqual(["postgres"]);
    expect(r.scenarios).toEqual([]);
    expect(r.filter).toBe("/^postgres\\//");
  });
  it("frontend + scenario → only the scenario", () => {
    const r = computeAffectedTests({
      changedFiles: [
        "frontend/foo.tsx",
        "json/applications/postgres/templates/foo.json",
      ],
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.apps).toEqual(["postgres"]);
  });
  it("backend code without directive → skip with warning", () => {
    const r = computeAffectedTests({
      changedFiles: ["backend/src/foo.mts"],
      context: ctx,
    });
    expect(r.skip).toBe(true);
    expect(r.warnings.some((w) => /directive/i.test(w))).toBe(true);
  });
  it("backend code WITH 'Livetest: zitadel/ssl' directive → run zitadel/ssl", () => {
    const r = computeAffectedTests({
      changedFiles: ["backend/src/foo.mts"],
      prBody: "fixes the bug\n\nLivetest: zitadel/ssl",
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.directiveUsed).toBe(true);
    expect(r.filter).toBe("zitadel/ssl");
  });
  it("'Livetest: --all' directive overrides everything", () => {
    const r = computeAffectedTests({
      changedFiles: ["json/frameworks/oci-image.json"],
      prBody: "Livetest: --all",
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.filter).toBe("--all");
  });
  it("'Livetest: skip' directive forces skip even with app changes", () => {
    const r = computeAffectedTests({
      changedFiles: ["json/applications/postgres/templates/foo.json"],
      prBody: "Livetest: skip",
      context: ctx,
    });
    expect(r.skip).toBe(true);
    expect(r.directiveUsed).toBe(true);
  });
  it("comma-list directive passed verbatim", () => {
    const r = computeAffectedTests({
      changedFiles: ["backend/src/foo.mts"],
      prBody: "Livetest: zitadel/ssl, postgres/default",
      context: ctx,
    });
    expect(r.filter).toBe("zitadel/ssl, postgres/default");
  });
  it("workflow change without directive → skip with warning", () => {
    const r = computeAffectedTests({
      changedFiles: [".github/workflows/livetest-on-pr.yml"],
      context: ctx,
    });
    expect(r.skip).toBe(true);
    expect(r.warnings.some((w) => /directive/i.test(w))).toBe(true);
  });
  it("addon-ssl change → exact set of scenarios", () => {
    const r = computeAffectedTests({
      changedFiles: ["json/addons/addon-ssl.json"],
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.scenarios.sort()).toEqual([
      "eclipse-mosquitto/default",
      "gitea/ssl",
      "postgres/ssl",
    ]);
  });
  it("empty file list → skip", () => {
    expect(computeAffectedTests({ changedFiles: [], context: ctx }).skip).toBe(true);
  });
  it("oci-image template → all extenders, no run-all", () => {
    const r = computeAffectedTests({
      changedFiles: ["json/applications/oci-image/templates/foo.json"],
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.filter.startsWith("/^(")).toBe(true);
    expect(r.apps).toContain("postgres");
    expect(r.apps).toContain("gitea");
  });
  it("shared library used only by addons → scenarios from addons", () => {
    const r = computeAffectedTests({
      changedFiles: ["json/shared/scripts/library/cert-common.sh"],
      context: ctx,
    });
    expect(r.skip).toBe(false);
    expect(r.scenarios).toContain("postgres/ssl");
    expect(r.scenarios).toContain("gitea/ssl");
  });
  it("orphan shared script → skip with warning, no auto run-all", () => {
    const orphanCtx = makeContext({
      appsUsingScript: () => [],
      addonsUsingScript: () => [],
    });
    const r = computeAffectedTests({
      changedFiles: ["json/shared/scripts/library/orphan.sh"],
      context: orphanCtx,
    });
    expect(r.skip).toBe(true);
    expect(r.warnings.some((w) => /no users found/i.test(w))).toBe(true);
  });
});

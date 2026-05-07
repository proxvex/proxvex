import { describe, it, expect } from "vitest";
import {
  ApplicationDependencyResolver,
  IDependencyDataSource,
  IResolvedDependency,
} from "@src/services/application-dependency-resolver.mjs";

/**
 * Hand-rolled in-memory data source — faster + clearer than mocking the
 * production PersistenceManager. Each test sets up only what it needs.
 */
class FakeDataSource implements IDependencyDataSource {
  applications = new Map<string, { dependencies?: Array<{ application: string }>; stacktype?: string | string[] }>();
  stacktypes = new Map<string, { dependencies?: Array<{ application: string }> }>();
  addons = new Map<string, { stacktype?: string | string[]; dependencies?: Array<{ application: string }> }>();
  stacks = new Map<string, { stacktype?: string | string[] }>();

  getApplication(name: string) { return this.applications.get(name) ?? null; }
  getStacktype(name: string) { return this.stacktypes.get(name) ?? null; }
  getAddon(id: string) { return this.addons.get(id) ?? null; }
  getStack(id: string) { return this.stacks.get(id) ?? null; }
}

function newResolver(): { resolver: ApplicationDependencyResolver; src: FakeDataSource } {
  const src = new FakeDataSource();
  return { resolver: new ApplicationDependencyResolver(src), src };
}

function ids(deps: IResolvedDependency[]): string[] {
  return deps.map((d) => d.application);
}

describe("ApplicationDependencyResolver", () => {
  describe("application-level dependencies", () => {
    it("returns explicit app.dependencies", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        dependencies: [{ application: "postgres" }],
      });
      src.applications.set("postgres", {});
      const out = resolver.resolve("zitadel", [], []);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        application: "postgres",
        source: "application",
      });
    });

    it("excludes self-references in app.dependencies", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        dependencies: [{ application: "zitadel" }, { application: "postgres" }],
      });
      const out = resolver.resolve("zitadel", [], []);
      expect(ids(out)).toEqual(["postgres"]);
    });

    it("`includeAppDeps: false` skips app.dependencies (livetest path)", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        dependencies: [{ application: "postgres" }],
      });
      const out = resolver.resolve("zitadel", [], [], { includeAppDeps: false });
      expect(out).toEqual([]);
    });

    it("computes shared stacktype between consumer and dep app", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        stacktype: ["postgres", "oidc"],
        dependencies: [{ application: "postgres" }],
      });
      src.applications.set("postgres", { stacktype: "postgres" });
      const out = resolver.resolve("zitadel", [], []);
      expect(out[0]?.stacktype).toBe("postgres");
    });

    it("stacktype is null when consumer and dep share no stacktype", () => {
      const { resolver, src } = newResolver();
      src.applications.set("foo", {
        stacktype: "alpha",
        dependencies: [{ application: "bar" }],
      });
      src.applications.set("bar", { stacktype: "beta" });
      const out = resolver.resolve("foo", [], []);
      expect(out[0]?.stacktype).toBeNull();
    });
  });

  describe("stacktype-level dependencies", () => {
    it("pulls deps declared by the consumer's stacktype", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", { stacktype: "postgres" });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      const out = resolver.resolve("zitadel", [], []);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        application: "postgres",
        source: "stacktype:postgres",
        stacktype: "postgres",
      });
    });

    it("supports multi-stacktype consumer", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", { stacktype: ["postgres", "oidc"] });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      src.stacktypes.set("oidc", {
        dependencies: [{ application: "zitadel" }], // self → skip
      });
      const out = resolver.resolve("zitadel", [], []);
      expect(ids(out)).toEqual(["postgres"]);
    });
  });

  describe("addon-level dependencies", () => {
    it("pulls deps declared by selected addons", () => {
      const { resolver, src } = newResolver();
      src.applications.set("node-red", {});
      src.addons.set("addon-oidc", {
        stacktype: "oidc",
        dependencies: [{ application: "zitadel" }],
      });
      const out = resolver.resolve("node-red", ["addon-oidc"], []);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        application: "zitadel",
        source: "addon-oidc",
        stacktype: "oidc",
      });
    });

    it("ignores addons not in the selected list", () => {
      const { resolver, src } = newResolver();
      src.applications.set("node-red", {});
      src.addons.set("addon-oidc", {
        stacktype: "oidc",
        dependencies: [{ application: "zitadel" }],
      });
      const out = resolver.resolve("node-red", [], []);
      expect(out).toEqual([]);
    });

    it("dedups duplicate addon ids in the input", () => {
      const { resolver, src } = newResolver();
      src.applications.set("node-red", {});
      src.addons.set("addon-oidc", {
        stacktype: "oidc",
        dependencies: [{ application: "zitadel" }],
      });
      const out = resolver.resolve("node-red", ["addon-oidc", "addon-oidc"], []);
      expect(ids(out)).toEqual(["zitadel"]);
    });
  });

  describe("dedup across sources (first source wins)", () => {
    it("keeps the source of the first occurrence", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        stacktype: "postgres",
        dependencies: [{ application: "postgres" }],
      });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      const out = resolver.resolve("zitadel", [], []);
      expect(out).toHaveLength(1);
      expect(out[0]?.source).toBe("application");
    });

    it("merges all three sources without duplicates", () => {
      const { resolver, src } = newResolver();
      src.applications.set("gitea", {
        stacktype: "postgres",
        dependencies: [{ application: "postgres" }],
      });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      src.addons.set("addon-oidc", {
        stacktype: "oidc",
        dependencies: [{ application: "zitadel" }],
      });
      src.applications.set("postgres", {});
      src.applications.set("zitadel", {});
      const out = resolver.resolve("gitea", ["addon-oidc"], []);
      expect(ids(out).sort()).toEqual(["postgres", "zitadel"]);
    });
  });

  describe("expectedStackId from selectedStackIds", () => {
    it("matches stack id by stacktype", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        stacktype: ["postgres", "oidc"],
        dependencies: [{ application: "postgres" }],
      });
      src.applications.set("postgres", { stacktype: "postgres" });
      src.stacks.set("postgres_production", { stacktype: "postgres" });
      const out = resolver.resolve(
        "zitadel",
        [],
        ["postgres_production"],
      );
      expect(out[0]?.expectedStackId).toBe("postgres_production");
    });

    it("expectedStackId is null when no selected stack matches", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        stacktype: "postgres",
        dependencies: [{ application: "postgres" }],
      });
      src.applications.set("postgres", { stacktype: "postgres" });
      const out = resolver.resolve("zitadel", [], []);
      expect(out[0]?.expectedStackId).toBeNull();
    });

    it("first selected stack of a given stacktype wins", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", { stacktype: "postgres" });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      src.stacks.set("postgres_a", { stacktype: "postgres" });
      src.stacks.set("postgres_b", { stacktype: "postgres" });
      const out = resolver.resolve(
        "zitadel",
        [],
        ["postgres_a", "postgres_b"],
      );
      expect(out[0]?.expectedStackId).toBe("postgres_a");
    });

    it("supports stacks with multiple stacktypes", () => {
      const { resolver, src } = newResolver();
      src.applications.set("zitadel", {
        stacktype: ["postgres", "oidc"],
      });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      src.stacktypes.set("oidc", { dependencies: [] });
      src.stacks.set("multi_stack", {
        stacktype: ["postgres", "oidc"],
      });
      const out = resolver.resolve(
        "zitadel",
        [],
        ["multi_stack"],
      );
      expect(out[0]?.expectedStackId).toBe("multi_stack");
    });
  });

  describe("real-world: zitadel installation shape", () => {
    function setupZitadelWorld(src: FakeDataSource): void {
      src.applications.set("zitadel", {
        stacktype: ["postgres", "oidc", "cloudflare"],
        dependencies: [{ application: "postgres" }],
      });
      src.applications.set("postgres", { stacktype: "postgres" });
      src.stacktypes.set("postgres", {
        dependencies: [{ application: "postgres" }],
      });
      src.stacktypes.set("oidc", {
        dependencies: [{ application: "zitadel" }],
      });
      src.stacktypes.set("cloudflare", { dependencies: [] });
      src.stacks.set("postgres_production", { stacktype: "postgres" });
      src.stacks.set("oidc_production", { stacktype: "oidc" });
      src.stacks.set("cloudflare_production", { stacktype: "cloudflare" });
    }

    it("resolves to postgres only with full stack set", () => {
      const { resolver, src } = newResolver();
      setupZitadelWorld(src);
      const out = resolver.resolve(
        "zitadel",
        [],
        ["postgres_production", "oidc_production", "cloudflare_production"],
      );
      expect(ids(out)).toEqual(["postgres"]);
      expect(out[0]?.expectedStackId).toBe("postgres_production");
    });

    it("still resolves postgres when no stacks are selected (frontend bug-fix path)", () => {
      // Previously the dep-check path would behave inconsistently when
      // selectedStackIds was empty. Resolver still finds postgres via app
      // and stacktype dependencies, just with expectedStackId = null.
      const { resolver, src } = newResolver();
      setupZitadelWorld(src);
      const out = resolver.resolve("zitadel", [], []);
      expect(ids(out)).toEqual(["postgres"]);
      expect(out[0]?.expectedStackId).toBeNull();
    });
  });
});

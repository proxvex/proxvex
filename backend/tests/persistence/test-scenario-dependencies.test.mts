import { describe, it, expect } from "vitest";
import { deriveTestDependencies } from "../../src/persistence/persistence-manager.mjs";
import type { IStacktypeDependency } from "../../src/types.mjs";

describe("deriveTestDependencies", () => {
  const stacktypeDeps: Record<string, IStacktypeDependency[]> = {
    postgres: [{ application: "postgres" }],
    oidc: [{ application: "zitadel" }],
  };

  const addonDeps: Record<string, IStacktypeDependency[]> = {
    "addon-oidc": [{ application: "zitadel" }],
    "addon-ssl": [],
  };

  const getStacktypeDeps = (st: string) => stacktypeDeps[st] ?? [];
  const getAddonDeps = (addonId: string) => addonDeps[addonId] ?? [];

  it("stacktype postgres → depends on postgres/default", () => {
    const result = deriveTestDependencies(
      "gitea", "default", ["postgres"], [], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual(["postgres/default"]);
  });

  it("stacktype [oidc, postgres] → depends on zitadel + postgres", () => {
    const result = deriveTestDependencies(
      "gitea", "default", ["oidc", "postgres"], [], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual(["zitadel/default", "postgres/default"]);
  });

  it("addon-oidc → depends on zitadel", () => {
    const result = deriveTestDependencies(
      "gitea", "ssl", [], ["addon-oidc"], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual(["zitadel/ssl"]);
  });

  it("stacktype postgres + addon-oidc → combined, deduplicated", () => {
    const result = deriveTestDependencies(
      "gitea", "default", ["postgres"], ["addon-oidc"], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual(["postgres/default", "zitadel/default"]);
  });

  it("no stacktype, no addons → empty", () => {
    const result = deriveTestDependencies(
      "nginx", "default", [], [], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual([]);
  });

  it("self-reference excluded: zitadel with stacktype oidc", () => {
    const result = deriveTestDependencies(
      "zitadel", "default", ["oidc", "postgres"], [], getStacktypeDeps, getAddonDeps,
    );
    // zitadel should not depend on itself (oidc → zitadel excluded)
    expect(result).toEqual(["postgres/default"]);
  });

  it("deduplication: same dep from stacktype and addon", () => {
    const result = deriveTestDependencies(
      "gitea", "default", ["oidc"], ["addon-oidc"], getStacktypeDeps, getAddonDeps,
    );
    // zitadel appears in both stacktype oidc and addon-oidc, but only once
    expect(result).toEqual(["zitadel/default"]);
  });

  it("variant propagated to dependency scenario IDs", () => {
    const result = deriveTestDependencies(
      "gitea", "ssl", ["postgres"], [], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual(["postgres/ssl"]);
  });

  it("addon without dependencies → no effect", () => {
    const result = deriveTestDependencies(
      "nginx", "default", [], ["addon-ssl"], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual([]);
  });

  it("unknown stacktype → ignored (no crash)", () => {
    const result = deriveTestDependencies(
      "myapp", "default", ["unknown-type"], [], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual([]);
  });

  it("unknown addon → ignored (no crash)", () => {
    const result = deriveTestDependencies(
      "myapp", "default", [], ["unknown-addon"], getStacktypeDeps, getAddonDeps,
    );
    expect(result).toEqual([]);
  });
});

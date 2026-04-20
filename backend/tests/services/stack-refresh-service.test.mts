import { describe, it, expect } from "vitest";
import { buildActionsForContainer } from "@src/services/stack-refresh-service.mjs";
import type { IManagedOciContainer, IAddon } from "@src/types.mjs";
import type { IApplication } from "@src/backend-types.mjs";

const baseContainer: IManagedOciContainer = {
  vm_id: 129,
  hostname: "zitadel-test",
  oci_image: "zitadel/zitadel:latest",
  application_id: "zitadel",
  addons: [],
};

const makeApp = (stack_usage?: IApplication["stack_usage"]): IApplication => ({
  id: "zitadel",
  name: "Zitadel",
  description: "",
  stack_usage,
});

const makeAddon = (id: string, stack_usage?: IAddon["stack_usage"]): IAddon => ({
  id,
  name: id,
  notes_key: id,
  stack_usage,
});

describe("stack-refresh-service / buildActionsForContainer", () => {
  it("returns empty when nothing declares the stacktype", () => {
    const app = makeApp([
      { stacktype: "postgres", vars: [{ name: "POSTGRES_PASSWORD" }] },
    ]);
    const actions = buildActionsForContainer(
      baseContainer,
      app,
      [],
      "cloudflare",
    );
    expect(actions).toHaveLength(0);
  });

  it("includes app usage for matching stacktype", () => {
    const app = makeApp([
      {
        stacktype: "cloudflare",
        vars: [
          {
            name: "CF_TOKEN",
            replacement: "rerun-template",
            template: "385-post-configure-mail-dns.json",
          },
        ],
      },
    ]);
    const actions = buildActionsForContainer(
      baseContainer,
      app,
      [],
      "cloudflare",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      varName: "CF_TOKEN",
      replacement: "rerun-template",
      template: "385-post-configure-mail-dns.json",
      source: { kind: "application", applicationId: "zitadel" },
    });
  });

  it("merges addon usage with app usage", () => {
    const app = makeApp([
      {
        stacktype: "cloudflare",
        vars: [
          { name: "CF_TOKEN", replacement: "rerun-template", template: "t-app.json" },
        ],
      },
    ]);
    const addon = makeAddon("addon-acme", [
      {
        stacktype: "cloudflare",
        vars: [
          { name: "CF_TOKEN", replacement: "rerun-template", template: "t-addon.json" },
        ],
      },
    ]);
    const actions = buildActionsForContainer(
      baseContainer,
      app,
      [addon],
      "cloudflare",
    );
    expect(actions).toHaveLength(2);
    const sources = actions.map((a) => a.source.kind).sort();
    expect(sources).toEqual(["addon", "application"]);
  });

  it("filters by varName when provided", () => {
    const app = makeApp([
      {
        stacktype: "oidc",
        vars: [
          { name: "ZITADEL_MASTERKEY", replacement: "manual" },
          {
            name: "ZITADEL_DB_PASSWORD",
            replacement: "compose-env",
            compose_key: "ZITADEL_DATABASE_POSTGRES_USER_PASSWORD",
          },
        ],
      },
    ]);
    const actions = buildActionsForContainer(
      baseContainer,
      app,
      [],
      "oidc",
      "ZITADEL_DB_PASSWORD",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].varName).toBe("ZITADEL_DB_PASSWORD");
    expect(actions[0].replacement).toBe("compose-env");
    expect(actions[0].composeKey).toBe(
      "ZITADEL_DATABASE_POSTGRES_USER_PASSWORD",
    );
  });

  it("defaults replacement to manual when not specified", () => {
    const app = makeApp([
      {
        stacktype: "gitea",
        vars: [{ name: "GITEA_ADMIN_PASSWORD" }],
      },
    ]);
    const actions = buildActionsForContainer(baseContainer, app, [], "gitea");
    expect(actions).toHaveLength(1);
    expect(actions[0].replacement).toBe("manual");
  });

  it("handles missing application gracefully (addons still contribute)", () => {
    const addon = makeAddon("addon-acme", [
      {
        stacktype: "cloudflare",
        vars: [
          { name: "CF_TOKEN", replacement: "rerun-template", template: "t.json" },
        ],
      },
    ]);
    const actions = buildActionsForContainer(
      baseContainer,
      null,
      [addon],
      "cloudflare",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].source.kind).toBe("addon");
  });

  it("passes on-start-env script and scriptVar fields through", () => {
    const addon = makeAddon("addon-acme", [
      {
        stacktype: "cloudflare",
        vars: [
          {
            name: "CF_TOKEN",
            replacement: "on-start-env",
            script: "acme-renew.sh",
            script_var: "CF_API_TOKEN",
            description: "patch baked token",
          },
        ],
      },
    ]);
    const actions = buildActionsForContainer(
      baseContainer,
      null,
      [addon],
      "cloudflare",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].replacement).toBe("on-start-env");
    expect(actions[0].script).toBe("acme-renew.sh");
    expect(actions[0].scriptVar).toBe("CF_API_TOKEN");
    expect(actions[0].description).toBe("patch baked token");
  });

  it("no-action replacement is carried through unchanged", () => {
    const app = makeApp([
      {
        stacktype: "cloudflare",
        vars: [
          {
            name: "CF_TOKEN",
            replacement: "no-action",
            description: "informational",
          },
        ],
      },
    ]);
    const actions = buildActionsForContainer(baseContainer, app, [], "cloudflare");
    expect(actions).toHaveLength(1);
    expect(actions[0].replacement).toBe("no-action");
    expect(actions[0].description).toBe("informational");
  });
});

// Reproduction for the production bug where /config/shared/templates/create_ct/
// 050-set-project-parameters.json declares a property default for a parameter
// that is later (re-)declared with `default: ""` by a different template
// (json/shared/templates/pre_start/150-conf-setup-oidc-client.json declares
// `oidc_issuer_url` with an empty default).
//
// Empirically, scripts referencing `{{ oidc_issuer_url }}` see an empty value
// even though the project-level property default is set. This test isolates
// the resolution layer by setting up the same shape with a single application
// and two templates and asserts that loadApplication resolves the project's
// non-empty property default to the parameter's `default` field.
//
// If the test fails, we have a tight reproduction. If it passes, the bug is
// outside loadApplication (e.g. in /config layer override loading or in
// runtime variable substitution at script execution time).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { WebAppVeParameterProcessor } from "@src/webapp/webapp-ve-parameter-processor.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor: cross-template property default vs empty parameter default", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let contextManager: ReturnType<
    typeof PersistenceManager.getInstance
  >["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    const templatesDir = persistenceHelper.resolve(
      Volume.JsonApplications,
      "drift-app/templates",
    );
    fs.mkdirSync(templatesDir, { recursive: true });

    // Application with two templates, run in distinct categories — same shape
    // as the production scenario (050 in create_ct, 150 in pre_start).
    const application = {
      name: "Drift App",
      description: "Reproduction of cross-template property-default drift",
      installation: {
        create_ct: ["set-defaults.json"],
        pre_start: ["consume-default.json"],
      },
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "drift-app/application.json",
      application,
    );

    // Template A — mimics 050-set-project-parameters.json: a properties-only
    // command that sets a non-empty default.
    const setDefaults = {
      name: "Set Defaults",
      description: "Project-wide property defaults",
      commands: [
        {
          properties: [
            { id: "oidc_issuer_url", default: "https://expected.example.com" },
          ],
        },
      ],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "drift-app/templates/set-defaults.json",
      setDefaults,
    );

    // Template B — mimics 150-conf-setup-oidc-client.json: declares the same
    // parameter id with an explicit empty default.
    const consumeDefault = {
      name: "Consume Default",
      description: "Declares oidc_issuer_url with empty default",
      execute_on: "ve",
      parameters: [
        {
          id: "oidc_issuer_url",
          name: "OIDC Issuer URL",
          type: "string",
          required: false,
          default: "",
          description: "Optional issuer URL override",
        },
      ],
      commands: [
        {
          name: "Consume Default",
          script: "consume-default.sh",
        },
      ],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "drift-app/templates/consume-default.json",
      consumeDefault,
    );

    // Stub script — content does not matter for this test.
    const scriptsDir = persistenceHelper.resolve(
      Volume.JsonApplications,
      "drift-app/scripts",
    );
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      `${scriptsDir}/consume-default.sh`,
      "#!/bin/sh\necho ok\n",
    );

    const { ctx } = env.initPersistence();
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("resolves the property default from set-defaults.json onto the parameter declared in consume-default.json", async () => {
    const loaded = await tp.loadApplication(
      "drift-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    const issuer = loaded.parameters.find((p) => p.id === "oidc_issuer_url");
    expect(issuer).toBeDefined();
    expect(issuer?.default).toBe("https://expected.example.com");
  });
});

// Production layout: bundled shared template under `json/shared/templates/`
// has `default: ""`. A `/config` override at `local/shared/templates/`
// re-declares it with the project's non-empty default. The parameter is
// (re-)declared with `default: ""` by a second shared template (the OIDC
// client setup template). loadApplication should still resolve to the
// project's value once both layers are merged.
describe("TemplateProcessor: layered shared property default with /config override", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let contextManager: ReturnType<
    typeof PersistenceManager.getInstance
  >["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    // Shared template A, bundled — default = "" (empty)
    const sharedCreateCtDir = persistenceHelper.resolve(
      Volume.JsonSharedTemplates,
      "create_ct",
    );
    fs.mkdirSync(sharedCreateCtDir, { recursive: true });
    fs.writeFileSync(
      `${sharedCreateCtDir}/050-set-defaults.json`,
      JSON.stringify(
        {
          name: "Set Defaults",
          description: "Bundled property defaults (placeholder values)",
          commands: [
            {
              properties: [
                { id: "oidc_issuer_url", default: "" },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    // /config override of the same shared template — non-empty default.
    const localSharedCreateCtDir = path.join(
      env.localDir,
      "shared",
      "templates",
      "create_ct",
    );
    fs.mkdirSync(localSharedCreateCtDir, { recursive: true });
    fs.writeFileSync(
      `${localSharedCreateCtDir}/050-set-defaults.json`,
      JSON.stringify(
        {
          name: "Set Defaults",
          description: "Project-specific property defaults",
          commands: [
            {
              properties: [
                { id: "oidc_issuer_url", default: "https://expected.example.com" },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    // Shared template B — bundled — declares parameter with empty default.
    const sharedPreStartDir = persistenceHelper.resolve(
      Volume.JsonSharedTemplates,
      "pre_start",
    );
    fs.mkdirSync(sharedPreStartDir, { recursive: true });
    fs.writeFileSync(
      `${sharedPreStartDir}/150-consume-default.json`,
      JSON.stringify(
        {
          name: "Consume Default",
          description: "Declares oidc_issuer_url with empty default",
          execute_on: "ve",
          parameters: [
            {
              id: "oidc_issuer_url",
              name: "OIDC Issuer URL",
              type: "string",
              required: false,
              default: "",
              description: "Optional issuer URL override",
            },
          ],
          commands: [
            {
              name: "Consume Default",
              script: "consume-default.sh",
            },
          ],
        },
        null,
        2,
      ),
    );

    // Stub script in shared scripts pre_start
    const sharedScriptsDir = persistenceHelper.resolve(
      Volume.JsonSharedScripts,
      "pre_start",
    );
    fs.mkdirSync(sharedScriptsDir, { recursive: true });
    fs.writeFileSync(
      `${sharedScriptsDir}/consume-default.sh`,
      "#!/bin/sh\necho ok\n",
    );

    // Application that consumes both shared templates by name
    const application = {
      name: "Layered Drift App",
      description: "Reproduction of layered property-default drift",
      installation: {
        create_ct: ["050-set-defaults.json"],
        pre_start: ["150-consume-default.json"],
      },
    };
    const appDir = persistenceHelper.resolve(
      Volume.JsonApplications,
      "layered-drift-app",
    );
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      `${appDir}/application.json`,
      JSON.stringify(application, null, 2),
    );

    const { ctx } = env.initPersistence();
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("/config override of shared property-default should win over bundled empty default", async () => {
    const loaded = await tp.loadApplication(
      "layered-drift-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    const issuer = loaded.parameters.find((p) => p.id === "oidc_issuer_url");
    expect(issuer).toBeDefined();
    expect(issuer?.default).toBe("https://expected.example.com");
  });
});

// Production bug: addon templates' parameter declarations never reach
// loadApplication's outParameters (loadAddonCommandsForPhase only injects
// commands, not parameter declarations). Project-level property defaults
// for those parameters are silently dropped by applyPropertyDefaults
// because there is no matching parameter in outParameters. At runtime the
// variable resolver then yields NOT_DEFINED, even though a project default
// was clearly declared.
//
// This test pins the desired behaviour: a property default must flow into
// the runtime defaults Map even when no parameter declaration exists for
// that id (orphan property default).
describe("TemplateProcessor: orphan property default flows to runtime defaults", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let contextManager: ReturnType<
    typeof PersistenceManager.getInstance
  >["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    const templatesDir = persistenceHelper.resolve(
      Volume.JsonApplications,
      "orphan-app/templates",
    );
    fs.mkdirSync(templatesDir, { recursive: true });

    // Application with only a properties-only template — no parameter
    // declarations for `orphan_var` anywhere. This mirrors the production
    // case where 050-set-project-parameters declares a property default for
    // `oidc_issuer_url`, but the parameter is only declared in addon
    // templates (e.g. 150-conf-setup-oidc-client) which loadApplication
    // does not process.
    const application = {
      name: "Orphan App",
      description: "Property default with no matching parameter declaration",
      installation: {
        create_ct: ["set-defaults.json"],
      },
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "orphan-app/application.json",
      application,
    );

    const setDefaults = {
      name: "Set Defaults",
      description: "Project-wide property defaults",
      commands: [
        {
          properties: [
            { id: "orphan_var", default: "https://expected.example.com" },
          ],
        },
      ],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "orphan-app/templates/set-defaults.json",
      setDefaults,
    );

    const { ctx } = env.initPersistence();
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("loadApplication exposes orphan property defaults in propertyDefaults", async () => {
    const loaded = await tp.loadApplication(
      "orphan-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    expect(loaded.propertyDefaults).toBeDefined();
    const orphan = loaded.propertyDefaults?.find(
      (pd) => pd.id === "orphan_var",
    );
    expect(orphan).toBeDefined();
    expect(orphan?.default).toBe("https://expected.example.com");
  });

  it("buildDefaults seeds the runtime Map from orphan property defaults", async () => {
    const loaded = await tp.loadApplication(
      "orphan-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    const processor = new WebAppVeParameterProcessor();
    const defaults = processor.buildDefaults(
      loaded.parameters,
      loaded.propertyDefaults,
    );
    expect(defaults.get("orphan_var")).toBe("https://expected.example.com");
  });

  it("declared parameter wins over orphan property default with the same id", async () => {
    // applyPropertyDefaults already updates declared parameters with the
    // project default; the orphan-merge step in buildDefaults must not
    // re-overwrite that resolved value. Here we provide both a declared
    // parameter (already updated to "via-param") and an orphan property
    // default for a different id.
    const loaded = await tp.loadApplication(
      "orphan-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    const processor = new WebAppVeParameterProcessor();
    const params = [
      ...loaded.parameters,
      { id: "declared", name: "Declared", default: "via-param" } as any,
    ];
    const propertyDefaults = [
      ...(loaded.propertyDefaults ?? []),
      { id: "declared", default: "via-property-default" },
    ];
    const defaults = processor.buildDefaults(params, propertyDefaults);
    expect(defaults.get("declared")).toBe("via-param");
    expect(defaults.get("orphan_var")).toBe("https://expected.example.com");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ContextManager } from "@src/context-manager.mjs";
import type { IParameter } from "@src/types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";

const veContext = { host: "localhost", port: 22 } as any;

describe("TemplateProcessor unresolved + enum variants", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let tp: ReturnType<ContextManager["getTemplateProcessor"]>;

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

    // App: properties resolve required parameter
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-properties-resolution/application.json",
      {
        name: "Test Properties Resolution",
        description: "properties outputs resolve required parameter",
        installation: { post_start: ["set-properties.json", "needs-param.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.JsonApplicationsTemplates,
      "test-properties-resolution/templates/set-properties.json",
      {
        execute_on: "ve",
        name: "Set Properties",
        description: "Sets oci_image via properties",
        parameters: [],
        commands: [
          {
            name: "set-properties",
            properties: [{ id: "oci_image", value: "ghcr.io/example/app" }],
          },
        ],
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.JsonApplicationsTemplates,
      "test-properties-resolution/templates/needs-param.json",
      {
        execute_on: "ve",
        name: "Needs Param",
        description: "Requires oci_image",
        parameters: [
          {
            id: "oci_image",
            name: "OCI Image",
            type: "string",
            required: true,
            description: "Required image",
          },
        ],
        commands: [
          {
            name: "noop",
            command: "echo ok",
          },
        ],
      },
    );

    // App: enum variants
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-enum-variants/application.json",
      {
        name: "Test Enum Variants",
        description: "Enum values variants (0/1/many)",
        installation: { post_start: ["enum-zero.json", "enum-one.json", "enum-many.json"] },
      },
    );

    persistenceHelper.writeJsonSync(
      Volume.JsonApplicationsTemplates,
      "test-enum-variants/templates/enum-zero.json",
      {
        execute_on: "ve",
        name: "Enum Zero",
        description: "Enum values = 0",
        parameters: [
          {
            id: "enum_zero",
            name: "Enum Zero",
            type: "enum",
            required: true,
            enumValuesTemplate: "enum-values-zero.json",
            description: "Zero enum values",
          },
        ],
        commands: [{ name: "noop", command: "echo ok" }],
      },
    );

    persistenceHelper.writeJsonSync(
      Volume.JsonApplicationsTemplates,
      "test-enum-variants/templates/enum-one.json",
      {
        execute_on: "ve",
        name: "Enum One",
        description: "Enum values = 1",
        parameters: [
          {
            id: "enum_one",
            name: "Enum One",
            type: "enum",
            required: true,
            enumValuesTemplate: "enum-values-one.json",
            description: "One enum value",
          },
        ],
        commands: [{ name: "noop", command: "echo ok" }],
      },
    );

    persistenceHelper.writeJsonSync(
      Volume.JsonApplicationsTemplates,
      "test-enum-variants/templates/enum-many.json",
      {
        execute_on: "ve",
        name: "Enum Many",
        description: "Enum values = many",
        parameters: [
          {
            id: "enum_many",
            name: "Enum Many",
            type: "enum",
            required: true,
            enumValuesTemplate: "enum-values-many.json",
            description: "Many enum values",
          },
        ],
        commands: [{ name: "noop", command: "echo ok" }],
      },
    );

    // Shared enum templates — must be in the "list" subdirectory (enumValuesTemplate uses category "list")
    persistenceHelper.writeJsonSync(
      Volume.JsonSharedTemplates,
      "list/enum-values-zero.json",
      {
        execute_on: "ve",
        name: "Enum Values Zero",
        description: "Returns zero enum values",
        commands: [
          {
            name: "emit-zero",
            command: "printf '[]'",
          },
        ],
      },
    );

    persistenceHelper.writeJsonSync(
      Volume.JsonSharedTemplates,
      "list/enum-values-one.json",
      {
        execute_on: "ve",
        name: "Enum Values One",
        description: "Returns one enum value",
        commands: [
          {
            name: "emit-one",
            command: 'printf \'[{"name":"only","value":"only"}]\'',
          },
        ],
      },
    );

    persistenceHelper.writeJsonSync(
      Volume.JsonSharedTemplates,
      "list/enum-values-many.json",
      {
        execute_on: "ve",
        name: "Enum Values Many",
        description: "Returns multiple enum values",
        commands: [
          {
            name: "emit-many",
            command:
              'printf \'[{"name":"a","value":"a"},{"name":"b","value":"b"}]\'',
          },
        ],
      },
    );

    const { ctx } = env.initPersistence({ enableCache: false });
    tp = ctx.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("excludes property-resolved parameters from unresolved list", async () => {
    const unresolved = await tp.getUnresolvedParameters(
      "test-properties-resolution",
      "installation",
      veContext,
    );
    const unresolvedIds = unresolved.map((p: IParameter) => p.id);
    expect(unresolvedIds).not.toContain("oci_image");
  });

  it("enum variants with veContext resolve defaults and unresolved list", async () => {
    const loaded = await tp.loadApplication(
      "test-enum-variants",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    const enumZero = loaded.parameters.find(
      (p: IParameter) => p.id === "enum_zero",
    );
    const enumOne = loaded.parameters.find(
      (p: IParameter) => p.id === "enum_one",
    );
    const enumMany = loaded.parameters.find(
      (p: IParameter) => p.id === "enum_many",
    );

    expect(enumZero).toBeDefined();
    expect(enumOne).toBeDefined();
    expect(enumMany).toBeDefined();

    expect((enumZero as any)?.enumValues).toBeUndefined();

    expect(Array.isArray((enumOne as any)?.enumValues)).toBe(true);
    expect((enumOne as any)?.enumValues?.length ?? 0).toBe(1);
    expect(enumOne?.default).toBe("only");

    expect(Array.isArray((enumMany as any)?.enumValues)).toBe(true);
    expect((enumMany as any)?.enumValues?.length ?? 0).toBe(2);
    expect(enumMany?.default).toBeUndefined();

    const unresolved = await tp.getUnresolvedParameters(
      "test-enum-variants",
      "installation",
      veContext,
    );
    const unresolvedIds = unresolved.map((p: IParameter) => p.id);
    expect(unresolvedIds).toContain("enum_zero");
    expect(unresolvedIds).toContain("enum_many");
    expect(unresolvedIds).toContain("enum_one");
  });

  it("enum variants without veContext remain unresolved", async () => {
    const loaded = await tp.loadApplication(
      "test-enum-variants",
      "installation",
      undefined,
      ExecutionMode.TEST,
    );

    const enumZero = loaded.parameters.find(
      (p: IParameter) => p.id === "enum_zero",
    );
    const enumOne = loaded.parameters.find(
      (p: IParameter) => p.id === "enum_one",
    );
    const enumMany = loaded.parameters.find(
      (p: IParameter) => p.id === "enum_many",
    );

    expect(enumZero?.default).toBeUndefined();
    expect(enumOne?.default).toBeUndefined();
    expect(enumMany?.default).toBeUndefined();

    const unresolved = await tp.getUnresolvedParameters(
      "test-enum-variants",
      "installation",
      undefined,
    );
    const unresolvedIds = unresolved.map((p: IParameter) => p.id);
    expect(unresolvedIds).toContain("enum_zero");
    expect(unresolvedIds).toContain("enum_one");
    expect(unresolvedIds).toContain("enum_many");
  });
});

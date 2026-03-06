import { describe, it, expect } from "vitest";
import { CliTemplateGenerator } from "@src/cli/cli-template-generator.mjs";
import type { IParameter, IAddonWithParameters, IStack } from "@src/types.mjs";

describe("CliTemplateGenerator", () => {
  const generator = new CliTemplateGenerator();

  function makeDef(overrides: Partial<IParameter> & { id: string }): IParameter {
    return {
      name: overrides.id,
      type: "string",
      required: false,
      ...overrides,
    } as IParameter;
  }

  it("should generate template with comment and params", () => {
    const result = generator.generate({
      application: "node-red",
      task: "installation",
      parameters: [
        makeDef({ id: "hostname", required: true, description: "Container hostname" }),
        makeDef({ id: "memory", type: "number", default: 512 }),
      ],
      addons: [],
      stacks: [],
    }) as any;

    expect(result.$comment).toContain("node-red");
    expect(result.$comment).toContain("installation");
    expect(result.params).toHaveLength(2);

    const hostnameParam = result.params.find((p: any) => p.name === "hostname");
    expect(hostnameParam.$required).toBe(true);
    expect(hostnameParam.$type).toBe("string");
    expect(hostnameParam.$description).toBe("Container hostname");
    expect(hostnameParam.value).toBe("");

    const memoryParam = result.params.find((p: any) => p.name === "memory");
    expect(memoryParam.$type).toBe("number");
    expect(memoryParam.value).toBe(512);
  });

  it("should include enum values in template", () => {
    const result = generator.generate({
      application: "test",
      task: "installation",
      parameters: [
        makeDef({
          id: "log_level",
          type: "enum",
          enumValues: [
            { name: "Info", value: "info" },
            { name: "Debug", value: "debug" },
          ],
        }),
      ],
      addons: [],
      stacks: [],
    }) as any;

    const param = result.params[0];
    expect(param.$type).toBe("enum");
    expect(param.$enumValues).toEqual(["info", "debug"]);
  });

  it("should mark upload params", () => {
    const result = generator.generate({
      application: "test",
      task: "installation",
      parameters: [
        makeDef({ id: "cert", upload: true } as any),
      ],
      addons: [],
      stacks: [],
    }) as any;

    expect(result.params[0].$upload).toBe(true);
  });

  it("should include available addons", () => {
    const addons: IAddonWithParameters[] = [
      {
        id: "addon-ssl",
        name: "SSL/HTTPS",
        description: "Enable HTTPS",
        parameters: [],
      } as any,
    ];

    const result = generator.generate({
      application: "test",
      task: "installation",
      parameters: [],
      addons,
      stacks: [],
    }) as any;

    expect(result.addons).toEqual([]);
    expect(result.availableAddons).toHaveLength(1);
    expect(result.availableAddons[0].$id).toBe("addon-ssl");
    expect(result.availableAddons[0].$name).toBe("SSL/HTTPS");
  });

  it("should include available stacks", () => {
    const stacks: IStack[] = [
      { id: "pg-prod", name: "Production", parameters: [] } as any,
    ];

    const result = generator.generate({
      application: "test",
      task: "installation",
      parameters: [],
      addons: [],
      stacks,
    }) as any;

    expect(result.stackId).toBe("");
    expect(result.availableStacks).toHaveLength(1);
    expect(result.availableStacks[0].$id).toBe("pg-prod");
    expect(result.availableStacks[0].$name).toBe("Production");
  });

  it("should produce valid JSON", () => {
    const result = generator.generate({
      application: "test",
      task: "installation",
      parameters: [makeDef({ id: "hostname", required: true })],
      addons: [],
      stacks: [],
    });

    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.params).toHaveLength(1);
  });

  it("should add $stackComment when stacktype exists but no stacks", () => {
    const result = generator.generate({
      application: "zitadel",
      task: "installation",
      parameters: [],
      addons: [],
      stacks: [],
      stacktype: "postgres",
    }) as any;

    expect(result.$stackComment).toContain("postgres");
    expect(result.$stackComment).toContain("default");
    expect(result.$stackComment).toContain("custom name");
    expect(result.availableStacks).toEqual([]);
  });

  it("should not add $stackComment when stacks exist", () => {
    const result = generator.generate({
      application: "zitadel",
      task: "installation",
      parameters: [],
      addons: [],
      stacks: [{ id: "pg-prod", name: "Production" } as any],
      stacktype: "postgres",
    }) as any;

    expect(result.$stackComment).toBeUndefined();
    expect(result.availableStacks).toHaveLength(1);
  });
});

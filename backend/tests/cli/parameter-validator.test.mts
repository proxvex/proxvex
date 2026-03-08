import { describe, it, expect } from "vitest";
import { ParameterValidator } from "@src/parameter-validator.mjs";
import type { IParameter, IAddonWithParameters, IStack } from "@src/types.mjs";

describe("ParameterValidator", () => {
  const validator = new ParameterValidator();

  function makeDef(overrides: Partial<IParameter> & { id: string }): IParameter {
    return {
      name: overrides.id,
      type: "string",
      required: false,
      ...overrides,
    } as IParameter;
  }

  describe("required params", () => {
    it("should fail when required param is missing", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [makeDef({ id: "hostname", required: true })],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe("hostname");
    });

    it("should fail when required param is empty string", () => {
      const result = validator.validate({
        params: [{ name: "hostname", value: "" }],
        parameterDefs: [makeDef({ id: "hostname", required: true })],
      });
      expect(result.valid).toBe(false);
    });

    it("should pass when required param has value", () => {
      const result = validator.validate({
        params: [{ name: "hostname", value: "my-host" }],
        parameterDefs: [makeDef({ id: "hostname", required: true })],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass when optional param is missing", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [makeDef({ id: "description", required: false })],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("type validation", () => {
    it("should fail for non-numeric number param", () => {
      const result = validator.validate({
        params: [{ name: "memory", value: "abc" }],
        parameterDefs: [makeDef({ id: "memory", type: "number" })],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe("memory");
    });

    it("should accept numeric string for number param", () => {
      const result = validator.validate({
        params: [{ name: "memory", value: "512" }],
        parameterDefs: [makeDef({ id: "memory", type: "number" })],
      });
      expect(result.valid).toBe(true);
    });

    it("should accept actual number for number param", () => {
      const result = validator.validate({
        params: [{ name: "memory", value: 512 }],
        parameterDefs: [makeDef({ id: "memory", type: "number" })],
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for invalid boolean param", () => {
      const result = validator.validate({
        params: [{ name: "ssl", value: "yes" }],
        parameterDefs: [makeDef({ id: "ssl", type: "boolean" })],
      });
      expect(result.valid).toBe(false);
    });

    it("should accept string 'true' for boolean param", () => {
      const result = validator.validate({
        params: [{ name: "ssl", value: "true" }],
        parameterDefs: [makeDef({ id: "ssl", type: "boolean" })],
      });
      expect(result.valid).toBe(true);
    });

    it("should accept actual boolean for boolean param", () => {
      const result = validator.validate({
        params: [{ name: "ssl", value: true }],
        parameterDefs: [makeDef({ id: "ssl", type: "boolean" })],
      });
      expect(result.valid).toBe(true);
    });

    it("should skip type check for empty optional value", () => {
      const result = validator.validate({
        params: [{ name: "memory", value: "" }],
        parameterDefs: [makeDef({ id: "memory", type: "number" })],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("enum validation", () => {
    const enumDef = makeDef({
      id: "log_level",
      type: "enum",
      enumValues: [
        { name: "Info", value: "info" },
        { name: "Debug", value: "debug" },
      ],
    });

    it("should pass for valid enum value", () => {
      const result = validator.validate({
        params: [{ name: "log_level", value: "info" }],
        parameterDefs: [enumDef],
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for invalid enum value", () => {
      const result = validator.validate({
        params: [{ name: "log_level", value: "trace" }],
        parameterDefs: [enumDef],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain("info");
      expect(result.errors[0].message).toContain("debug");
    });

    it("should handle string-only enum values", () => {
      const stringEnumDef = makeDef({
        id: "mode",
        type: "enum",
        enumValues: ["proxy", "native"] as any,
      });
      const result = validator.validate({
        params: [{ name: "mode", value: "proxy" }],
        parameterDefs: [stringEnumDef],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("unknown params", () => {
    it("should warn for unknown param", () => {
      const result = validator.validate({
        params: [{ name: "unknown_param", value: "hello" }],
        parameterDefs: [],
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].field).toBe("unknown_param");
    });
  });

  describe("addon validation", () => {
    const addons: IAddonWithParameters[] = [
      { id: "addon-ssl", name: "SSL", parameters: [], description: "" } as any,
    ];

    it("should pass for valid addon ID", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        selectedAddons: ["addon-ssl"],
        availableAddons: addons,
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for unknown addon ID", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        selectedAddons: ["addon-nonexistent"],
        availableAddons: addons,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe("addons");
    });
  });

  describe("addon required_parameters validation", () => {
    const sslAddon: IAddonWithParameters = {
      id: "addon-ssl",
      name: "SSL/HTTPS",
      required_parameters: ["ssl.mode", "ssl.certs_dir"],
      parameters: [],
      description: "",
    } as any;

    const noReqAddon: IAddonWithParameters = {
      id: "addon-basic",
      name: "Basic",
      parameters: [],
      description: "",
    } as any;

    it("should pass when all required_parameters are present in application", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        selectedAddons: ["addon-ssl"],
        availableAddons: [sslAddon],
        applicationParamIds: new Set(["ssl.mode", "ssl.certs_dir", "hostname"]),
      });
      expect(result.valid).toBe(true);
    });

    it("should fail when required_parameters are missing from application", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        selectedAddons: ["addon-ssl"],
        availableAddons: [sslAddon],
        applicationParamIds: new Set(["hostname"]),
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe("addons");
      expect(result.errors[0].message).toContain("ssl.mode");
      expect(result.errors[0].message).toContain("ssl.certs_dir");
    });

    it("should pass when addon has no required_parameters", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        selectedAddons: ["addon-basic"],
        availableAddons: [noReqAddon],
        applicationParamIds: new Set(["hostname"]),
      });
      expect(result.valid).toBe(true);
    });

    it("should skip required_parameters check when applicationParamIds is not provided", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        selectedAddons: ["addon-ssl"],
        availableAddons: [sslAddon],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("stack validation", () => {
    const stacks: IStack[] = [
      { id: "postgres-prod", name: "Production" } as any,
    ];

    it("should pass for valid stack ID", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        stackId: "postgres-prod",
        availableStacks: stacks,
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for unknown stack ID", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        stackId: "nonexistent",
        availableStacks: stacks,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe("stackId");
    });

    it("should skip stack validation when no stacks provided", () => {
      const result = validator.validate({
        params: [],
        parameterDefs: [],
        stackId: "anything",
      });
      expect(result.valid).toBe(true);
    });
  });
});

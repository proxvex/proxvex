import { describe, it, expect } from "vitest";
import { WebAppVeParameterProcessor } from "@src/webapp/webapp-ve-parameter-processor.mjs";
import type { IParameter, IDeployParamsSnapshot } from "@src/types.mjs";

function def(overrides: Partial<IParameter> & { id: string }): IParameter {
  return {
    name: overrides.id,
    type: "string",
    ...overrides,
  } as IParameter;
}

describe("WebAppVeParameterProcessor deploy-params", () => {
  const proc = new WebAppVeParameterProcessor();

  describe("buildDeployParamsSnapshot", () => {
    const loaded: IParameter[] = [
      def({ id: "memory" }),
      def({ id: "local_https_port" }),
      def({ id: "oidc_client_secret", secure: true }),
      def({ id: "config_file", upload: true }),
      def({ id: "hostname" }),
    ];

    it("round-trips and keeps user params (incl. secrets), drops transient/upload/empty", () => {
      const b64 = proc.buildDeployParamsSnapshot(
        [
          { name: "memory", value: 2048 },
          { name: "local_https_port", value: "3443" },
          { name: "oidc_client_secret", value: "s3cret" }, // secret KEPT (project decision)
          { name: "config_file", value: "local:/tmp/x" }, // upload DROPPED
          { name: "hostname", value: "" }, // empty DROPPED
          { name: "vm_id", value: 505 }, // transient DROPPED
          { name: "previous_vm_id", value: 504 }, // transient DROPPED
        ],
        loaded,
        ["addon-ssl"],
        [],
        ["postgres_default"],
      );
      const snap = proc.decodeDeployParams(b64) as IDeployParamsSnapshot;
      expect(snap.v).toBe(1);
      const names = snap.params.map((p) => p.name).sort();
      expect(names).toEqual(["local_https_port", "memory", "oidc_client_secret"]);
      expect(snap.params.find((p) => p.name === "memory")?.value).toBe(2048);
      expect(snap.params.find((p) => p.name === "oidc_client_secret")?.value).toBe("s3cret");
      expect(snap.selectedAddons).toEqual(["addon-ssl"]);
      expect(snap.stackIds).toEqual(["postgres_default"]);
    });

    it("returns empty string when nothing worth persisting", () => {
      expect(
        proc.buildDeployParamsSnapshot(
          [{ name: "vm_id", value: 1 }, { name: "hostname", value: "" }],
          loaded,
          [],
          [],
          [],
        ),
      ).toBe("");
    });
  });

  describe("decodeDeployParams", () => {
    it("returns undefined for absent / malformed / wrong-version input", () => {
      expect(proc.decodeDeployParams(undefined)).toBeUndefined();
      expect(proc.decodeDeployParams("")).toBeUndefined();
      expect(proc.decodeDeployParams("not-base64-!@#")).toBeUndefined();
      expect(
        proc.decodeDeployParams(Buffer.from("{not json").toString("base64")),
      ).toBeUndefined();
      expect(
        proc.decodeDeployParams(
          Buffer.from(JSON.stringify({ v: 99, params: [] })).toString("base64"),
        ),
      ).toBeUndefined();
    });

    it("decodes a valid snapshot", () => {
      const b64 = Buffer.from(
        JSON.stringify({ v: 1, params: [{ name: "memory", value: 1024 }] }),
      ).toString("base64");
      expect(proc.decodeDeployParams(b64)?.params[0]!.value).toBe(1024);
    });
  });

  describe("mergeDeployBaseline", () => {
    const baseline: IDeployParamsSnapshot = {
      v: 1,
      params: [
        { name: "memory", value: 2048 },
        { name: "cores", value: 2 },
      ],
    };

    it("undefined baseline is an identity no-op", () => {
      const req = [{ name: "memory", value: 512 }];
      expect(proc.mergeDeployBaseline(req, undefined)).toBe(req);
    });

    it("request wins; baseline-only params are appended", () => {
      const merged = proc.mergeDeployBaseline(
        [{ name: "memory", value: 512 }],
        baseline,
      );
      const byName = new Map(merged.map((p) => [p.name, p.value]));
      expect(byName.get("memory")).toBe(512); // request override
      expect(byName.get("cores")).toBe(2); // baseline-only appended
    });

    it("empty request value does not clobber a real baseline value", () => {
      const merged = proc.mergeDeployBaseline(
        [{ name: "memory", value: "" }],
        baseline,
      );
      expect(new Map(merged.map((p) => [p.name, p.value])).get("memory")).toBe(2048);
    });
  });

  describe("buildDefaults regression (unchanged lowest tier)", () => {
    it("maps parameter-definition default and is shielded from property defaults", () => {
      const defaults = proc.buildDefaults(
        [def({ id: "local_https_port", default: "1443" })],
        [{ id: "local_https_port", default: "9999" }],
      );
      // param-def default wins over a later propertyDefault; property `.value`
      // is never consulted here — that gap is what the deploy-params baseline
      // and the app_external_url lookupEffective work around.
      expect(defaults.get("local_https_port")).toBe("1443");
    });
  });
});

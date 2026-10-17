import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH =
  "shared/templates/start/210-wait-for-container-ready.json";

describe.skipIf(!hostReachable)(
  "Template: 210-wait-for-container-ready",
  () => {
    const config = loadTemplateTestConfig();
    const stateManager = new TestStateManager(config);
    const helper = new TemplateTestHelper(config);

    describe("Alpine", () => {
      const vmId = "9900";

      beforeAll(async () => {
        await stateManager.ensureContainerRunning(vmId, {
          osType: "alpine",
          hostname: "tmpl-test-alpine",
        });
      // > pct create (180 s, see TestStateManager) + pct start (30 s): with a
      // shorter hook the suite gave up before the helper's own limit.
      }, 240000);

      afterAll(async () => {
        await stateManager.cleanup(vmId);
      }, 30000);

      it("should detect Alpine container as ready", async () => {
        const result = await helper.runTemplate({
          templatePath: TEMPLATE_PATH,
          inputs: { vm_id: vmId },
        });

        expect(result.success).toBe(true);
        expect(result.outputs["ready"]).toBe("true");
      });

      it("should report readiness via stderr logs", async () => {
        const result = await helper.runTemplate({
          templatePath: TEMPLATE_PATH,
          inputs: { vm_id: vmId },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('"ready"');
      });
    });

    describe("Debian", () => {
      const vmId = "9901";

      beforeAll(async () => {
        await stateManager.ensureContainerRunning(vmId, {
          osType: "debian",
          hostname: "tmpl-test-debian",
        });
      // > pct create (180 s, see TestStateManager) + pct start (30 s): with a
      // shorter hook the suite gave up before the helper's own limit.
      }, 240000);

      afterAll(async () => {
        await stateManager.cleanup(vmId);
      }, 30000);

      it("should detect Debian container as ready", async () => {
        const result = await helper.runTemplate({
          templatePath: TEMPLATE_PATH,
          inputs: { vm_id: vmId },
        });

        expect(result.success).toBe(true);
        expect(result.outputs["ready"]).toBe("true");
      });

      it("should report readiness via stderr logs", async () => {
        const result = await helper.runTemplate({
          templatePath: TEMPLATE_PATH,
          inputs: { vm_id: vmId },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('"ready"');
      });
    });
  },
);

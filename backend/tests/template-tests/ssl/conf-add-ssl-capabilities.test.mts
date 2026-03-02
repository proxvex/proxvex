import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH =
  "shared/templates/pre_start/170-conf-add-ssl-capabilities.json";

describe.skipIf(!hostReachable)(
  "Template: 170-conf-add-ssl-capabilities",
  () => {
    const config = loadTemplateTestConfig();
    const stateManager = new TestStateManager(config);
    const helper = new TemplateTestHelper(config);
    const vmId = "9920";

    beforeAll(async () => {
      await stateManager.ensureContainerCreatedStopped(vmId, {
        osType: "alpine",
        hostname: "tmpl-test-ssl-caps",
      });
    }, 120000);

    afterAll(async () => {
      await stateManager.cleanup(vmId);
    }, 30000);

    it("should add net_admin capability for proxy mode", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          addon_ssl_mode: "proxy",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["ssl_capabilities_set"]).toBe("true");

      // Verify the config contains net_admin
      const confResult = await stateManager.execOnHost(
        `grep 'net_admin' /etc/pve/lxc/${vmId}.conf`,
      );
      expect(confResult.stdout).toContain("net_admin");
    });

    it("should not add capability for native mode", async () => {
      // Remove net_admin from previous test (container reuse keeps config)
      await stateManager.execOnHost(
        `sed -i '/net_admin/d' /etc/pve/lxc/${vmId}.conf`,
      );

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          addon_ssl_mode: "native",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["ssl_capabilities_set"]).toBe("false");

      // Config should NOT contain net_admin
      const confResult = await stateManager.execOnHost(
        `grep 'net_admin' /etc/pve/lxc/${vmId}.conf || echo 'NOT_FOUND'`,
      );
      expect(confResult.stdout).toContain("NOT_FOUND");
    });

    it("should not duplicate capability if already present", async () => {
      // First, add the capability
      await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          addon_ssl_mode: "proxy",
        },
      });

      // Run again
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          addon_ssl_mode: "proxy",
        },
      });

      expect(result.success).toBe(true);

      // Count occurrences of net_admin
      const confResult = await stateManager.execOnHost(
        `grep -c 'net_admin' /etc/pve/lxc/${vmId}.conf`,
      );
      expect(confResult.stdout.trim()).toBe("1");
    });
  },
);

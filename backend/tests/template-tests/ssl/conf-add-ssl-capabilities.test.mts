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

    // An unprivileged CT already holds net_admin in its user namespace.
    // `lxc.cap.keep: net_admin` would keep ONLY net_admin and break
    // iptables-legacy (cap_net_raw) and nginx (cap_chown) for root apps.
    it("adds no capability line for proxy mode on an unprivileged container", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          ssl_mode: "proxy",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["ssl_capabilities_set"]).toBe("true");

      const confResult = await stateManager.execOnHost(
        `grep '^lxc.cap.keep' /etc/pve/lxc/${vmId}.conf || echo 'NOT_FOUND'`,
      );
      expect(confResult.stdout).toContain("NOT_FOUND");
    });

    it("reports false for native mode", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          ssl_mode: "native",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["ssl_capabilities_set"]).toBe("false");
    });

    it("removes an obsolete 'lxc.cap.keep: net_admin' written by earlier versions", async () => {
      await stateManager.execOnHost(
        `echo 'lxc.cap.keep: net_admin' >> /etc/pve/lxc/${vmId}.conf`,
      );

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          ssl_mode: "proxy",
        },
      });

      expect(result.success).toBe(true);
      const confResult = await stateManager.execOnHost(
        `grep -c '^lxc.cap.keep' /etc/pve/lxc/${vmId}.conf || true`,
      );
      expect(confResult.stdout.trim()).toBe("0");
    });
  },
);

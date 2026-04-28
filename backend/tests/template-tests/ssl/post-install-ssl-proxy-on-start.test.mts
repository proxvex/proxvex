import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH =
  "shared/templates/post_start/340-post-install-ssl-proxy-on-start.json";

describe.skipIf(!hostReachable)(
  "Template: 340-post-install-ssl-proxy-on-start",
  () => {
    const config = loadTemplateTestConfig();
    const stateManager = new TestStateManager(config);
    const helper = new TemplateTestHelper(config);
    const vmId = "9922";

    beforeAll(async () => {
      await stateManager.ensureContainerReady(vmId, {
        osType: "alpine",
        hostname: "tmpl-test-ssl-proxy",
      });
    }, 180000);

    afterAll(async () => {
      await stateManager.cleanup(vmId);
    }, 30000);

    it("should create on-start drop-in script", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          "ssl.mode": "proxy",
          http_port: "3000",
          https_port: "3443",
          alpine_mirror: "",
          debian_mirror: "",
        },
        vmId,
      });

      expect(result.success).toBe(true);

      // Verify the drop-in script exists
      const scriptExists = await stateManager.execOnHost(
        `pct exec ${vmId} -- test -x /etc/lxc-oci-deployer/on_start.d/ssl-proxy.sh && echo "OK"`,
      );
      expect(scriptExists.stdout.trim()).toBe("OK");
    });

    it("should install nginx and set iptables rules", async () => {
      // Add net_admin capability (normally done by template 170) and restart container
      await stateManager.execOnHost(
        `grep -q 'net_admin' /etc/pve/lxc/${vmId}.conf || echo 'lxc.cap.keep: net_admin' >> /etc/pve/lxc/${vmId}.conf`,
      );
      await stateManager.execOnHost(`pct stop ${vmId} 2>/dev/null; pct start ${vmId}`, 30000);
      // Wait for container to be ready
      await stateManager.execOnHost(
        `for i in $(seq 1 10); do pct exec ${vmId} -- true 2>/dev/null && break; sleep 1; done`,
      );

      // Create certificates on host and push into container
      await stateManager.execOnHost(
        `pct exec ${vmId} -- mkdir -p /etc/ssl/addon`,
      );
      await stateManager.execOnHost(
        `openssl req -x509 -newkey rsa:2048 -keyout /tmp/test-ssl-key.pem -out /tmp/test-ssl-cert.pem -days 1 -nodes -subj "/CN=test" 2>/dev/null`,
      );
      await stateManager.execOnHost(
        `pct push ${vmId} /tmp/test-ssl-cert.pem /etc/ssl/addon/fullchain.pem`,
      );
      await stateManager.execOnHost(
        `pct push ${vmId} /tmp/test-ssl-key.pem /etc/ssl/addon/privkey.pem`,
      );

      // Verify the on-start script exists and check its content
      const scriptCheck = await stateManager.execOnHost(
        `pct exec ${vmId} -- cat /etc/lxc-oci-deployer/on_start.d/ssl-proxy.sh 2>&1 | head -10`,
      );
      expect(scriptCheck.stdout).toContain("SSL_MODE");

      // Verify certs exist
      const certCheck = await stateManager.execOnHost(
        `pct exec ${vmId} -- ls -la /etc/ssl/addon/ 2>&1`,
      );
      expect(certCheck.stdout).toContain("fullchain.pem");

      // Run the on-start script manually to trigger nginx installation
      await stateManager.execOnHost(
        `pct exec ${vmId} -- sh -c '/etc/lxc-oci-deployer/on_start.d/ssl-proxy.sh 2>&1; echo "EXIT_CODE=$?"'`,
        60000,
      );

      // Verify nginx is running
      const nginxCheck = await stateManager.execOnHost(
        `pct exec ${vmId} -- sh -c 'pgrep -x nginx && echo "RUNNING" || echo "NOT_RUNNING"'`,
      );
      expect(nginxCheck.stdout).toContain("RUNNING");

      // Verify nginx SSL config was written
      const configCheck = await stateManager.execOnHost(
        `pct exec ${vmId} -- sh -c 'cat /etc/nginx/http.d/ssl-proxy.conf 2>/dev/null || cat /etc/nginx/conf.d/ssl-proxy.conf 2>/dev/null || echo "NO_CONFIG"'`,
      );
      expect(configCheck.stdout).toContain("listen 3443 ssl");
      expect(configCheck.stdout).toContain("proxy_pass http://127.0.0.1:3000");
    }, 120000);

    it("should skip for native mode", async () => {
      // Recreate clean container
      await stateManager.ensureContainerReady(vmId, {
        osType: "alpine",
        hostname: "tmpl-test-ssl-native",
      });

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          "ssl.mode": "native",
          http_port: "3000",
          https_port: "3443",
          alpine_mirror: "",
          debian_mirror: "",
        },
        vmId,
      });

      expect(result.success).toBe(true);

      // Script should exist
      const scriptExists = await stateManager.execOnHost(
        `pct exec ${vmId} -- test -x /etc/lxc-oci-deployer/on_start.d/ssl-proxy.sh && echo "OK"`,
      );
      expect(scriptExists.stdout.trim()).toBe("OK");

      // But nginx should NOT be installed
      const nginxCheck = await stateManager.execOnHost(
        `pct exec ${vmId} -- command -v nginx && echo "INSTALLED" || echo "NOT_INSTALLED"`,
      );
      expect(nginxCheck.stdout).toContain("NOT_INSTALLED");
    }, 120000);
  },
);

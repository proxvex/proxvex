import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH =
  "shared/templates/post_start/325-post-inject-ssl-proxy-compose.json";

describe.skipIf(!hostReachable)(
  "Template: 325-post-inject-ssl-proxy-compose",
  () => {
    const config = loadTemplateTestConfig();
    const stateManager = new TestStateManager(config);
    const helper = new TemplateTestHelper(config);
    const vmId = "9923";
    const composeProject = "test-compose";

    beforeAll(async () => {
      await stateManager.ensureContainerReady(vmId, {
        osType: "alpine",
        hostname: "tmpl-test-ssl-compose",
      });

      // Create compose project directory with a simple compose file
      await stateManager.execOnHost(
        `pct exec ${vmId} -- mkdir -p /opt/docker-compose/${composeProject}`,
      );
      await stateManager.execOnHost(
        `pct exec ${vmId} -- sh -c 'cat > /opt/docker-compose/${composeProject}/docker-compose.yml << EOF
services:
  myapp:
    image: alpine:latest
    ports:
      - "3000:3000"
    restart: unless-stopped
EOF'`,
      );
    }, 180000);

    afterAll(async () => {
      await stateManager.cleanup(vmId);
    }, 30000);

    it("should inject nginx service into compose file", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          compose_project: composeProject,
          addon_ssl_mode: "proxy",
          http_port: "3000",
          https_port: "3443",
        },
        vmId,
      });

      expect(result.success).toBe(true);

      // Verify compose file contains nginx-ssl-proxy
      const composeContent = await stateManager.execOnHost(
        `pct exec ${vmId} -- cat /opt/docker-compose/${composeProject}/docker-compose.yml`,
      );
      expect(composeContent.stdout).toContain("nginx-ssl-proxy");
      expect(composeContent.stdout).toContain("3443:3443");

      // Verify HTTP port mapping was removed
      expect(composeContent.stdout).not.toContain('"3000:3000"');

      // Verify nginx config was written
      const nginxConf = await stateManager.execOnHost(
        `pct exec ${vmId} -- cat /opt/docker-compose/${composeProject}/nginx-ssl.conf`,
      );
      expect(nginxConf.stdout).toContain("proxy_pass http://myapp:3000");
      expect(nginxConf.stdout).toContain("listen 3443 ssl");
    });

    it("should not modify compose file for native mode", async () => {
      // Reset compose file
      await stateManager.execOnHost(
        `pct exec ${vmId} -- sh -c 'cat > /opt/docker-compose/${composeProject}/docker-compose.yml << EOF
services:
  myapp:
    image: alpine:latest
    ports:
      - "3000:3000"
    restart: unless-stopped
EOF'`,
      );

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          compose_project: composeProject,
          addon_ssl_mode: "native",
          http_port: "3000",
          https_port: "3443",
        },
        vmId,
      });

      expect(result.success).toBe(true);

      // Compose file should remain unchanged
      const composeContent = await stateManager.execOnHost(
        `pct exec ${vmId} -- cat /opt/docker-compose/${composeProject}/docker-compose.yml`,
      );
      expect(composeContent.stdout).not.toContain("nginx-ssl-proxy");
      expect(composeContent.stdout).toContain('"3000:3000"');
    });

    it("should error when https_port conflicts", async () => {
      // Create compose file with service using the same HTTPS port
      await stateManager.execOnHost(
        `pct exec ${vmId} -- sh -c 'cat > /opt/docker-compose/${composeProject}/docker-compose.yml << EOF
services:
  myapp:
    image: alpine:latest
    ports:
      - "3443:3443"
    restart: unless-stopped
EOF'`,
      );

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          compose_project: composeProject,
          addon_ssl_mode: "proxy",
          http_port: "3000",
          https_port: "3443",
        },
        vmId,
      });

      // Should fail with port conflict error
      expect(result.success).toBe(false);
    });
  },
);

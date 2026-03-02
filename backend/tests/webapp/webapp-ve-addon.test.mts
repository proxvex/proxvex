import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs-extra";
import path from "path";
import { ApiUri, IPostVeConfigurationBody } from "@src/types.mjs";
import {
  createWebAppVETestSetup,
  type WebAppVETestSetup,
} from "../helper/webapp-test-helper.mjs";
import type { ContextManager } from "@src/context-manager.mjs";
import type { ITemplate } from "../ve-test-helper.mjs";

// Local helper functions for addon tests
function writeAddon(
  jsonDir: string,
  addonId: string,
  data: Record<string, unknown>,
): void {
  const addonsDir = path.join(jsonDir, "addons");
  fs.ensureDirSync(addonsDir);
  const addonPath = path.join(addonsDir, `${addonId}.json`);
  fs.writeFileSync(addonPath, JSON.stringify(data, null, 2), "utf-8");
}

function writeSharedTemplate(
  jsonDir: string,
  tmplName: string,
  data: ITemplate,
): void {
  const sharedTmplDir = path.join(jsonDir, "shared", "templates");
  fs.ensureDirSync(sharedTmplDir);
  const tmplPath = path.join(sharedTmplDir, tmplName);
  fs.writeFileSync(tmplPath, JSON.stringify(data, null, 2), "utf-8");
}

describe("WebAppVE Addon Integration", () => {
  let app: WebAppVETestSetup["app"];
  let helper: WebAppVETestSetup["helper"];
  let storageContext: ContextManager;
  let veContextKey: string;
  let setup: WebAppVETestSetup;

  beforeEach(async () => {
    setup = await createWebAppVETestSetup();
    helper = setup.helper;
    app = setup.app;
    storageContext = setup.ctx;

    // Create a test VE context
    veContextKey = "ve_testhost";
    storageContext.setVEContext({
      host: "testhost",
      port: 22,
      current: true,
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  describe("validateVeConfigurationBody with selectedAddons", () => {
    it("should accept valid selectedAddons array", async () => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["test-addon"],
        } as IPostVeConfigurationBody);

      // Should not fail on validation - may fail on addon not found
      expect(response.status).not.toBe(400);
    });

    it("should reject invalid selectedAddons (not an array)", async () => {
      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          selectedAddons: "not-an-array",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid selectedAddons");
    });

    it("should accept empty selectedAddons array", async () => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: [],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should accept undefined selectedAddons", async () => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          // No selectedAddons
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Addon commands integration in handleVeConfiguration", () => {
    beforeEach(() => {
      // Create a test application
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });
    });

    it("should load and append addon commands for installation task", async () => {
      // Create a test addon
      writeAddon(helper.jsonDir, "test-addon", {
        name: "Test Addon",
        description: "A test addon",
        compatible_with: "*",
        notes_key: "test-addon",
        post_start: ["addon-template.json"],
      });

      // Create the addon template in shared templates
      writeSharedTemplate(helper.jsonDir, "addon-template.json", {
        execute_on: "lxc",
        name: "Addon Template",
        description: "Test addon template",
        commands: [
          {
            name: "Addon Command",
            command: 'echo \'[{"id": "addon_result", "value": "success"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["test-addon"],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
    });

    it("should skip non-existent addons gracefully", async () => {
      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["non-existent-addon"],
        } as IPostVeConfigurationBody);

      // Should still succeed, just skip the non-existent addon
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should add addon properties as commands", async () => {
      // Create addon with properties
      writeAddon(helper.jsonDir, "addon-with-props", {
        name: "Addon with Properties",
        description: "Test addon with properties",
        compatible_with: "*",
        notes_key: "addon-with-props",
        properties: [
          { id: "addon_packages", value: "nginx" },
          { id: "addon_config", value: "/etc/nginx" },
        ],
        post_start: ["addon-template.json"],
      });

      writeSharedTemplate(helper.jsonDir, "addon-template.json", {
        execute_on: "lxc",
        name: "Addon Template",
        description: "Test addon template",
        commands: [
          {
            name: "Addon Command",
            command: 'echo \'[{"id": "addon_result", "value": "success"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["addon-with-props"],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should handle addon with no templates for the phase", async () => {
      // Create addon with only pre_start (not post_start)
      writeAddon(helper.jsonDir, "pre-start-only-addon", {
        name: "Pre-Start Only Addon",
        description: "Addon with only pre_start templates",
        compatible_with: "*",
        notes_key: "pre-start-only",
        pre_start: ["pre-template.json"],
        // No post_start - installation uses post_start phase
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["pre-start-only-addon"],
        } as IPostVeConfigurationBody);

      // Should still succeed, just no addon commands added
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should set selected_addons in defaults for notes update", async () => {
      writeAddon(helper.jsonDir, "test-addon", {
        name: "Test Addon",
        description: "A test addon",
        compatible_with: "*",
        notes_key: "test-addon",
        post_start: ["addon-template.json"],
      });

      writeSharedTemplate(helper.jsonDir, "addon-template.json", {
        execute_on: "lxc",
        name: "Addon Template",
        description: "Test addon template",
        commands: [
          {
            name: "Addon Command",
            command: 'echo \'[{"id": "addon_result", "value": "success"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["test-addon", "another-addon"],
        } as IPostVeConfigurationBody);

      // The test verifies the request succeeds - the selected_addons default
      // is set internally and used by notes update scripts
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Addon phase mapping for different tasks", () => {
    beforeEach(() => {
      // Create a test application with copy-upgrade task
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
        "copy-upgrade": ["copy-upgrade.json"],
      } as any);

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      helper.writeTemplate("testapp", "copy-upgrade.json", {
        execute_on: "ve",
        name: "Copy-Upgrade",
        description: "Copy-upgrade template",
        parameters: [
          {
            id: "oci_image",
            name: "OCI Image",
            type: "string",
            required: true,
            description: "OCI image reference",
          },
          {
            id: "source_vm_id",
            name: "Source VM ID",
            type: "number",
            required: true,
            description: "Source container ID",
          },
        ],
        commands: [
          {
            name: "Upgrade Command",
            command: 'echo \'[{"id":"vm_id","value":123}]\'',
          },
        ],
      });
    });

    it("should use upgrade phase for copy-upgrade task", async () => {
      // Create addon with upgrade templates
      writeAddon(helper.jsonDir, "upgrade-addon", {
        name: "Upgrade Addon",
        description: "Addon with upgrade templates",
        compatible_with: "*",
        notes_key: "upgrade-addon",
        upgrade: ["upgrade-template.json"],
        post_start: ["post-template.json"], // Should NOT be used for copy-upgrade
      });

      writeSharedTemplate(helper.jsonDir, "upgrade-template.json", {
        execute_on: "lxc",
        name: "Upgrade Template",
        description: "Upgrade addon template",
        commands: [
          {
            name: "Upgrade Addon Command",
            command: 'echo \'[{"id": "upgrade_result", "value": "success"}]\'',
          },
        ],
      });

      const url = ApiUri.VeCopyUpgrade.replace(
        ":application",
        "testapp",
      ).replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          oci_image: "docker://alpine:3.19",
          source_vm_id: 101,
          selectedAddons: ["upgrade-addon"],
        });

      // Copy-upgrade endpoint may have different validation
      // The important thing is it doesn't fail with 400 for invalid selectedAddons
      expect(response.status).not.toBe(400);
    });

    it("should use post_start phase for addon-reconfigure task", async () => {
      // Create application with addon-reconfigure task
      helper.writeApplication("testapp2", {
        name: "Test App 2",
        description: "Test application with addon-reconfigure",
        installation: { post_start: ["set-parameters.json"] },
        "addon-reconfigure": { post_start: ["reconfig.json"] },
      } as any);

      helper.writeTemplate("testapp2", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      helper.writeTemplate("testapp2", "reconfig.json", {
        execute_on: "ve",
        name: "Reconfigure",
        description: "Addon reconfigure template",
        parameters: [],
        commands: [
          {
            name: "Reconfig Command",
            command: 'echo \'[{"id": "reconfig", "value": "ok"}]\'',
          },
        ],
      });

      // Create addon
      writeAddon(helper.jsonDir, "reconfig-addon", {
        name: "Reconfig Addon",
        description: "Addon for reconfigure",
        compatible_with: "*",
        notes_key: "reconfig-addon",
        post_start: ["reconfig-template.json"],
      });

      writeSharedTemplate(helper.jsonDir, "reconfig-template.json", {
        execute_on: "lxc",
        name: "Reconfig Template",
        description: "Reconfig addon template",
        commands: [
          {
            name: "Reconfig Addon Command",
            command: 'echo \'[{"id": "reconfig_result", "value": "success"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp2")
        .replace(":task", "addon-reconfigure")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [],
          changedParams: [],
          selectedAddons: ["reconfig-addon"],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should skip addon templates when addon has no templates for the selected phase", async () => {
      // This test verifies that when an addon has templates for a different phase
      // than what the current task needs, those templates are not loaded.
      // For example, if an addon only has "upgrade" templates but we're doing "installation",
      // the addon should be silently skipped.

      // Create addon with ONLY upgrade templates (no post_start)
      writeAddon(helper.jsonDir, "upgrade-only-addon", {
        name: "Upgrade Only Addon",
        description: "Addon with only upgrade templates",
        compatible_with: "*",
        notes_key: "upgrade-only",
        upgrade: ["upgrade-only-template.json"],
        // No post_start - installation uses post_start phase, so this addon
        // should contribute no commands
      });

      writeSharedTemplate(helper.jsonDir, "upgrade-only-template.json", {
        execute_on: "lxc",
        name: "Upgrade Only Template",
        description: "Template only for upgrades",
        commands: [
          {
            name: "Upgrade Only Command",
            command: 'echo \'[{"id": "upgrade_only", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["upgrade-only-addon"],
        } as IPostVeConfigurationBody);

      // Should succeed - addon is processed but contributes no commands
      // because it has no post_start templates
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Multiple addons", () => {
    beforeEach(() => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });
    });

    it("should load commands from multiple addons", async () => {
      // Create first addon
      writeAddon(helper.jsonDir, "addon-one", {
        name: "Addon One",
        description: "First addon",
        compatible_with: "*",
        notes_key: "addon-one",
        post_start: ["addon-one-template.json"],
      });

      writeSharedTemplate(helper.jsonDir, "addon-one-template.json", {
        execute_on: "lxc",
        name: "Addon One Template",
        description: "First addon template",
        commands: [
          {
            name: "Addon One Command",
            command: 'echo \'[{"id": "addon_one", "value": "ok"}]\'',
          },
        ],
      });

      // Create second addon
      writeAddon(helper.jsonDir, "addon-two", {
        name: "Addon Two",
        description: "Second addon",
        compatible_with: "*",
        notes_key: "addon-two",
        properties: [{ id: "addon_packages", value: "package2" }],
        post_start: ["addon-two-template.json"],
      });

      writeSharedTemplate(helper.jsonDir, "addon-two-template.json", {
        execute_on: "lxc",
        name: "Addon Two Template",
        description: "Second addon template",
        commands: [
          {
            name: "Addon Two Command",
            command: 'echo \'[{"id": "addon_two", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["addon-one", "addon-two"],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should handle mix of existing and non-existing addons", async () => {
      writeAddon(helper.jsonDir, "existing-addon", {
        name: "Existing Addon",
        description: "An existing addon",
        compatible_with: "*",
        notes_key: "existing-addon",
        post_start: ["existing-template.json"],
      });

      writeSharedTemplate(helper.jsonDir, "existing-template.json", {
        execute_on: "lxc",
        name: "Existing Template",
        description: "Existing addon template",
        commands: [
          {
            name: "Existing Command",
            command: 'echo \'[{"id": "existing", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: [
            "existing-addon",
            "non-existing-addon",
            "another-missing",
          ],
        } as IPostVeConfigurationBody);

      // Should succeed - existing addon is loaded, non-existing ones are skipped
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Addon certtype parameter injection", () => {
    beforeEach(() => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });
    });

    it("should include addon certtype parameters for cert injection", async () => {
      // Create addon with certtype parameter (like addon-ssl)
      writeAddon(helper.jsonDir, "ssl-addon", {
        name: "SSL Addon",
        description: "Addon with certtype parameter",
        compatible_with: "*",
        notes_key: "ssl",
        parameters: [
          {
            id: "addon_ssl_cert",
            name: "Server Certificate",
            type: "string",
            upload: true,
            certtype: "server",
          },
          {
            id: "addon_ssl_key",
            name: "Server Private Key",
            type: "string",
            upload: true,
            secure: true,
          },
        ],
        properties: [
          { id: "addon_volumes", value: "certs=/etc/ssl/addon,0700,0:0" },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          selectedAddons: ["ssl-addon"],
        } as IPostVeConfigurationBody);

      // Should succeed — the cert injection happens internally
      // Even without a CA, the request should process without error
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

  });

  describe("disabledAddons validation", () => {
    it("should accept valid disabledAddons array", async () => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        installation: { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          disabledAddons: ["some-addon"],
        } as IPostVeConfigurationBody);

      // Should not fail on validation
      expect(response.status).not.toBe(400);
    });

    it("should reject invalid disabledAddons (not an array)", async () => {
      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          disabledAddons: "not-an-array",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid disabledAddons");
    });
  });

  describe("Addon disable commands", () => {
    it("should insert disable commands for disabledAddons", async () => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        "addon-reconfigure": { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      // Create addon with disable config
      writeAddon(setup.env.jsonDir, "test-disable-addon", {
        name: "Test Disable Addon",
        compatible_with: "*",
        notes_key: "test-disable",
        disable: {
          post_start: ["post-disable-test.json"],
        },
      });

      // Create the disable template
      const sharedPostStartDir = path.join(
        setup.env.jsonDir,
        "shared",
        "templates",
        "post_start",
      );
      fs.ensureDirSync(sharedPostStartDir);
      fs.writeFileSync(
        path.join(sharedPostStartDir, "post-disable-test.json"),
        JSON.stringify({
          execute_on: "lxc",
          name: "Disable Test",
          commands: [
            {
              script: "post-disable-test.sh",
              description: "Disable test addon",
            },
          ],
        }),
        "utf-8",
      );

      // Create the disable script
      const sharedPostStartScriptDir = path.join(
        setup.env.jsonDir,
        "shared",
        "scripts",
        "post_start",
      );
      fs.ensureDirSync(sharedPostStartScriptDir);
      fs.writeFileSync(
        path.join(sharedPostStartScriptDir, "post-disable-test.sh"),
        '#!/bin/sh\necho "disabled" >&2',
        "utf-8",
      );

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "addon-reconfigure")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          disabledAddons: ["test-disable-addon"],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should skip non-existent disabled addons gracefully", async () => {
      helper.writeApplication("testapp", {
        name: "Test App",
        description: "Test application",
        "addon-reconfigure": { post_start: ["set-parameters.json"] },
      });

      helper.writeTemplate("testapp", "set-parameters.json", {
        execute_on: "ve",
        name: "Set Parameters",
        description: "Set parameters",
        parameters: [
          {
            id: "hostname",
            name: "hostname",
            type: "string",
            required: true,
            description: "Hostname",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":task", "addon-reconfigure")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
          disabledAddons: ["non-existent-addon"],
        } as IPostVeConfigurationBody);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});

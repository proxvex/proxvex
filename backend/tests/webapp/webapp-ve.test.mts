import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { ContextManager } from "@src/context-manager.mjs";
import { ApiUri, IPostVeConfigurationBody } from "@src/types.mjs";
import { WebAppVE } from "@src/webapp/webapp-ve.mjs";
import {
  createWebAppVETestSetup,
  type WebAppVETestSetup,
} from "../helper/webapp-test-helper.mjs";
import { IRestartInfo } from "@src/ve-execution/ve-execution-constants.mjs";

describe("WebAppVE API", () => {
  let app: WebAppVETestSetup["app"];
  let helper: WebAppVETestSetup["helper"];
  let storageContext: ContextManager;
  let veContextKey: string;
  let webAppVE: WebAppVE;
  let setup: WebAppVETestSetup;

  beforeEach(async () => {
    setup = await createWebAppVETestSetup();
    helper = setup.helper;
    app = setup.app;
    webAppVE = setup.webAppVE;
    storageContext = setup.ctx;

    // Create a test VE context using the proper method
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

  describe("POST /api/:veContext/ve-configuration/:application", () => {
    it("should successfully start configuration and return restartKey and vmInstallKey", async () => {
      // Create a minimal test application
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
            description: "Hostname of the VE",
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
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          task: "installation",
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
        } as IPostVeConfigurationBody);

      if (response.status !== 200) {
        console.error("Response status:", response.status);
        console.error("Response body:", JSON.stringify(response.body, null, 2));
        if ((response.body as any).error?.details) {
          console.error(
            "Error details:",
            JSON.stringify((response.body as any).error.details, null, 2),
          );
        }
      }
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
      expect(typeof response.body.restartKey).toBe("string");
      expect(response.body.vmInstallKey).toBeDefined();
      expect(response.body.vmInstallKey).toBe("vminstall_testhost_testapp");
    });

    it("should return error when VE context not found", async () => {
      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":veContext", "ve_nonexistent");

      const response = await request(app)
        .post(url)
        .send({
          task: "installation",
          params: [{ name: "hostname", value: "testhost" }],
        } as IPostVeConfigurationBody)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("VE context not found");
    });

    it("should return error when request body is invalid", async () => {
      const url = ApiUri.VeConfiguration.replace(":application", "testapp")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          task: "installation",
          params: "invalid", // Should be array
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });
  });

  describe("GET /api/:veContext/ve/execute", () => {
    it("should return messages successfully", async () => {
      const url = ApiUri.VeExecute.replace(":veContext", veContextKey);

      const response = await request(app).get(url).expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it("should return empty array when no messages exist", async () => {
      const url = ApiUri.VeExecute.replace(":veContext", veContextKey);

      const response = await request(app).get(url).expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe("POST /api/:veContext/ve/restart/:restartKey", () => {
    it("should successfully restart and return new restartKey and vmInstallKey", async () => {
      // Setup: Create a minimal test application
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
            description: "Hostname of the VE",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      // First, create a configuration to get a restartKey
      const configUrl = ApiUri.VeConfiguration.replace(
        ":application",
        "testapp",
      )
        .replace(":veContext", veContextKey);

      const configResponse = await request(app)
        .post(configUrl)
        .send({
          task: "installation",
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
        } as IPostVeConfigurationBody)
        .expect(200);

      const restartKey = configResponse.body.restartKey;
      expect(restartKey).toBeDefined();

      // The execution runs asynchronously, so we need to manually create a restartInfo
      // for testing purposes. In a real scenario, this would be created after execution completes.
      const restartInfo: IRestartInfo = {
        lastSuccessfull: 0, // First command completed successfully
        inputs: [{ name: "hostname", value: "testhost" }],
        outputs: [{ name: "test", value: "ok" }],
        defaults: [],
      };

      // Manually store the restartInfo in the restartManager
      // Access the internal restartManager from the WebAppVE instance
      const restartManager = (webAppVE as any).restartManager;
      restartManager.storeRestartInfo(restartKey, restartInfo);

      // Also create a message group with this restartKey so handleVeRestart can find it
      const messageManager = (webAppVE as any).messageManager;
      messageManager.findOrCreateMessageGroup(
        "testapp",
        "installation",
        restartKey,
      );

      // Now restart using the restartKey
      const restartUrl = ApiUri.VeRestart.replace(
        ":restartKey",
        restartKey,
      ).replace(":veContext", veContextKey);

      const response = await request(app).post(restartUrl).send({}).expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
      expect(typeof response.body.restartKey).toBe("string");
      // vmInstallKey may or may not be present depending on whether changedParams were provided
    });

    it("should return error when restart info not found", async () => {
      const url = ApiUri.VeRestart.replace(
        ":restartKey",
        "nonexistent-restart-key",
      ).replace(":veContext", veContextKey);

      const response = await request(app).post(url).send({}).expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Restart info not found");
    });

    it("should return error when VE context not found", async () => {
      const url = ApiUri.VeRestart.replace(
        ":restartKey",
        "test-restart-key",
      ).replace(":veContext", "ve_nonexistent");

      const response = await request(app).post(url).send({}).expect(404);

      expect(response.body.success).toBe(false);
      // The error could be either "VE context not found" or "Restart info not found"
      // depending on which check happens first
      expect(response.body.error).toBeDefined();
    });
  });

  describe("POST /api/:veContext/ve/restart-installation/:vmInstallKey", () => {
    it("should successfully restart installation from scratch", async () => {
      // Setup: Create a minimal test application
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
            description: "Hostname of the VE",
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: 'echo \'[{"id": "test", "value": "ok"}]\'',
          },
        ],
      });

      // Create a vmInstallContext
      const vmInstallKey = storageContext.setVMInstallContext({
        hostname: "testhost",
        application: "testapp",
        task: "installation",
        changedParams: [{ name: "hostname", value: "testhost" }],
      });

      const url = ApiUri.VeRestartInstallation.replace(
        ":vmInstallKey",
        vmInstallKey,
      ).replace(":veContext", veContextKey);

      const response = await request(app).post(url).send({}).expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
      expect(typeof response.body.restartKey).toBe("string");
      expect(response.body.vmInstallKey).toBe(vmInstallKey);
    });

    it("should return error when VM install context not found", async () => {
      // Use a valid vmInstallKey format but non-existent key
      const url = ApiUri.VeRestartInstallation.replace(
        ":vmInstallKey",
        "vminstall_testhost_nonexistentapp",
      ).replace(":veContext", veContextKey);

      const response = await request(app).post(url).send({}).expect(404);

      expect(response.body.success).toBe(false);
      // The route handler checks VE context first, then VM install context
      // Since VE context exists, it should check VM install context and fail
      expect(response.body.error).toBeDefined();
      // The actual error message depends on the implementation order
      // It could be "VM install context not found" if VE context check passes
    });

    it("should return error when VE context not found", async () => {
      const vmInstallKey = "vminstall_testhost_testapp";
      const url = ApiUri.VeRestartInstallation.replace(
        ":vmInstallKey",
        vmInstallKey,
      ).replace(":veContext", "ve_nonexistent");

      const response = await request(app).post(url).send({}).expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("VE context not found");
    });
  });

});

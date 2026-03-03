import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH =
  "shared/templates/pre_start/157-conf-write-uploaded-certs.json";

describe.skipIf(!hostReachable)(
  "Template: 157-conf-write-uploaded-certs",
  () => {
    const config = loadTemplateTestConfig();
    const stateManager = new TestStateManager(config);
    const helper = new TemplateTestHelper(config);
    const vmId = "9921";
    const sharedVolPath = "/tmp/test-ssl-certs";
    const hostname = "tmpl-test-ssl-certs";

    // Self-signed test cert (minimal, for testing only)
    const testCertB64 = Buffer.from(
      "-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpHYU0ePMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnRl\nc3RDQTANICA3MDEwMTAxMDAwMFoYDzIwOTkxMjMxMjM1OTU5WjARMQ8wDQYDVQQD\nDAZ0ZXN0Q0EwXDANBgkqhkiG9w0BAQEFAANLADBIAkEA0Z3VS5JJcds3xf0GRDXK\naOuB0YkB3MnAeTkW7mxfNbCB3nO1M6DAdHmFOgBl86SBbFnqWPRC2KBNqQovsFt1\nrQIDAQABMA0GCSqGSIb3DQEBCwUAA0EAOaRUGy0KX1bO2MHI9Yp+gXwfD7AwT3JL\nf47jEM+a5L3ZFJ8MoMFDXy8Gpf9XiUG2Y5GN3TxUEeMg0fGH+YKSA==\n-----END CERTIFICATE-----\n",
    ).toString("base64");
    const testKeyB64 = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA0Z3VS5JJcds3xf0G\nRDXKaOuB0YkB3MnAeTkW7mxfNbCB3nO1M6DAdHmFOgBl86SBbFnqWPRC2KBNqQov\nsFt1rQIDAQABAkBpHw7eLsV+iNRMXUEPqBIBBm3SPHMl8qZKbFHBXGFl5+52r4v/\njZFjaDg1bGE5FuBa/cJtFEI6v7e1J1JXRV0hAiEA6KlUzS9bWpDLRFJiHw7F/m2A\nOv/vjZfN4fNPP3t7VeUCIQDl5FSn5ulsRg9JJyse+iJHkEA1QLMKHI3kflkLFfZ2\nqQIhAJ7h7Wy3EHAf6E0VFzBFNBb9ZoAXjhj8O6qJkLCiW7M1AiEAl7S7VnB1R5j/\nqNy7bN+fRv9k7YLfLh3e5kF6DpVKJvkCIQCl+lBs9j/yDlPbfGYg9YYVRPQVNCkF\nBf4+Cx/G8lqZ8A==\n-----END PRIVATE KEY-----\n",
    ).toString("base64");

    beforeAll(async () => {
      await stateManager.ensureContainerCreatedStopped(vmId, {
        osType: "alpine",
        hostname,
      });
      // Create volume directory
      await stateManager.execOnHost(
        `mkdir -p ${sharedVolPath}/volumes/${hostname}/certs`,
      );
    }, 120000);

    afterAll(async () => {
      await stateManager.execOnHost(`rm -rf ${sharedVolPath}`);
      await stateManager.cleanup(vmId);
    }, 30000);

    it("should write uploaded cert and key to volume", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          "ssl.cert": testCertB64,
          "ssl.key": testKeyB64,
          shared_volpath: sharedVolPath,
          hostname,
          uid: "0",
          gid: "0",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["uploaded_certs_written"]).toBe("true");

      // Verify files exist
      const certExists = await stateManager.execOnHost(
        `test -f ${sharedVolPath}/volumes/${hostname}/certs/fullchain.pem && echo "OK"`,
      );
      expect(certExists.stdout.trim()).toBe("OK");

      const keyExists = await stateManager.execOnHost(
        `test -f ${sharedVolPath}/volumes/${hostname}/certs/privkey.pem && echo "OK"`,
      );
      expect(keyExists.stdout.trim()).toBe("OK");
    });

    it("should skip when cert is NOT_DEFINED", async () => {
      // Clean up previous test files
      await stateManager.execOnHost(
        `rm -f ${sharedVolPath}/volumes/${hostname}/certs/fullchain.pem ${sharedVolPath}/volumes/${hostname}/certs/privkey.pem`,
      );

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          "ssl.cert": "NOT_DEFINED",
          "ssl.key": "NOT_DEFINED",
          shared_volpath: sharedVolPath,
          hostname,
          uid: "0",
          gid: "0",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["uploaded_certs_written"]).toBe("false");

      // Files should NOT exist
      const certExists = await stateManager.execOnHost(
        `test -f ${sharedVolPath}/volumes/${hostname}/certs/fullchain.pem && echo "EXISTS" || echo "NOT_FOUND"`,
      );
      expect(certExists.stdout.trim()).toBe("NOT_FOUND");
    });
  },
);

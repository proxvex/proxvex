import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { ContextManager } from "@src/context-manager.mjs";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppVETestSetup,
  type WebAppVETestSetup,
} from "../helper/webapp-test-helper.mjs";
import * as spawnUtils from "@src/spawn-utils.mjs";

// Mock spawnAsync
vi.mock("@src/spawn-utils.mjs", () => ({
  spawnAsync: vi.fn(),
}));

const mockSpawnAsync = vi.mocked(spawnUtils.spawnAsync);

describe("VE Logs API Integration", () => {
  let app: WebAppVETestSetup["app"];
  let storageContext: ContextManager;
  let veContextKey: string;
  let setup: WebAppVETestSetup;

  beforeEach(async () => {
    setup = await createWebAppVETestSetup();
    app = setup.app;
    storageContext = setup.ctx;

    // Create a test VE context
    veContextKey = "ve_testhost";
    storageContext.setVEContext({
      host: "testhost",
      port: 22,
      current: true,
    });

    vi.resetAllMocks();
  });

  /**
   * Helper to set up mocks for a successful console log request.
   * The call sequence is:
   * 1. checkContainerStatus (pct status)
   * 2. getHostnameForVm (grep hostname)
   * 3. getLogPathFromConfig (grep lxc.console.logfile)
   * 4. test -f for docker-compose path
   * 5. tail -n (actual log read)
   */
  function mockSuccessfulConsoleLogs(hostname: string, logContent: string) {
    mockSpawnAsync
      .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // checkContainerStatus
      .mockResolvedValueOnce({ stdout: hostname, stderr: "", exitCode: 0 }) // getHostnameForVm
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // getLogPathFromConfig (no configured path)
      .mockResolvedValueOnce({ stdout: "exists", stderr: "", exitCode: 0 }) // docker-compose path exists
      .mockResolvedValueOnce({ stdout: logContent, stderr: "", exitCode: 0 }); // tail logs
  }

  afterEach(async () => {
    await setup.cleanup();
  });

  describe("GET /api/:veContext/ve/logs/:vmId", () => {
    it("should return 400 for invalid VM ID", async () => {
      const url = ApiUri.VeLogs.replace(":vmId", "invalid").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid VM ID");
    });

    it("should return 400 for negative VM ID", async () => {
      const url = ApiUri.VeLogs.replace(":vmId", "-5").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid VM ID");
    });

    it("should return 404 for invalid VE context", async () => {
      const url = ApiUri.VeLogs.replace(":vmId", "100").replace(
        ":veContext",
        "invalid_context",
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("VE context not found");
    });

    it("should return console logs successfully", async () => {
      const logContent = "Test log line 1\nTest log line 2";
      mockSuccessfulConsoleLogs("testcontainer", logContent);

      const url = ApiUri.VeLogs.replace(":vmId", "100").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.vmId).toBe(100);
      expect(response.body.lines).toBe(100); // default
      expect(response.body.content).toBe(logContent);
    });

    it("should respect lines query parameter", async () => {
      mockSuccessfulConsoleLogs("testcontainer", "logs");

      const url =
        ApiUri.VeLogs.replace(":vmId", "100").replace(
          ":veContext",
          veContextKey,
        ) + "?lines=50";

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.lines).toBe(50);
    });

    it("should return error when container not found", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      });

      const url = ApiUri.VeLogs.replace(":vmId", "999").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Container 999 not found");
    });
  });

  describe("GET /api/:veContext/ve/logs/:vmId/docker", () => {
    it("should return 400 for invalid VM ID", async () => {
      const url = ApiUri.VeDockerLogs.replace(":vmId", "invalid").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid VM ID");
    });

    it("should return 404 for invalid VE context", async () => {
      const url = ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
        ":veContext",
        "invalid_context",
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    it("should return docker logs for all services", async () => {
      const dockerLogs = "db | Starting\nnextcloud | Starting";
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // pct status
        .mockResolvedValueOnce({ stdout: dockerLogs, stderr: "", exitCode: 0 }); // docker-compose logs

      const url = ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.vmId).toBe(100);
      expect(response.body.content).toBe(dockerLogs);
      expect(response.body).not.toHaveProperty("service");
    });

    it("should return docker logs for specific service", async () => {
      const serviceLogs = "2024-01-01 Service started";
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({
          stdout: serviceLogs,
          stderr: "",
          exitCode: 0,
        });

      const url =
        ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
          ":veContext",
          veContextKey,
        ) + "?service=nextcloud";

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.service).toBe("nextcloud");
      expect(response.body.content).toBe(serviceLogs);
    });

    it("should support both lines and service parameters", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 });

      const url =
        ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
          ":veContext",
          veContextKey,
        ) + "?service=db&lines=25";

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.service).toBe("db");
      expect(response.body.lines).toBe(25);
    });

    it("should return error when container not running", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "stopped",
        stderr: "",
        exitCode: 0,
      });

      const url = ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("is not running");
    });

    it("should reject invalid service names", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "running",
        stderr: "",
        exitCode: 0,
      });

      const url =
        ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
          ":veContext",
          veContextKey,
        ) + "?service=invalid%20service!";

      const response = await request(app).get(url);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Invalid service name");
    });
  });

  describe("Error handling", () => {
    it("should handle SSH connection errors gracefully", async () => {
      mockSpawnAsync.mockRejectedValueOnce(new Error("Connection refused"));

      const url = ApiUri.VeLogs.replace(":vmId", "100").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      // Should return 500 or handle gracefully
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should handle timeout errors", async () => {
      mockSpawnAsync.mockRejectedValueOnce(new Error("Command timed out"));

      const url = ApiUri.VeDockerLogs.replace(":vmId", "100").replace(
        ":veContext",
        veContextKey,
      );

      const response = await request(app).get(url);

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("Lines parameter validation", () => {
    it("should cap lines at maximum (10000)", async () => {
      mockSuccessfulConsoleLogs("testcontainer", "logs");

      const url =
        ApiUri.VeLogs.replace(":vmId", "100").replace(
          ":veContext",
          veContextKey,
        ) + "?lines=99999";

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.lines).toBe(10000); // MAX_LINES
    });

    it("should use default lines for invalid value", async () => {
      mockSuccessfulConsoleLogs("testcontainer", "logs");

      const url =
        ApiUri.VeLogs.replace(":vmId", "100").replace(
          ":veContext",
          veContextKey,
        ) + "?lines=-10";

      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.body.lines).toBe(100); // DEFAULT_LINES
    });
  });
});

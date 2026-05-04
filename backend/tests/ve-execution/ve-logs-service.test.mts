import { describe, it, expect, beforeEach, vi } from "vitest";
import { VeLogsService } from "@src/ve-execution/ve-logs-service.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import * as spawnUtils from "@src/spawn-utils.mjs";

// Mock spawnAsync
vi.mock("@src/spawn-utils.mjs", () => ({
  spawnAsync: vi.fn(),
}));

const mockSpawnAsync = vi.mocked(spawnUtils.spawnAsync);

describe("VeLogsService", () => {
  const mockVeContext: IVEContext = {
    host: "testhost",
    port: 22,
  } as IVEContext;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * Helper to set up mocks for a successful console log request.
   * The call sequence is:
   * 1. checkContainerStatus (pct status)
   * 2. getHostnameForVm (grep hostname)
   * 3. getLogPathFromConfig (grep lxc.console.logfile)
   * 4. test -f for configured path (optional, only if config returns path)
   * 5. test -f for docker-compose path (if hostname exists)
   * 6. test -f for oci-image path (fallback)
   * 7. tail -n (actual log read)
   */
  function mockSuccessfulConsoleLogs(
    options: {
      hostname?: string;
      logContent?: string;
      configuredPath?: string;
      useDockerComposePath?: boolean;
      useOciPath?: boolean;
    } = {},
  ) {
    const {
      hostname = "testhost",
      logContent = "log content",
      configuredPath = "",
      useDockerComposePath = true,
      useOciPath = false,
    } = options;

    // 1. checkContainerStatus - container is running
    mockSpawnAsync.mockResolvedValueOnce({
      stdout: "running",
      stderr: "",
      exitCode: 0,
    });
    // 2. getHostnameForVm
    mockSpawnAsync.mockResolvedValueOnce({
      stdout: hostname,
      stderr: "",
      exitCode: 0,
    });
    // 3. getLogPathFromConfig
    mockSpawnAsync.mockResolvedValueOnce({
      stdout: configuredPath,
      stderr: "",
      exitCode: configuredPath ? 0 : 1,
    });

    if (configuredPath) {
      // 4. test -f for configured path
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "exists",
        stderr: "",
        exitCode: 0,
      });
    } else if (useDockerComposePath && hostname) {
      // 5. test -f for docker-compose path
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "exists",
        stderr: "",
        exitCode: 0,
      });
    } else if (useOciPath) {
      // Skip docker-compose check if no hostname or not using it
      if (hostname) {
        mockSpawnAsync.mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          exitCode: 1,
        }); // docker-compose path not found
      }
      // 6. test -f for oci-image path
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "exists",
        stderr: "",
        exitCode: 0,
      });
    }

    // 7. tail -n to read logs
    mockSpawnAsync.mockResolvedValueOnce({
      stdout: logContent,
      stderr: "",
      exitCode: 0,
    });
  }

  describe("normalizeLines", () => {
    it("should use default lines when not specified", async () => {
      mockSuccessfulConsoleLogs({ logContent: "log content" });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100 });

      expect(result.lines).toBe(100); // DEFAULT_LINES
    });

    it("should cap lines at maximum", async () => {
      mockSuccessfulConsoleLogs({ logContent: "log content" });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100, lines: 50000 });

      expect(result.lines).toBe(10000); // MAX_LINES
    });

    it("should use specified lines when valid", async () => {
      mockSuccessfulConsoleLogs({ logContent: "log content" });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100, lines: 50 });

      expect(result.lines).toBe(50);
    });
  });

  describe("validateVmId", () => {
    it("should reject invalid VM ID (negative)", async () => {
      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: -1 });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid VM ID");
    });

    it("should reject invalid VM ID (zero)", async () => {
      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 0 });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid VM ID");
    });

    it("should reject invalid VM ID (non-integer)", async () => {
      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 1.5 });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid VM ID");
    });
  });

  describe("validateServiceName", () => {
    it("should reject service name with invalid characters", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "running",
        stderr: "",
        exitCode: 0,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({
        vmId: 100,
        service: "my service!",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid service name");
    });

    it("should accept valid service names", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // checkContainerStatus
        .mockResolvedValueOnce({
          stdout: "docker logs output",
          stderr: "",
          exitCode: 0,
        }); // docker logs

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({
        vmId: 100,
        service: "my-service_123",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("getConsoleLogs", () => {
    it("should return error when container status check fails", async () => {
      // Mock pct status to fail - container doesn't exist
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "",
        stderr: "Configuration file not found",
        exitCode: 2,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Container 999 not found");

      // Verify only one call was made (checkContainerStatus) - should have returned early
      expect(mockSpawnAsync).toHaveBeenCalledTimes(1);
    });

    it("should return error when no log file found", async () => {
      // Container exists but no log file can be found
      mockSpawnAsync
        .mockResolvedValueOnce({
          stdout: "status: running",
          stderr: "",
          exitCode: 0,
        }) // pct status succeeds
        .mockResolvedValueOnce({ stdout: "myhost", stderr: "", exitCode: 0 }) // hostname lookup succeeds
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // getLogPathFromConfig fails
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // docker-compose path not found
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }); // oci-image path not found

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No log file found");
    });

    it("should return error when hostname is null and no log file found", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // container exists
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // hostname fails (returns null)
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // getLogPathFromConfig fails
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }); // oci-image path not found (no docker-compose check since hostname is null)

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No log file found");
    });

    it("should return console logs successfully with docker-compose path", async () => {
      const logContent = "Line 1\nLine 2\nLine 3";
      mockSuccessfulConsoleLogs({
        hostname: "myhost",
        logContent,
        useDockerComposePath: true,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100, lines: 50 });

      expect(result.success).toBe(true);
      expect(result.vmId).toBe(100);
      expect(result.lines).toBe(50);
      expect(result.content).toBe(logContent);
    });

    it("should return console logs using configured path", async () => {
      const logContent = "configured log content";
      mockSuccessfulConsoleLogs({
        hostname: "myhost",
        logContent,
        configuredPath: "/custom/path/to/log.log",
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100 });

      expect(result.success).toBe(true);
      expect(result.content).toBe(logContent);
    });

    it("should construct correct docker-compose log file path", async () => {
      mockSuccessfulConsoleLogs({
        hostname: "testcontainer",
        logContent: "logs",
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      await service.getConsoleLogs({ vmId: 105, lines: 100 });

      // Check that the tail command was called with correct path
      const lastCall =
        mockSpawnAsync.mock.calls[mockSpawnAsync.mock.calls.length - 1];
      expect(lastCall[1]).toContain("-c");
      const command = lastCall[1][1];
      expect(command).toContain("/var/log/lxc/testcontainer-105.log");
      expect(command).toContain("tail -n 100");
    });

    it("should try oci-image path when hostname is null", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // container exists
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // hostname returns null
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // getLogPathFromConfig fails
        .mockResolvedValueOnce({ stdout: "exists", stderr: "", exitCode: 0 }) // oci-image path found
        .mockResolvedValueOnce({ stdout: "oci logs", stderr: "", exitCode: 0 }); // tail logs

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100 });

      expect(result.success).toBe(true);
      expect(result.content).toBe("oci logs");
    });
  });

  describe("getDockerLogs", () => {
    it("should return error when container not found", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 1,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({ vmId: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Container 999 not found");
    });

    it("should return error when container not running", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "stopped",
        stderr: "",
        exitCode: 0,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({ vmId: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("is not running");
    });

    it("should return docker logs for specific service", async () => {
      const dockerLogs =
        "2024-01-01 Service started\n2024-01-01 Service running";
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: dockerLogs, stderr: "", exitCode: 0 });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({
        vmId: 100,
        service: "nextcloud",
        lines: 50,
      });

      expect(result.success).toBe(true);
      expect(result.service).toBe("nextcloud");
      expect(result.content).toBe(dockerLogs);
    });

    it("should return docker-compose logs when no service specified", async () => {
      const composeLogs = "db | Starting\nnextcloud | Starting";
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({
          stdout: composeLogs,
          stderr: "",
          exitCode: 0,
        });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({ vmId: 100 });

      expect(result.success).toBe(true);
      expect(result.service).toBeUndefined();
      expect(result.content).toBe(composeLogs);
    });

    it("should use lxc-attach to execute docker commands", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      await service.getDockerLogs({ vmId: 105, service: "myservice" });

      const lastCall = mockSpawnAsync.mock.calls[1];
      const command = lastCall[1][1];
      expect(command).toContain("lxc-attach -n 105");
      // Single-service logs go through docker-compose so the service name
      // resolves to the actual container (whose internal name is
      // "<project>-<service>-1"). Plain `docker logs <service>` would fail
      // with "No such container".
      expect(command).toMatch(/docker(-| )compose logs/);
      expect(command).toContain("myservice");
    });
  });

  describe("checkContainerStatus", () => {
    it("should detect running container", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "status: running",
        stderr: "",
        exitCode: 0,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const status = await service.checkContainerStatus(100);

      expect(status.exists).toBe(true);
      expect(status.running).toBe(true);
    });

    it("should detect stopped container", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "status: stopped",
        stderr: "",
        exitCode: 0,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const status = await service.checkContainerStatus(100);

      expect(status.exists).toBe(true);
      expect(status.running).toBe(false);
    });

    it("should detect non-existent container", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const status = await service.checkContainerStatus(999);

      expect(status.exists).toBe(false);
      expect(status.running).toBe(false);
    });
  });

  describe("SSH mode", () => {
    it("should build correct SSH arguments in production mode", async () => {
      // For production mode, we need to mock all calls
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // checkContainerStatus
        .mockResolvedValueOnce({ stdout: "myhost", stderr: "", exitCode: 0 }) // getHostnameForVm
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // getLogPathFromConfig (no configured path)
        .mockResolvedValueOnce({ stdout: "exists", stderr: "", exitCode: 0 }) // docker-compose path exists
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 }); // tail logs

      const service = new VeLogsService(
        mockVeContext,
        ExecutionMode.PRODUCTION,
      );
      await service.getConsoleLogs({ vmId: 100 });

      // In production mode, should use ssh command
      const firstCall = mockSpawnAsync.mock.calls[0];
      expect(firstCall[0]).toBe("ssh");
      expect(firstCall[1]).toContain("root@testhost");
      expect(firstCall[1]).toContain("-p");
      expect(firstCall[1]).toContain("22");
    });

    it("should prepend root@ to host if not specified", async () => {
      const veContextWithoutUser: IVEContext = {
        host: "myserver",
        port: 2222,
      } as IVEContext;

      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 1,
      });

      const service = new VeLogsService(
        veContextWithoutUser,
        ExecutionMode.PRODUCTION,
      );
      await service.getConsoleLogs({ vmId: 100 });

      const firstCall = mockSpawnAsync.mock.calls[0];
      expect(firstCall[1]).toContain("root@myserver");
      expect(firstCall[1]).toContain("2222");
    });
  });

  describe("getLogs (auto-detect)", () => {
    it("should return error for invalid VM ID", async () => {
      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: -1 });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid VM ID");
    });

    it("should return error when container not found", async () => {
      mockSpawnAsync.mockResolvedValueOnce({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Container 999 not found");
    });

    it("should return docker-compose logs when /opt/docker-compose exists", async () => {
      const dockerLogs = "db | Starting\nnextcloud | Ready";
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // checkContainerStatus
        .mockResolvedValueOnce({ stdout: dockerLogs, stderr: "", exitCode: 0 }); // combined script

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: 100 });

      expect(result.success).toBe(true);
      expect(result.content).toBe(dockerLogs);
      expect(result.vmId).toBe(100);
    });

    it("should return console logs when /opt/docker-compose does not exist", async () => {
      const consoleLogs = "Alpine Linux starting...";
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // checkContainerStatus
        .mockResolvedValueOnce({ stdout: consoleLogs, stderr: "", exitCode: 0 }); // combined script

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: 100 });

      expect(result.success).toBe(true);
      expect(result.content).toBe(consoleLogs);
    });

    it("should return error when script outputs Error:", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 }) // checkContainerStatus
        .mockResolvedValueOnce({ stdout: "Error: No log file found for container 100", stderr: "", exitCode: 0 }); // combined script

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No log file found");
    });

    it("should respect lines parameter", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: 100, lines: 50 });

      expect(result.lines).toBe(50);
      // Verify the script contains the correct lines count
      const scriptCall = mockSpawnAsync.mock.calls[1]!;
      const command = scriptCall[1][1];
      expect(command).toContain("--tail 50");
      expect(command).toContain("tail -n 50");
    });

    it("should not include service field in response", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getLogs({ vmId: 100 });

      expect(result).not.toHaveProperty("service");
    });
  });

  describe("response structure", () => {
    it("should not include service field for console logs", async () => {
      mockSuccessfulConsoleLogs({ logContent: "logs" });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getConsoleLogs({ vmId: 100 });

      expect(result).not.toHaveProperty("service");
    });

    it("should include service field for docker logs when service specified", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({
        vmId: 100,
        service: "myservice",
      });

      expect(result.service).toBe("myservice");
    });

    it("should not include service field for docker logs when no service specified", async () => {
      mockSpawnAsync
        .mockResolvedValueOnce({ stdout: "running", stderr: "", exitCode: 0 })
        .mockResolvedValueOnce({ stdout: "logs", stderr: "", exitCode: 0 });

      const service = new VeLogsService(mockVeContext, ExecutionMode.TEST);
      const result = await service.getDockerLogs({ vmId: 100 });

      expect(result).not.toHaveProperty("service");
    });
  });
});

import { IVEContext } from "../backend-types.mjs";
import { spawnAsync } from "../spawn-utils.mjs";
import {
  ExecutionMode,
  determineExecutionMode,
} from "./ve-execution-constants.mjs";

/**
 * Response interface for log requests.
 */
export interface ILogResponse {
  success: boolean;
  vmId: number;
  service?: string;
  lines: number;
  content: string;
  error?: string;
}

/**
 * Options for fetching logs.
 */
export interface ILogOptions {
  vmId: number;
  lines?: number;
  service?: string;
}

/**
 * Service for fetching logs from LXC containers and Docker services.
 */
export class VeLogsService {
  private static readonly DEFAULT_LINES = 100;
  private static readonly MAX_LINES = 10000;
  private static readonly TIMEOUT_MS = 30000;

  constructor(
    private veContext: IVEContext,
    private executionMode?: ExecutionMode,
  ) {
    if (executionMode === undefined) {
      this.executionMode = determineExecutionMode();
    }
  }

  /**
   * Validates and normalizes the lines parameter.
   */
  private normalizeLines(lines?: number): number {
    if (lines === undefined || lines === null) {
      return VeLogsService.DEFAULT_LINES;
    }
    const n = Math.floor(lines);
    if (n < 1) return VeLogsService.DEFAULT_LINES;
    if (n > VeLogsService.MAX_LINES) return VeLogsService.MAX_LINES;
    return n;
  }

  /**
   * Validates the VM ID.
   */
  private validateVmId(vmId: number): boolean {
    return Number.isInteger(vmId) && vmId > 0;
  }

  /**
   * Validates a Docker service name.
   * Allows alphanumeric, hyphens, underscores.
   */
  private validateServiceName(service: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(service);
  }

  /**
   * Builds SSH arguments for connecting to the VE host.
   */
  private buildSshArgs(): string[] {
    if (this.executionMode === ExecutionMode.TEST) {
      return [];
    }

    let host = this.veContext.host;
    if (typeof host === "string" && !host.includes("@")) {
      host = `root@${host}`;
    }
    const port = this.veContext.port || 22;

    return [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "BatchMode=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=60",
      "-o",
      "ControlPath=/tmp/lxc-manager-ssh-%r@%h:%p",
      "-T",
      "-q",
      "-p",
      String(port),
      `${host}`,
    ];
  }

  /**
   * Executes a command on the VE host.
   */
  private async executeOnHost(
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.executionMode === ExecutionMode.TEST) {
      // In test mode, execute locally via sh
      return spawnAsync("sh", ["-c", command], {
        timeout: VeLogsService.TIMEOUT_MS,
      });
    }

    const sshArgs = this.buildSshArgs();
    sshArgs.push(command);

    return spawnAsync("ssh", sshArgs, {
      timeout: VeLogsService.TIMEOUT_MS,
    });
  }

  /**
   * Gets the hostname for a VM ID by reading the LXC config.
   */
  async getHostnameForVm(vmId: number): Promise<string | null> {
    const command = `grep -E '^hostname:' /etc/pve/lxc/${vmId}.conf 2>/dev/null | awk '{print $2}' | head -1`;
    const result = await this.executeOnHost(command);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    return result.stdout.trim();
  }


  /**
   * Gets the configured log path from lxc.console.logfile in the LXC config.
   */
  async getLogPathFromConfig(vmId: number): Promise<string | null> {
    const command = `grep -E '^lxc\\.console\\.logfile:' /etc/pve/lxc/${vmId}.conf 2>/dev/null | awk '{print $2}' | head -1`;
    const result = await this.executeOnHost(command);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    return result.stdout.trim();
  }

  /**
   * Finds the console log file for a container.
   * Tries multiple possible locations:
   * 1. Path from lxc.console.logfile config
   * 2. /var/log/lxc/{hostname}-{vmid}.log (standard format)
   * 3. /var/log/lxc/container-{vmid}.log (legacy fallback)
   */
  async findLogFile(
    vmId: number,
    hostname: string | null,
  ): Promise<string | null> {
    // First try the configured path
    const configuredPath = await this.getLogPathFromConfig(vmId);
    if (configuredPath) {
      const checkCmd = `test -f "${configuredPath}" && echo "exists"`;
      const checkResult = await this.executeOnHost(checkCmd);
      if (checkResult.stdout.trim() === "exists") {
        return configuredPath;
      }
    }

    // Try docker-compose format: /var/log/lxc/{hostname}-{vmid}.log
    if (hostname) {
      const dockerComposePath = `/var/log/lxc/${hostname}-${vmId}.log`;
      const checkCmd1 = `test -f "${dockerComposePath}" && echo "exists"`;
      const checkResult1 = await this.executeOnHost(checkCmd1);
      if (checkResult1.stdout.trim() === "exists") {
        return dockerComposePath;
      }
    }

    // Legacy fallback: /var/log/lxc/container-{vmid}.log
    const ociPath = `/var/log/lxc/container-${vmId}.log`;
    const checkCmd2 = `test -f "${ociPath}" && echo "exists"`;
    const checkResult2 = await this.executeOnHost(checkCmd2);
    if (checkResult2.stdout.trim() === "exists") {
      return ociPath;
    }

    return null;
  }

  /**
   * Checks if a container exists and is running.
   */
  async checkContainerStatus(
    vmId: number,
  ): Promise<{ exists: boolean; running: boolean }> {
    const command = `pct status ${vmId} 2>/dev/null`;
    const result = await this.executeOnHost(command);

    if (result.exitCode !== 0) {
      return { exists: false, running: false };
    }

    const status = result.stdout.trim().toLowerCase();
    return {
      exists: true,
      running: status.includes("running"),
    };
  }

  /**
   * Fetches LXC console logs.
   * Supports multiple log file formats:
   * - /var/log/lxc/{hostname}-{vmid}.log (docker-compose)
   * - /var/log/lxc/container-{vmid}.log (oci-image)
   * - Custom path from lxc.console.logpath config
   */
  async getConsoleLogs(options: ILogOptions): Promise<ILogResponse> {
    const { vmId } = options;
    const lines = this.normalizeLines(options.lines);

    // Validate VM ID
    if (!this.validateVmId(vmId)) {
      return {
        success: false,
        vmId,
        lines,
        content: "",
        error: "Invalid VM ID",
      };
    }

    // Check if container exists
    const status = await this.checkContainerStatus(vmId);
    if (!status.exists) {
      return {
        success: false,
        vmId,
        lines,
        content: "",
        error: `Container ${vmId} not found`,
      };
    }

    // Get hostname (optional, used for log file path detection)
    const hostname = await this.getHostnameForVm(vmId);

    // Find the log file (tries multiple locations)
    const logPath = await this.findLogFile(vmId, hostname);
    if (!logPath) {
      return {
        success: false,
        vmId,
        lines,
        content: "",
        error: `No log file found for container ${vmId}. Tried: lxc.console.logfile config, /var/log/lxc/${hostname || "?"}-${vmId}.log, /var/log/lxc/container-${vmId}.log`,
      };
    }

    // Read log file
    const command = `tail -n ${lines} "${logPath}" 2>/dev/null`;
    const result = await this.executeOnHost(command);

    if (result.exitCode !== 0) {
      return {
        success: false,
        vmId,
        lines,
        content: result.stderr || result.stdout,
        error: `Failed to read console logs from ${logPath}: exit code ${result.exitCode}`,
      };
    }

    return {
      success: true,
      vmId,
      lines,
      content: result.stdout,
    };
  }

  /**
   * Creates a Docker log response object, only including service if defined.
   */
  private createDockerLogResponse(
    success: boolean,
    vmId: number,
    lines: number,
    content: string,
    service?: string,
    error?: string,
  ): ILogResponse {
    const response: ILogResponse = {
      success,
      vmId,
      lines,
      content,
    };
    if (service !== undefined) {
      response.service = service;
    }
    if (error !== undefined) {
      response.error = error;
    }
    return response;
  }

  /**
   * Fetches Docker logs from inside an LXC container.
   * If service is specified, gets logs for that service.
   * Otherwise, gets docker-compose logs for all services.
   */
  async getDockerLogs(options: ILogOptions): Promise<ILogResponse> {
    const { vmId, service } = options;
    const lines = this.normalizeLines(options.lines);

    // Validate VM ID
    if (!this.validateVmId(vmId)) {
      return this.createDockerLogResponse(
        false,
        vmId,
        lines,
        "",
        service,
        "Invalid VM ID",
      );
    }

    // Validate service name if provided
    if (service && !this.validateServiceName(service)) {
      return this.createDockerLogResponse(
        false,
        vmId,
        lines,
        "",
        service,
        "Invalid service name. Only alphanumeric, hyphens, and underscores allowed.",
      );
    }

    // Check if container exists and is running
    const status = await this.checkContainerStatus(vmId);
    if (!status.exists) {
      return this.createDockerLogResponse(
        false,
        vmId,
        lines,
        "",
        service,
        `Container ${vmId} not found`,
      );
    }

    if (!status.running) {
      return this.createDockerLogResponse(
        false,
        vmId,
        lines,
        "",
        service,
        `Container ${vmId} is not running`,
      );
    }

    // Build docker logs command
    // Try docker compose first (plugin), fallback to docker-compose (standalone)
    let dockerCmd: string;
    if (service) {
      // Single service logs
      dockerCmd = `docker logs --tail ${lines} ${service} 2>&1`;
    } else {
      // All services via docker-compose
      // Find compose directory and run docker-compose logs
      dockerCmd = `
        COMPOSE_DIR=$(find /opt/docker-compose -maxdepth 1 -type d ! -name docker-compose 2>/dev/null | head -1)
        if [ -n "$COMPOSE_DIR" ] && [ -f "$COMPOSE_DIR/docker-compose.yaml" ]; then
          cd "$COMPOSE_DIR"
          if command -v docker-compose >/dev/null 2>&1; then
            docker-compose logs --tail ${lines} 2>&1
          elif docker compose version >/dev/null 2>&1; then
            docker compose logs --tail ${lines} 2>&1
          else
            echo "Error: Neither docker-compose nor docker compose plugin found"
          fi
        else
          echo "Error: No docker-compose.yaml found in /opt/docker-compose/*/"
        fi
      `;
    }

    // Execute via lxc-attach
    const lxcAttachCmd = `lxc-attach -n ${vmId} -- sh -c '${dockerCmd.replace(/'/g, "'\"'\"'")}'`;

    const result = await this.executeOnHost(lxcAttachCmd);

    // Docker logs command returns exit code 0 even with some warnings
    // Check for actual error patterns
    const hasError =
      result.stdout.includes("Error:") && result.stdout.split("\n").length <= 2;

    if (result.exitCode !== 0 || hasError) {
      return this.createDockerLogResponse(
        false,
        vmId,
        lines,
        result.stdout || result.stderr,
        service,
        `Failed to get Docker logs: ${result.stderr || result.stdout}`,
      );
    }

    return this.createDockerLogResponse(
      true,
      vmId,
      lines,
      result.stdout,
      service,
    );
  }

  /**
   * Auto-detects container type and fetches the appropriate logs.
   * If /opt/docker-compose exists inside the container, fetches docker-compose logs.
   * Otherwise, fetches console logs from the LXC log file.
   * Combines detection and log fetching into a single SSH command.
   */
  async getLogs(options: ILogOptions): Promise<ILogResponse> {
    const { vmId } = options;
    const lines = this.normalizeLines(options.lines);

    if (!this.validateVmId(vmId)) {
      return { success: false, vmId, lines, content: "", error: "Invalid VM ID" };
    }

    const status = await this.checkContainerStatus(vmId);
    if (!status.exists) {
      return { success: false, vmId, lines, content: "", error: `Container ${vmId} not found` };
    }

    // Single script that auto-detects and fetches the right logs
    const script = `
if lxc-attach -n ${vmId} -- test -d /opt/docker-compose 2>/dev/null; then
  lxc-attach -n ${vmId} -- sh -c '
    COMPOSE_DIR=$(find /opt/docker-compose -maxdepth 1 -type d ! -name docker-compose 2>/dev/null | head -1)
    if [ -n "$COMPOSE_DIR" ] && [ -f "$COMPOSE_DIR/docker-compose.yaml" ]; then
      cd "$COMPOSE_DIR"
      if command -v docker-compose >/dev/null 2>&1; then
        docker-compose logs --tail ${lines} 2>&1
      elif docker compose version >/dev/null 2>&1; then
        docker compose logs --tail ${lines} 2>&1
      else
        echo "Error: Neither docker-compose nor docker compose plugin found"
      fi
    else
      echo "Error: No docker-compose.yaml found in /opt/docker-compose/*/"
    fi
  '
else
  HOSTNAME=$(grep -E "^hostname:" /etc/pve/lxc/${vmId}.conf 2>/dev/null | awk "{print \\$2}" | head -1)
  LOG_PATH=""
  CONFIGURED=$(grep -E "^lxc\\.console\\.logfile:" /etc/pve/lxc/${vmId}.conf 2>/dev/null | awk "{print \\$2}" | head -1)
  if [ -n "$CONFIGURED" ] && [ -f "$CONFIGURED" ]; then
    LOG_PATH="$CONFIGURED"
  elif [ -n "$HOSTNAME" ] && [ -f "/var/log/lxc/$HOSTNAME-${vmId}.log" ]; then
    LOG_PATH="/var/log/lxc/$HOSTNAME-${vmId}.log"
  elif [ -f "/var/log/lxc/container-${vmId}.log" ]; then
    LOG_PATH="/var/log/lxc/container-${vmId}.log"
  fi
  if [ -n "$LOG_PATH" ]; then
    tail -n ${lines} "$LOG_PATH" 2>/dev/null
  else
    echo "Error: No log file found for container ${vmId}"
  fi
fi`.trim();

    const result = await this.executeOnHost(script);

    const hasError =
      result.exitCode !== 0 ||
      (result.stdout.startsWith("Error:") && result.stdout.split("\n").length <= 2);

    if (hasError) {
      return {
        success: false,
        vmId,
        lines,
        content: result.stdout || result.stderr,
        error: result.stderr || result.stdout || "Failed to get logs",
      };
    }

    return { success: true, vmId, lines, content: result.stdout };
  }
}

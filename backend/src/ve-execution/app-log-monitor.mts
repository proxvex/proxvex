import { ChildProcess, spawn } from "node:child_process";
import { IVEContext } from "../backend-types.mjs";
import { createLogger } from "../logger/index.mjs";
import {
  ExecutionMode,
  determineExecutionMode,
} from "./ve-execution-constants.mjs";
import { VeLogsService } from "./ve-logs-service.mjs";

const logger = createLogger("applog");

const RESPAWN_BACKOFF_MS = 3000;
const SIGKILL_GRACE_MS = 2000;

export type AppLogChannel = "lxc" | "docker";
export type AppLogSink = (
  channel: AppLogChannel,
  vmId: number,
  line: string,
) => void;

interface MonitorState {
  /** Set once stop() ran — supervisors must not respawn after this. */
  stopped: boolean;
  /** vmIds already being followed (idempotency / multi-VM upgrade path). */
  vmIds: Set<number>;
  /** Live child processes (ssh / sh) so stop() can kill them. */
  children: Set<ChildProcess>;
}

/**
 * Tails application logs (LXC console log + docker-compose service logs) of a
 * just-started container into the diagnosis bundle, live and line-by-line,
 * parallel to the running task.
 *
 * Wiring: started from the message-listener in WebAppVeExecutionSetup when the
 * `PROXVEX_PCT_START_EXECUTED vmid=<n>` marker (emitted by lxc-start.sh on
 * stderr) is seen; stopped right before the debug bundle is finalised, and on
 * process shutdown via stopAll().
 *
 * Best-effort: every failure is logged at debug and never propagated — log
 * capture must not influence the task.
 */
export class AppLogMonitor {
  private monitors = new Map<string, MonitorState>();

  /**
   * Begin following the logs of `vmId` for `restartKey`. Idempotent per
   * (restartKey, vmId): a repeated marker for the same container is ignored;
   * a marker with a *new* vmId (container swap during reconfigure/upgrade)
   * adds followers for that VM too.
   */
  start(
    restartKey: string,
    vmId: number,
    veContext: IVEContext,
    sink: AppLogSink,
  ): void {
    if (!Number.isInteger(vmId) || vmId <= 0) return;
    let state = this.monitors.get(restartKey);
    if (!state) {
      state = { stopped: false, vmIds: new Set(), children: new Set() };
      this.monitors.set(restartKey, state);
    }
    if (state.stopped || state.vmIds.has(vmId)) return;
    state.vmIds.add(vmId);

    const execMode = determineExecutionMode();
    const logsService = new VeLogsService(veContext, execMode);

    logger.info("starting app-log monitor", {
      restartKey,
      vmId,
      execMode,
      host: veContext.host,
    });

    void this.followLxcLog(state, restartKey, vmId, veContext, execMode, logsService, sink);
    void this.followDockerLogs(state, restartKey, vmId, veContext, execMode, sink);
  }

  /** Stop all followers for a restartKey and forget it. */
  stop(restartKey: string): void {
    const state = this.monitors.get(restartKey);
    if (!state) return;
    state.stopped = true;
    for (const child of state.children) this.killChild(child);
    state.children.clear();
    this.monitors.delete(restartKey);
    logger.debug("stopped app-log monitor", { restartKey });
  }

  /** Stop every monitor (process shutdown). */
  stopAll(): void {
    for (const key of [...this.monitors.keys()]) this.stop(key);
  }

  private killChild(child: ChildProcess): void {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, SIGKILL_GRACE_MS);
    // Don't keep the event loop alive just for the grace timer.
    if (typeof t.unref === "function") t.unref();
  }

  /**
   * Supervised follower loop: (re)spawns `cmd` until the monitor is stopped.
   * A fast non-zero exit (e.g. dockerd / compose stack not up yet) simply
   * leads to a backoff + respawn — the command itself doubles as the
   * readiness probe.
   */
  private async supervise(
    state: MonitorState,
    label: string,
    spawnOne: () => ChildProcess,
    onLine: (line: string) => void,
  ): Promise<void> {
    while (!state.stopped) {
      let child: ChildProcess;
      try {
        child = spawnOne();
      } catch (err) {
        logger.debug("follower spawn failed", {
          label,
          error: err instanceof Error ? err.message : String(err),
        });
        if (state.stopped) return;
        await delay(RESPAWN_BACKOFF_MS);
        continue;
      }
      state.children.add(child);
      logger.debug("follower spawned", { label });

      let buffer = "";
      let lineCount = 0;
      const consume = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            lineCount++;
            onLine(line);
          }
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
        child.on("error", (err) => {
          logger.debug("follower process error", {
            label,
            error: err instanceof Error ? err.message : String(err),
          });
          resolve(-1);
        });
      });

      state.children.delete(child);
      if (buffer.trim().length > 0) {
        lineCount++;
        onLine(buffer.replace(/\r?\n$/, ""));
      }
      // Info only when the follower actually streamed something — otherwise
      // it's just the readiness-retry backoff churning silently.
      if (lineCount > 0) {
        logger.info("follower exited", { label, exitCode, lineCount });
      } else {
        logger.debug("follower exited", { label, exitCode, lineCount });
      }
      if (state.stopped) return;
      await delay(RESPAWN_BACKOFF_MS);
    }
  }

  /**
   * Spawn a command on the PVE host (PRODUCTION via ssh) or locally
   * (TEST: the test deployer runs on the PVE host itself). `remoteCommand`
   * is a single shell string handed to the remote/local shell.
   */
  private spawnHost(
    veContext: IVEContext,
    execMode: ExecutionMode,
    remoteCommand: string,
  ): ChildProcess {
    if (execMode === ExecutionMode.TEST) {
      return spawn("sh", ["-c", remoteCommand], { stdio: "pipe" });
    }
    let host = veContext.host;
    if (typeof host === "string" && !host.includes("@")) host = `root@${host}`;
    const port = veContext.port || 22;
    const args = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "PreferredAuthentications=publickey",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=5",
      // Detect a dead connection so a stale follower doesn't hang forever.
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-T",
      "-q",
      "-p", String(port),
      host,
      remoteCommand,
    ];
    return spawn("ssh", args, { stdio: "pipe" });
  }

  private async followLxcLog(
    state: MonitorState,
    restartKey: string,
    vmId: number,
    veContext: IVEContext,
    execMode: ExecutionMode,
    logsService: VeLogsService,
    sink: AppLogSink,
  ): Promise<void> {
    // Resolve the console log path once. `tail -F` tolerates a not-yet
    // existing / rotated file, so a best-guess fallback is safe.
    let logPath: string | null = null;
    try {
      const hostname = await logsService.getHostnameForVm(vmId);
      logPath = await logsService.findLogFile(vmId, hostname);
      if (!logPath) {
        logPath = hostname
          ? `/var/log/lxc/${hostname}-${vmId}.log`
          : `/var/log/lxc/container-${vmId}.log`;
      }
    } catch {
      logPath = `/var/log/lxc/container-${vmId}.log`;
    }
    if (state.stopped) return;
    logger.info("lxc log path resolved", { vmId, logPath });
    const safePath = logPath.replace(/'/g, "'\\''");
    // `-n 200`, not `-n 0`: the container usually finished booting (and ran
    // its on_start hooks) before the marker fires, so a zero-backfill tail
    // would leave the LXC channel empty. A small bounded prelude makes the
    // console log non-empty without dumping the whole (possibly huge) file.
    const remoteCommand = `exec tail -F -n 200 -- '${safePath}'`;
    await this.supervise(
      state,
      `lxc:${vmId}`,
      () => this.spawnHost(veContext, execMode, remoteCommand),
      (line) => sink("lxc", vmId, line),
    );
  }

  private async followDockerLogs(
    state: MonitorState,
    restartKey: string,
    vmId: number,
    veContext: IVEContext,
    execMode: ExecutionMode,
    sink: AppLogSink,
  ): Promise<void> {
    // Runs inside the container. The find/cd/compose-cmd resolution mirrors
    // VeLogsService (docker-compose vs docker compose fallback). It exits
    // fast & non-zero while dockerd / the stack aren't up — the supervisor
    // then backs off and respawns, so this command is also the readiness
    // probe. base64 transport avoids nested-quote hell across ssh+lxc-attach.
    const inner = [
      `COMPOSE_DIR=$(find /opt/docker-compose -maxdepth 1 -type d ! -name docker-compose 2>/dev/null | head -1)`,
      `[ -n "$COMPOSE_DIR" ] || exit 1`,
      `cd "$COMPOSE_DIR" || exit 1`,
      `if docker compose version >/dev/null 2>&1; then CC="docker compose"`,
      `elif command -v docker-compose >/dev/null 2>&1; then CC="docker-compose"`,
      `else exit 1; fi`,
      // Readiness guard *inside the same command* (no separate probe ssh):
      // `docker compose logs -f` exits 0 immediately when no container
      // exists yet, which would otherwise churn the compose-parse warnings
      // every backoff cycle. Exit 1 here → silent retry until the stack is
      // up; then logs -f actually follows and emits service-prefixed lines.
      `[ -n "$($CC ps -q 2>/dev/null)" ] || exit 1`,
      // --tail 200 (not --since 0s): include recent service output so the
      // docker channel isn't empty when the stack came up before the marker.
      `exec $CC logs -f --tail 200 --no-color 2>&1`,
    ].join("\n");
    const b64 = Buffer.from(inner, "utf8").toString("base64");
    const remoteCommand = `printf %s '${b64}' | base64 -d | lxc-attach -n ${vmId} -- sh`;
    await this.supervise(
      state,
      `docker:${vmId}`,
      () => this.spawnHost(veContext, execMode, remoteCommand),
      (line) => sink("docker", vmId, line),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

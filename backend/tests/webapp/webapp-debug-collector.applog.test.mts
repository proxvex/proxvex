import { describe, it, expect } from "vitest";
import { WebAppDebugCollector } from "@src/webapp/webapp-debug-collector.mjs";

/**
 * Covers the live application-log integration: attachAppLog() splits chunks
 * into per-line trace events, strips ANSI so the docker-compose service
 * prefix stays recognizable, and events bucket into the surrounding script
 * by timestamp.
 */
describe("WebAppDebugCollector — applog", () => {
  const RK = "rk-applog-1";
  const ESC = String.fromCharCode(27);

  function startedCollector(): WebAppDebugCollector {
    const c = new WebAppDebugCollector();
    c.start(RK, "zitadel", "installation", "extLog");
    return c;
  }

  it("splits multi-line chunks into one event per non-empty line", () => {
    const c = startedCollector();
    c.attachAppLog(RK, "docker", 123, "zitadel-1  | line a\r\nzitadel-1  | line b\n\n");
    c.finish(RK);
    const bundle = c.renderBundle(RK)!;
    const index = bundle.get("index.md")!;
    expect(index).toContain("[applog:docker]");
    expect(index).toContain("zitadel-1  | line a");
    expect(index).toContain("zitadel-1  | line b");
    const rows = (index.match(/class="tr source-applog/g) ?? []).length;
    expect(rows).toBe(2);
  });

  it("keeps the docker service prefix so the source service is recognizable", () => {
    const c = startedCollector();
    c.attachAppLog(RK, "docker", 9, "zitadel-db-1  | ready to accept connections");
    c.finish(RK);
    const html = c.renderBundle(RK)!.get("index.md")!;
    expect(html).toContain("zitadel-db-1  | ready to accept connections");
    expect(html).toContain("channel-docker");
  });

  it("strips ANSI/cursor-control escapes so the service prefix surfaces", () => {
    const c = startedCollector();
    // `docker compose logs` emits ESC[2K (erase line) before the prefix even
    // with --no-color. The trace must show "zitadel-api-1 | ..." cleanly.
    c.attachAppLog(
      RK,
      "docker",
      7,
      `${ESC}[2Kzitadel-api-1  | ${ESC}[32mINFO${ESC}[0m server started`,
    );
    c.finish(RK);
    const html = c.renderBundle(RK)!.get("index.md")!;
    expect(html).not.toContain(`${ESC}[`);
    expect(html).toContain("zitadel-api-1  | INFO server started");
  });

  it("buckets an applog line into the script whose time window contains it", () => {
    const c = startedCollector();
    const t0 = Date.now();
    c.handleDebugEvent(RK, {
      type: "script-start",
      index: 1,
      command: "Start LXC",
      executeOn: "ve",
      redactedScript: "#!/bin/sh\npct start 123",
      substitutions: [],
      ts: t0,
    });
    c.attachAppLog(RK, "lxc", 123, "lxc-start: container 123 started");
    c.handleDebugEvent(RK, {
      type: "script-end",
      index: 1,
      command: "Start LXC",
      exitCode: 0,
      ts: Date.now() + 1,
    });
    c.finish(RK);
    const bundle = c.renderBundle(RK)!;
    const scriptMd = [...bundle.entries()].find(([k]) =>
      k.startsWith("scripts/01-"),
    )?.[1];
    expect(scriptMd).toBeDefined();
    expect(scriptMd!).toContain("[applog:lxc]");
    expect(scriptMd!).toContain("lxc-start: container 123 started");
  });

  it("ignores attach after the entry is gone / unknown restartKey", () => {
    const c = new WebAppDebugCollector();
    expect(() => c.attachAppLog("missing", "lxc", 1, "x")).not.toThrow();
    expect(c.renderBundle("missing")).toBeNull();
  });
});

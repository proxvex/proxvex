import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH = "shared/templates/refresh/env-file.json";
const PROJECT = "tmpl-env";
const ENV_FILE = `/opt/docker-compose/${PROJECT}/.env`;

const b64 = (v: string) => Buffer.from(v, "utf-8").toString("base64");

/**
 * refresh/env-file (stack refresh "env-file"): sets KEY=VALUE in the compose
 * project's .env inside a running LXC and applies it. Runs the real script on
 * the PVE host against a throw-away Alpine container — no docker inside, so
 * the default apply step (`docker compose up -d`) is exercised by its failure
 * path, which must still report ok with a detail (the file IS patched).
 */
describe.skipIf(!hostReachable)("Template: refresh/env-file", () => {
  const config = loadTemplateTestConfig();
  const stateManager = new TestStateManager(config);
  const helper = new TemplateTestHelper(config);
  const vmId = "9930";

  const run = (envKey: string, value: string, after = "none") =>
    helper.runTemplate({
      templatePath: TEMPLATE_PATH,
      inputs: {
        vm_id: vmId,
        compose_project: PROJECT,
        env_key: envKey,
        new_value_b64: b64(value),
        after_command_b64: b64(after),
      },
    });
  const inCt = async (cmd: string) =>
    (await stateManager.execOnHost(`pct exec ${vmId} -- sh -c '${cmd}'`)).stdout.trim();

  beforeAll(async () => {
    await stateManager.ensureContainerRunning(vmId, {
      osType: "alpine",
      hostname: "tmpl-test-envfile",
    });
    await stateManager.execOnHost(
      `pct exec ${vmId} -- sh -c 'mkdir -p /opt/docker-compose/${PROJECT} && printf "A=1\\nKEY=old\\nB=2\\n" > ${ENV_FILE} && chmod 640 ${ENV_FILE}'`,
    );
  }, 240000);

  afterAll(async () => {
    await stateManager.cleanup(vmId);
  }, 30000);

  it("replaces an existing key, keeps other lines and the file mode", async () => {
    const value = `a"b$c\\d e'f`;
    const result = await run("KEY", value);
    expect(result.success).toBe(true);
    expect(result.outputs["refresh_status"]).toBe("ok");
    expect(await inCt(`grep -c "^KEY=" ${ENV_FILE}`)).toBe("1");
    // The value arrives byte for byte (quotes, $, backslash, blank).
    const line = await stateManager.execOnHost(`pct exec ${vmId} -- grep "^KEY=" ${ENV_FILE} | base64`);
    expect(Buffer.from(line.stdout.trim(), "base64").toString("utf-8").trim()).toBe(`KEY=${value}`);
    expect(await inCt(`grep -c "" ${ENV_FILE}`)).toBe("3");
    expect(await inCt(`stat -c %a ${ENV_FILE}`)).toBe("640");
  });

  it("appends a missing key", async () => {
    const result = await run("NEWKEY", "x1");
    expect(result.outputs["refresh_status"]).toBe("ok");
    expect(await inCt(`grep "^NEWKEY=" ${ENV_FILE}`)).toBe("NEWKEY=x1");
    expect(await inCt(`grep -c "" ${ENV_FILE}`)).toBe("4");
  });

  it("runs the given after_command inside the container", async () => {
    const result = await run("KEY", "v2", "echo applied > /tmp/envfile-applied");
    expect(result.outputs["refresh_status"]).toBe("ok");
    expect(result.outputs["refresh_restarted"]).toBe("true");
    expect(await inCt("cat /tmp/envfile-applied")).toBe("applied");
  });

  it("default apply step (docker compose up -d) runs; its failure is ok + detail", async () => {
    const result = await run("KEY", "v3", "");
    expect(result.outputs["refresh_status"]).toBe("ok");
    expect(result.outputs["refresh_restarted"]).toBe("false");
    expect(String(result.outputs["refresh_detail"])).toContain("applying it failed");
    expect(result.stderr).toContain("Running after_command");
    expect(await inCt(`grep "^KEY=" ${ENV_FILE}`)).toBe("KEY=v3");
  });

  it("rejects an invalid key without touching the file", async () => {
    const before = await inCt(`md5sum ${ENV_FILE}`);
    const result = await run("BAD-KEY", "x");
    expect(result.success).toBe(false);
    expect(result.outputs["refresh_status"]).toBe("error");
    expect(await inCt(`md5sum ${ENV_FILE}`)).toBe(before);
  });

  it("reports an error when the container is not running", async () => {
    await stateManager.execOnHost(`pct stop ${vmId}`);
    const result = await run("KEY", "v4");
    expect(result.success).toBe(false);
    expect(String(result.outputs["refresh_detail"])).toContain("not running");
  });
});

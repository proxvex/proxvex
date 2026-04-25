import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for host-extract-volumes-from-compose.py in isolation.
 *
 * The script is a pure function:
 *   input:  base64(docker-compose.yaml), compose_project, hostname, volumes
 *   output: JSON list of {id, value} entries on stdout
 *
 * Fixtures are the real compose files shipped in json/applications/ and the
 * reference templates in docker/. These are the configs that actually get
 * deployed; using them as fixtures means the test catches regressions against
 * production-realistic input rather than synthetic edge cases.
 *
 * The expected output for each fixture is asserted explicitly. When the script
 * changes (e.g. Phase 2 consolidation to a single mp), update the expectations
 * deliberately — that flags every fixture that needs human review.
 */

const SCRIPT_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/post_start/host-extract-volumes-from-compose.py",
  ),
);

const REPO_ROOT = path.resolve(path.join(__dirname, "../../.."));

interface ScriptResult {
  stdout: string;
  stderr: string;
  status: number | null;
  parsed?: Array<{ id: string; value: string }>;
  volumes?: Record<string, string>;
}

function renderScript(vars: Record<string, string>): string {
  let script = fs.readFileSync(SCRIPT_PATH, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = new RegExp(
      `\\{\\{\\s*${key.replace(/\./g, "\\.")}\\s*\\}\\}`,
      "g",
    );
    script = script.replace(placeholder, value);
  }
  return script;
}

function runExtractor(opts: {
  composePath: string;
  composeProject?: string;
  hostname?: string;
  existingVolumes?: string;
}): ScriptResult {
  const composeContent = fs.readFileSync(opts.composePath, "utf-8");
  const composeBase64 = Buffer.from(composeContent, "utf-8").toString(
    "base64",
  );

  const rendered = renderScript({
    compose_file: composeBase64,
    compose_project: opts.composeProject ?? "",
    hostname: opts.hostname ?? "",
    volumes: opts.existingVolumes ?? "",
  });

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "extract-volumes-test-"),
  );
  const scriptFile = path.join(tmpDir, "script.py");
  fs.writeFileSync(scriptFile, rendered);

  const result = spawnSync("python3", [scriptFile], {
    encoding: "utf-8",
    timeout: 10000,
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const out: ScriptResult = {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };

  if (out.stdout) {
    out.parsed = JSON.parse(out.stdout);
    const volumesEntry = out.parsed!.find((e) => e.id === "volumes");
    if (volumesEntry) {
      out.volumes = {};
      for (const line of volumesEntry.value.split("\n")) {
        if (!line) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        out.volumes[line.slice(0, eq)] = line.slice(eq + 1);
      }
    }
  }

  return out;
}

describe("host-extract-volumes-from-compose.py", () => {
  it("postgrest has no volumes (no compose volumes section, no service volumes)", () => {
    const r = runExtractor({
      composePath: path.join(
        REPO_ROOT,
        "json/applications/postgrest/docker-compose.yml",
      ),
      hostname: "postgrest",
    });
    expect(r.status).toBe(0);
    // Even with no service volumes, the script auto-appends compose + docker.
    // (Phase 2 will consolidate this into a single `app=...` entry.)
    expect(r.volumes).toEqual({
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("docker-registry-mirror exposes /data and /certs as absolute mounts", () => {
    const r = runExtractor({
      composePath: path.join(
        REPO_ROOT,
        "json/applications/docker-registry-mirror/docker-registry-mirror.docker-compose.yml",
      ),
      hostname: "docker-registry-mirror",
    });
    expect(r.status).toBe(0);
    expect(r.volumes).toEqual({
      data: "var/lib/registry",
      certs: "certs",
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("zitadel deduplicates the shared /bootstrap mount across api + login", () => {
    const r = runExtractor({
      composePath: path.join(
        REPO_ROOT,
        "json/applications/zitadel/Zitadel.docker-compose.yml",
      ),
      hostname: "zitadel",
    });
    expect(r.status).toBe(0);
    // Both zitadel-api and zitadel-login mount /bootstrap; only one entry
    // is emitted because the dedup pass keeps the first occurrence by key.
    expect(r.volumes).toEqual({
      bootstrap: "zitadel/bootstrap",
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("mosquitto translates relative ./config ./data ./log to keyed entries", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/mosquitto.docker-compose.yml"),
      hostname: "mosquitto",
    });
    expect(r.status).toBe(0);
    expect(r.volumes).toEqual({
      config: "mosquitto/config",
      data: "mosquitto/data",
      log: "mosquitto/log",
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("postgres translates ./data to data=var/lib/postgresql/data", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/postgres.docker-compose.yml"),
      hostname: "postgres",
    });
    expect(r.status).toBe(0);
    expect(r.volumes).toEqual({
      data: "var/lib/postgresql/data",
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("node-red translates ./data to data=data", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/node-red.docker-compose.yml"),
      hostname: "node-red",
    });
    expect(r.status).toBe(0);
    expect(r.volumes).toEqual({
      data: "data",
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("merges per-key options (permissions) from existing volumes parameter", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/mosquitto.docker-compose.yml"),
      hostname: "mosquitto",
      // Single-line input only — production substitutes the value into a
      // double-quoted Python string literal, so embedded newlines would
      // produce a SyntaxError. In practice docker-compose flows pass either
      // empty or one entry here.
      existingVolumes: "config=/config,0700",
    });
    expect(r.status).toBe(0);
    expect(r.volumes).toEqual({
      config: "mosquitto/config,0700",
      data: "mosquitto/data",
      log: "mosquitto/log",
      compose: "opt/docker-compose",
      docker: "var/lib/docker",
    });
  });

  it("extracts user UID from first service that declares one", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/postgres.docker-compose.yml"),
      hostname: "postgres",
    });
    expect(r.status).toBe(0);
    // postgres uses `user: "${UID:-1000}:${GID:-1000}"` — but envvar refs are
    // not expanded here, so user is the literal string and uid_part is not
    // a digit. No uid/gid emitted.
    const ids = r.parsed!.map((e) => e.id);
    expect(ids).not.toContain("uid");
    expect(ids).not.toContain("gid");
  });

  it("emits compose_project when none was provided (falls back to hostname)", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/postgres.docker-compose.yml"),
      hostname: "my-postgres",
    });
    expect(r.status).toBe(0);
    const project = r.parsed!.find((e) => e.id === "compose_project");
    expect(project?.value).toBe("my-postgres");
  });

  it("does not emit compose_project when caller provided one", () => {
    const r = runExtractor({
      composePath: path.join(REPO_ROOT, "docker/postgres.docker-compose.yml"),
      hostname: "my-postgres",
      composeProject: "explicit-project",
    });
    expect(r.status).toBe(0);
    const ids = r.parsed!.map((e) => e.id);
    expect(ids).not.toContain("compose_project");
  });

});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for post-update-compose-image-tags.py script.
 * This script updates image: tags in an existing docker-compose.yaml
 * based on a target_versions parameter.
 */

const SCRIPT_PATH = path.resolve(
  path.join(__dirname, "../../..", "json/shared/scripts/post_start/post-update-compose-image-tags.py"),
);

const SAMPLE_COMPOSE = `services:
  traefik:
    image: traefik:v3.6
    ports:
      - "80:80"
  zitadel:
    image: ghcr.io/zitadel/zitadel:v4.12.3
    command: start
    environment:
      - ZITADEL_DATABASE_POSTGRES_HOST=postgres
  zitadel-login:
    image: ghcr.io/zitadel/zitadel-login:latest
    volumes:
      - /bootstrap:/zitadel/persistent:ro
`;

let testDir: string;
let composeFile: string;

function runScript(
  targetVersions: string,
  composeProject: string = "test",
): { stdout: string; stderr: string; status: number | null } {
  // Use Python to do the variable replacement to avoid shell escaping issues
  const replaceScript = `
import sys
content = open(sys.argv[1]).read()
content = content.replace('{{ target_versions }}', ${JSON.stringify(targetVersions)})
content = content.replace('{{ compose_project }}', ${JSON.stringify(composeProject)})
content = content.replace('/opt/docker-compose/', ${JSON.stringify(testDir + "/opt/docker-compose/")})
open(sys.argv[2], 'w').write(content)
`;
  const replaceScriptPath = path.join(testDir, "replace.py");
  const tmpScript = path.join(testDir, "test-script.py");
  fs.writeFileSync(replaceScriptPath, replaceScript);

  spawnSync("python3", [replaceScriptPath, SCRIPT_PATH, tmpScript], {
    encoding: "utf-8",
    timeout: 5000,
  });

  const result = spawnSync("python3", [tmpScript], {
    encoding: "utf-8",
    timeout: 10000,
    cwd: testDir,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

describe("post-update-compose-image-tags.py", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-tag-test-"));
    const projectDir = path.join(testDir, "opt/docker-compose/test");
    fs.mkdirSync(projectDir, { recursive: true });
    composeFile = path.join(projectDir, "docker-compose.yaml");
    fs.writeFileSync(composeFile, SAMPLE_COMPOSE);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should update single service version", () => {
    const result = runScript("traefik=v3.7");
    expect(result.status).toBe(0);

    const content = fs.readFileSync(composeFile, "utf-8");
    expect(content).toContain("image: traefik:v3.7");
    // Others unchanged
    expect(content).toContain("image: ghcr.io/zitadel/zitadel:v4.12.3");
    expect(content).toContain(
      "image: ghcr.io/zitadel/zitadel-login:latest",
    );
  });

  it("should update multiple services", () => {
    const result = runScript("traefik=v3.7,zitadel=v4.13.0");
    expect(result.status).toBe(0);

    const content = fs.readFileSync(composeFile, "utf-8");
    expect(content).toContain("image: traefik:v3.7");
    expect(content).toContain("image: ghcr.io/zitadel/zitadel:v4.13.0");
    // zitadel-login unchanged
    expect(content).toContain(
      "image: ghcr.io/zitadel/zitadel-login:latest",
    );
  });

  it("should update all three services", () => {
    const result = runScript(
      "traefik=v3.7,zitadel=v4.13.0,zitadel-login=v2.0.0",
    );
    expect(result.status).toBe(0);

    const content = fs.readFileSync(composeFile, "utf-8");
    expect(content).toContain("image: traefik:v3.7");
    expect(content).toContain("image: ghcr.io/zitadel/zitadel:v4.13.0");
    expect(content).toContain(
      "image: ghcr.io/zitadel/zitadel-login:v2.0.0",
    );
  });

  it("should set version to latest", () => {
    const result = runScript("zitadel=latest");
    expect(result.status).toBe(0);

    const content = fs.readFileSync(composeFile, "utf-8");
    expect(content).toContain("image: ghcr.io/zitadel/zitadel:latest");
  });

  it("should preserve YAML structure and other content", () => {
    const result = runScript("traefik=v3.7");
    expect(result.status).toBe(0);

    const content = fs.readFileSync(composeFile, "utf-8");
    // Check that non-image lines are preserved
    expect(content).toContain("command: start");
    expect(content).toContain(
      "ZITADEL_DATABASE_POSTGRES_HOST=postgres",
    );
    expect(content).toContain("/bootstrap:/zitadel/persistent:ro");
    expect(content).toContain('- "80:80"');
  });

  it("should handle unknown service gracefully", () => {
    const result = runScript("unknown-service=v1.0");
    expect(result.status).toBe(0);

    // File should be unchanged
    const content = fs.readFileSync(composeFile, "utf-8");
    expect(content).toContain("image: traefik:v3.6");
  });

  it("should skip when target_versions is NOT_DEFINED", () => {
    const result = runScript("NOT_DEFINED");
    expect(result.status).toBe(0);

    const stdout = JSON.parse(result.stdout);
    expect(stdout[0].value).toBe("false");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for the parse_compose_services() logic in list-container-service-versions.py.
 * Since the script normally reads from a container via pct exec, we test the parsing
 * function directly by creating a simplified test script.
 */

const SCRIPT_PATH = path.resolve(
  path.join(__dirname, "../../..", "json/shared/scripts/list/list-container-service-versions.py"),
);

let testDir: string;

function createTestScript(composeContent: string): string {
  // Extract only the parse_compose_services and extract_service_image functions
  const originalScript = fs.readFileSync(SCRIPT_PATH, "utf-8");

  // Create a test wrapper that feeds compose content directly
  const testScript = `
import json
import re
import sys

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

${extractFunction(originalScript, "extract_service_image")}

${extractFunction(originalScript, "parse_compose_services")}

content = ${JSON.stringify(composeContent)}
services = parse_compose_services(content)
print(json.dumps(services))
`;
  const scriptPath = path.join(testDir, "test-parse.py");
  fs.writeFileSync(scriptPath, testScript);
  return scriptPath;
}

function extractFunction(script: string, funcName: string): string {
  const lines = script.split("\n");
  let capture = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith(`def ${funcName}(`)) {
      capture = true;
    }
    if (capture) {
      result.push(line);
      // Detect end of function (next non-empty line at same or lower indent)
      if (
        result.length > 1 &&
        line.trim() !== "" &&
        !line.startsWith(" ") &&
        !line.startsWith("\t") &&
        !line.startsWith("def ")
      ) {
        result.pop(); // Remove the non-matching line
        break;
      }
    }
  }
  return result.join("\n");
}

function runParse(composeContent: string): any[] {
  const scriptPath = createTestScript(composeContent);
  const result = spawnSync("python3", [scriptPath], {
    encoding: "utf-8",
    timeout: 10000,
    cwd: testDir,
  });
  if (result.status !== 0) {
    throw new Error(`Script failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

describe("list-container-service-versions.py parsing", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "service-versions-test-"),
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should extract single service with tag", () => {
    const services = runParse(`services:
  traefik:
    image: traefik:v3.6
    ports:
      - "80:80"
`);
    expect(services).toHaveLength(1);
    expect(services[0]).toEqual({
      service: "traefik",
      image: "traefik",
      currentVersion: "v3.6",
    });
  });

  it("should extract service with registry prefix", () => {
    const services = runParse(`services:
  zitadel:
    image: ghcr.io/zitadel/zitadel:v4.12.3
    command: start
`);
    expect(services).toHaveLength(1);
    expect(services[0]).toEqual({
      service: "zitadel",
      image: "ghcr.io/zitadel/zitadel",
      currentVersion: "v4.12.3",
    });
  });

  it("should handle image without tag (defaults to latest)", () => {
    const services = runParse(`services:
  nginx:
    image: nginx
`);
    expect(services).toHaveLength(1);
    expect(services[0]).toEqual({
      service: "nginx",
      image: "nginx",
      currentVersion: "latest",
    });
  });

  it("should extract multiple services", () => {
    const services = runParse(`services:
  traefik:
    image: traefik:v3.6
  zitadel:
    image: ghcr.io/zitadel/zitadel:v4.12.3
  login:
    image: ghcr.io/zitadel/zitadel-login:latest
`);
    expect(services).toHaveLength(3);
    expect(services[0]!.service).toBe("traefik");
    expect(services[1]!.service).toBe("zitadel");
    expect(services[2]!.service).toBe("zitadel-login");
  });

  it("should return empty array for compose without images", () => {
    const services = runParse(`services:
  app:
    build: .
`);
    expect(services).toHaveLength(0);
  });

  it("should return empty array for empty content", () => {
    const services = runParse("");
    expect(services).toHaveLength(0);
  });

  it("should skip template variables in image field", () => {
    const services = runParse(`services:
  app:
    image: {{ oci_image }}
  db:
    image: postgres:16
`);
    expect(services).toHaveLength(1);
    expect(services[0]!.service).toBe("postgres");
  });
});

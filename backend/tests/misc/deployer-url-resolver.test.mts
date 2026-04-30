import { describe, it, expect } from "vitest";
import { resolveDeployerBaseUrl } from "@src/webapp/deployer-url-resolver.mjs";

describe("resolveDeployerBaseUrl", () => {
  it("prefers PROXVEX_URL env override over everything", () => {
    const url = resolveDeployerBaseUrl({
      envOverride: "https://override.example",
      hubUrl: "https://hub.example",
      requestOrigin: "http://origin.example:3080",
      deployerPort: "3080",
      hostname: "proxvex",
    });
    expect(url).toBe("https://override.example");
  });

  it("prefers Hub URL over request origin in Spoke mode", () => {
    const url = resolveDeployerBaseUrl({
      hubUrl: "https://hub.example:3443",
      requestOrigin: "http://localhost:3201",
      deployerPort: "3201",
      hostname: "spoke",
    });
    expect(url).toBe("https://hub.example:3443");
  });

  it("falls back to request origin when no env and no Hub", () => {
    const url = resolveDeployerBaseUrl({
      requestOrigin: "http://10.0.0.5:3080",
      deployerPort: "3080",
      hostname: "proxvex",
    });
    expect(url).toBe("http://10.0.0.5:3080");
  });

  it("falls back to hostname:port when nothing else is provided", () => {
    const url = resolveDeployerBaseUrl({
      deployerPort: "3080",
      hostname: "proxvex",
    });
    expect(url).toBe("http://proxvex:3080");
  });

  it("trims trailing slashes from explicit URLs", () => {
    expect(
      resolveDeployerBaseUrl({
        envOverride: "https://override.example/",
        deployerPort: "3080",
      }),
    ).toBe("https://override.example");
    expect(
      resolveDeployerBaseUrl({
        hubUrl: "https://hub.example:3443//",
        deployerPort: "3080",
      }),
    ).toBe("https://hub.example:3443");
    expect(
      resolveDeployerBaseUrl({
        requestOrigin: "http://10.0.0.5:3080/",
        deployerPort: "3080",
      }),
    ).toBe("http://10.0.0.5:3080");
  });

  it("ignores empty/whitespace overrides", () => {
    const url = resolveDeployerBaseUrl({
      envOverride: "  ",
      hubUrl: "",
      requestOrigin: "http://10.0.0.5:3080",
      deployerPort: "3080",
    });
    expect(url).toBe("http://10.0.0.5:3080");
  });
});

import { describe, it, expect } from "vitest";
import {
  parseVersionString,
  mergeComposeImages,
} from "@src/version-utils.mjs";

describe("parseVersionString", () => {
  it("should parse single version string", () => {
    const result = parseVersionString("v4.12.3");
    expect(result).toEqual([
      { service: "main", image: "", currentVersion: "v4.12.3" },
    ]);
  });

  it("should parse single version without v prefix", () => {
    const result = parseVersionString("4.12.3");
    expect(result).toEqual([
      { service: "main", image: "", currentVersion: "4.12.3" },
    ]);
  });

  it("should parse 'latest'", () => {
    const result = parseVersionString("latest");
    expect(result).toEqual([
      { service: "main", image: "", currentVersion: "latest" },
    ]);
  });

  it("should parse multi-service version with spaces", () => {
    const result = parseVersionString(
      "traefik:v3.6, zitadel:v4.12.3, zitadel-login:latest",
    );
    expect(result).toEqual([
      { service: "traefik", image: "", currentVersion: "v3.6" },
      { service: "zitadel", image: "", currentVersion: "v4.12.3" },
      { service: "zitadel-login", image: "", currentVersion: "latest" },
    ]);
  });

  it("should parse multi-service version without spaces", () => {
    const result = parseVersionString("traefik:v3.6,zitadel:v4.12.3");
    expect(result).toEqual([
      { service: "traefik", image: "", currentVersion: "v3.6" },
      { service: "zitadel", image: "", currentVersion: "v4.12.3" },
    ]);
  });

  it("should parse single service with colon notation", () => {
    const result = parseVersionString("zitadel:v4.12.3");
    expect(result).toEqual([
      { service: "zitadel", image: "", currentVersion: "v4.12.3" },
    ]);
  });

  it("should return empty array for undefined", () => {
    expect(parseVersionString(undefined)).toEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(parseVersionString("")).toEqual([]);
    expect(parseVersionString("  ")).toEqual([]);
  });

  it("should include oci_image when provided for single service", () => {
    const result = parseVersionString(
      "v4.12.3",
      "ghcr.io/zitadel/zitadel",
    );
    expect(result).toEqual([
      {
        service: "main",
        image: "ghcr.io/zitadel/zitadel",
        currentVersion: "v4.12.3",
      },
    ]);
  });
});

describe("mergeComposeImages", () => {
  it("should merge image names from compose", () => {
    const services = [
      { service: "traefik", image: "", currentVersion: "v3.6" },
      { service: "zitadel", image: "", currentVersion: "v4.12.3" },
    ];
    const composeImages = {
      traefik: "traefik",
      zitadel: "ghcr.io/zitadel/zitadel",
    };
    const result = mergeComposeImages(services, composeImages);
    expect(result).toEqual([
      { service: "traefik", image: "traefik", currentVersion: "v3.6" },
      {
        service: "zitadel",
        image: "ghcr.io/zitadel/zitadel",
        currentVersion: "v4.12.3",
      },
    ]);
  });

  it("should not overwrite existing image", () => {
    const services = [
      {
        service: "main",
        image: "ghcr.io/existing/image",
        currentVersion: "v1.0",
      },
    ];
    const result = mergeComposeImages(services, { main: "other" });
    expect(result[0]!.image).toBe("ghcr.io/existing/image");
  });

  it("should handle missing compose images gracefully", () => {
    const services = [
      { service: "unknown", image: "", currentVersion: "v1.0" },
    ];
    const result = mergeComposeImages(services, {});
    expect(result[0]!.image).toBe("");
  });
});

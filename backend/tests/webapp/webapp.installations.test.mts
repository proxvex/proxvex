import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import path from "node:path";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
  createTempDir,
  ensureDirs,
  listFilesRecursive,
  writeTextFile,
} from "../helper/webapp-test-helper.mjs";

describe("WebApp Installations API", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;
  let env: WebAppTestSetup["env"];
  let tmpPve: string;
  const veContextKey = "ve_testhost";

  beforeEach(async () => {
    // Ensure VeExecution runs locally (no SSH) for this test
    process.env.LXC_MANAGER_TEST_MODE = "true";

    setup = await createWebAppTestSetup(import.meta.url, {
      // Provide required scripts for /api/installations via json/ (no manual copying)
      jsonIncludePatterns: [
        ".*list/list-managed-oci-containers.*",
        ".*library/lxc_config_parser_lib.*",
      ],
      // Schemas are read from repo directly by default (no copying)
    });
    env = setup.env;
    tmpPve = createTempDir("lxc-pve-");

    const { ctx } = setup;
    // Create VE context used by installations scan
    ctx.setVEContext({
      host: "testhost",
      port: 22,
      current: true,
    } as any);

    // Create fake /etc/pve/lxc directory structure and configs
    const lxcDir = path.join(tmpPve, "lxc");
    ensureDirs(tmpPve, "lxc");

    // managed + oci -> should be returned
    writeTextFile(
      path.join(lxcDir, "101.conf"),
      [
        "hostname: cont-101",
        "description: <!-- oci-lxc-deployer:managed -->\\n<!-- oci-lxc-deployer:oci-image docker://alpine:3.19 -->\\nOCI image: docker://alpine:3.19",
      ].join("\n"),
    );
    // managed but NOT oci -> should be ignored
    writeTextFile(
      path.join(lxcDir, "102.conf"),
      [
        "hostname: cont-102",
        "description: <!-- oci-lxc-deployer:managed -->\\nLXC template: local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst",
      ].join("\n"),
    );
    // oci but NOT managed -> should be ignored
    writeTextFile(
      path.join(lxcDir, "103.conf"),
      [
        "hostname: cont-103",
        "description: <!-- oci-lxc-deployer:oci-image docker://debian:bookworm -->",
      ].join("\n"),
    );
    // managed + oci (fallback visible line only) -> should be returned
    writeTextFile(
      path.join(lxcDir, "104.conf"),
      [
        "hostname: cont-104",
        "description: <!-- oci-lxc-deployer:managed -->\\nOCI image: ghcr.io/example/app:1.2.3",
      ].join("\n"),
    );

    // Point scan logic to our fake dir in tests
    process.env.LXC_MANAGER_PVE_LXC_DIR = lxcDir;

    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  it("returns managed OCI containers and does not modify json dir", async () => {
    // json dir should not be modified by the request (no files written)
    const jsonFilesBefore = listFilesRecursive(env.jsonDir);

    const url = ApiUri.Installations.replace(":veContext", veContextKey);
    const res = await request(app).get(url);
    if (res.status !== 200 || res.body.length !== 2) {
      console.error("Response:", JSON.stringify(res.body, null, 2));
      // Debug: show what config files look like
      const lxcDir = process.env.LXC_MANAGER_PVE_LXC_DIR;
      if (lxcDir) {
        const fs = await import("node:fs");
        const files = fs.readdirSync(lxcDir);
        for (const f of files) {
          const content = fs.readFileSync(path.join(lxcDir, f), "utf-8");
          console.error(`--- ${f} ---`);
          console.error(JSON.stringify(content));
        }
      }
    }
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    // Sorted by vm_id
    expect(res.body[0].vm_id).toBe(101);
    expect(res.body[1].vm_id).toBe(104);

    // Validate shape of entries
    for (const entry of res.body) {
      expect(typeof entry.vm_id).toBe("number");
      expect(typeof entry.oci_image).toBe("string");
      // Icon is currently empty string (placeholder for later notes parsing)
      expect(entry.icon).toBe("");
    }

    // Still no json written afterwards
    const jsonFilesAfter = listFilesRecursive(env.jsonDir);
    expect(jsonFilesAfter).toEqual(jsonFilesBefore);
  });
});

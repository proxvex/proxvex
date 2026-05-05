import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";

const CA_VE_CONTEXT = "ca_global";

describe("Hub API routes", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(async () => {
    setup = await createWebAppTestSetup(import.meta.url);
    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  // --- CA endpoints ---------------------------------------------------------

  describe("POST /api/hub/ca/sign", () => {
    it("signs a server cert for the requested hostname", async () => {
      // A CA must exist on the hub context before signing.
      new CertificateAuthorityService(setup.ctx).generateCA(CA_VE_CONTEXT);

      const res = await request(app)
        .post(ApiUri.HubCaSign)
        .send({ hostname: "spoke.example" });

      expect(res.status).toBe(200);
      expect(typeof res.body.cert).toBe("string");
      expect(typeof res.body.key).toBe("string");

      const pem = Buffer.from(res.body.cert, "base64").toString("utf-8");
      expect(pem).toContain("BEGIN CERTIFICATE");
      const keyPem = Buffer.from(res.body.key, "base64").toString("utf-8");
      expect(keyPem).toContain("PRIVATE KEY");
    });

    it("returns 400 when hostname is missing", async () => {
      const res = await request(app).post(ApiUri.HubCaSign).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/hostname/i);
    });
  });

  describe("GET /api/hub/ca/cert", () => {
    it("returns 404 when no CA is configured", async () => {
      const res = await request(app).get(ApiUri.HubCaCert);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no ca/i);
    });

    it("returns the CA certificate after generation", async () => {
      const ca = new CertificateAuthorityService(setup.ctx).generateCA(
        CA_VE_CONTEXT,
      );

      const res = await request(app).get(ApiUri.HubCaCert);
      expect(res.status).toBe(200);
      expect(res.body.cert).toBe(ca.cert);
      const pem = Buffer.from(res.body.cert, "base64").toString("utf-8");
      expect(pem).toContain("BEGIN CERTIFICATE");
    });
  });

  // --- Stack endpoints ------------------------------------------------------

  describe("Stack CRUD roundtrip", () => {
    const sampleStack = {
      id: "hub-test",
      name: "Hub Test",
      stacktype: "music",
      entries: [{ name: "artist", value: "Metric" }],
    };

    it("POST adds, GET lists, GET /:id returns, DELETE removes", async () => {
      // List is initially empty
      const empty = await request(app).get(ApiUri.HubStacks);
      expect(empty.status).toBe(200);
      expect(empty.body.stacks).toEqual([]);

      // POST create
      const created = await request(app).post(ApiUri.HubStacks).send(sampleStack);
      expect(created.status).toBe(200);
      expect(created.body.success).toBe(true);
      expect(typeof created.body.key).toBe("string");

      // GET list now contains the stack
      const list = await request(app).get(ApiUri.HubStacks);
      expect(list.status).toBe(200);
      expect(list.body.stacks).toHaveLength(1);
      expect(list.body.stacks[0].name).toBe("Hub Test");

      const createdId = list.body.stacks[0].id;

      // GET single by id
      const single = await request(app).get(
        ApiUri.HubStack.replace(":id", createdId),
      );
      expect(single.status).toBe(200);
      expect(single.body.stack.name).toBe("Hub Test");

      // DELETE
      const del = await request(app).delete(
        ApiUri.HubStack.replace(":id", createdId),
      );
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);
      expect(del.body.deleted).toBe(true);

      // Gone
      const afterDelete = await request(app).get(
        ApiUri.HubStack.replace(":id", createdId),
      );
      expect(afterDelete.status).toBe(404);
    });

    it("GET /:id returns 404 for unknown stack", async () => {
      const res = await request(app).get(
        ApiUri.HubStack.replace(":id", "does-not-exist"),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it("GET ?stacktype=X filters the list", async () => {
      await request(app).post(ApiUri.HubStacks).send(sampleStack);
      await request(app).post(ApiUri.HubStacks).send({
        id: "other",
        name: "Other",
        stacktype: "database",
        entries: [],
      });

      const musicOnly = await request(app)
        .get(ApiUri.HubStacks)
        .query({ stacktype: "music" });
      expect(musicOnly.status).toBe(200);
      expect(musicOnly.body.stacks).toHaveLength(1);
      expect(musicOnly.body.stacks[0].stacktype).toBe("music");
    });
  });

  // --- Tarball endpoints ----------------------------------------------------

  describe("GET /api/hub/project", () => {
    it("returns 404 when local/shared/ does not exist", async () => {
      const res = await request(app).get(ApiUri.HubProject);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/shared/i);
    });

    it("streams a gzip tarball containing shared/", async () => {
      // Seed a shared dir under the test env's local path.
      const sharedDir = path.join(setup.env.localDir, "shared");
      fs.mkdirSync(path.join(sharedDir, "templates"), { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, "templates", "marker.txt"),
        "project-marker",
      );

      const res = await request(app)
        .get(ApiUri.HubProject)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("gzip");
      expect(res.headers["content-disposition"]).toContain("project.tar.gz");

      const body = res.body as Buffer;
      // gzip magic bytes
      expect(body[0]).toBe(0x1f);
      expect(body[1]).toBe(0x8b);

      const entries = listTarEntries(body);
      expect(entries).toContain("shared/templates/marker.txt");
    });
  });

  describe("GET /api/hub/repositories.tar.gz", () => {
    it("returns 404 when local/ directory does not exist", async () => {
      // Env creates an empty local dir by default — remove it to trigger 404.
      fs.rmSync(setup.env.localDir, { recursive: true, force: true });

      const res = await request(app).get(ApiUri.HubRepositoriesTarball);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/local/i);
    });

    it("streams a gzip tarball containing local/", async () => {
      // Seed a local/ file so it appears in the tar.
      const localOverride = path.join(setup.env.localDir, "shared", "over.txt");
      fs.mkdirSync(path.dirname(localOverride), { recursive: true });
      fs.writeFileSync(localOverride, "local-marker");

      const res = await request(app)
        .get(ApiUri.HubRepositoriesTarball)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("gzip");
      expect(res.headers["content-disposition"]).toContain(
        "repositories.tar.gz",
      );

      const body = res.body as Buffer;
      expect(body[0]).toBe(0x1f);
      expect(body[1]).toBe(0x8b);

      const entries = listTarEntries(body);
      expect(entries).toContain("local/shared/over.txt");
    });
  });

  // --- Spoke placeholders ---------------------------------------------------

  describe("Spoke management placeholders", () => {
    it("GET /api/hub/spokes returns an empty list", async () => {
      const res = await request(app).get(ApiUri.HubSpokes);
      expect(res.status).toBe(200);
      expect(res.body.spokes).toEqual([]);
    });

    it("DELETE /api/hub/spoke/:id returns 501", async () => {
      const res = await request(app).delete(
        ApiUri.HubSpoke.replace(":id", "any"),
      );
      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/not implemented/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the list of file entries inside a gzipped tar buffer. Uses the
 * system `tar` binary (same tool the endpoints use to produce the archive)
 * so we don't need an extra npm dependency for a couple of assertions.
 */
function listTarEntries(gzipBuffer: Buffer): string[] {
  const tarBuffer = zlib.gunzipSync(gzipBuffer);
  const listing = execSync("tar -tf -", { input: tarBuffer, encoding: "utf-8" });
  return listing
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

/**
 * Regression for the POSTGRES_PASSWORD-divergence bug: POST /api/stacks must
 * be idempotent w.r.t. already-stored auto-generated secrets. Re-creating an
 * existing stack by name (no body.id, empty entries — the livetest runner's
 * recreate-after-delete path) must NOT regenerate the secret, otherwise the
 * Hub-persisted value is overwritten while reused volumes keep the old one.
 */
describe("Stack API — secret idempotency", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(async () => {
    // Pull in the real stacktype defs so `postgres` has its auto-generated
    // POSTGRES_PASSWORD variable (no `external` flag → handler mints one).
    setup = await createWebAppTestSetup(import.meta.url, {
      jsonIncludePatterns: ["stacktypes/.*"],
    });
    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  const pwOf = (entries: { name: string; value: string }[]) =>
    entries.find((e) => e.name === "POSTGRES_PASSWORD")?.value;

  it("keeps POSTGRES_PASSWORD stable across a recreate-by-name (no id, empty entries)", async () => {
    const create = () =>
      request(app)
        .post(ApiUri.Stacks)
        .send({ name: "default", stacktype: "postgres", entries: [] });

    const r1 = await create();
    expect(r1.status).toBe(200);
    const s1 = setup.ctx.getStack("postgres_default");
    const pw1 = pwOf(s1!.entries as { name: string; value: string }[]);
    expect(pw1).toBeTruthy();
    expect(String(pw1).length).toBeGreaterThanOrEqual(16);

    // Second create with the same name + empty entries — the path the
    // livetest runner takes after deleting the stack. Must NOT regenerate.
    const r2 = await create();
    expect(r2.status).toBe(200);
    const s2 = setup.ctx.getStack("postgres_default");
    const pw2 = pwOf(s2!.entries as { name: string; value: string }[]);
    expect(pw2).toBe(pw1);
  });

  it("honours a caller-supplied value and preserves it on a later empty re-POST", async () => {
    const r1 = await request(app)
      .post(ApiUri.Stacks)
      .send({
        name: "default",
        stacktype: "postgres",
        entries: [{ name: "POSTGRES_PASSWORD", value: "explicit-secret-123" }],
      });
    expect(r1.status).toBe(200);
    expect(pwOf(setup.ctx.getStack("postgres_default")!.entries as any)).toBe(
      "explicit-secret-123",
    );

    const r2 = await request(app)
      .post(ApiUri.Stacks)
      .send({ name: "default", stacktype: "postgres", entries: [] });
    expect(r2.status).toBe(200);
    expect(pwOf(setup.ctx.getStack("postgres_default")!.entries as any)).toBe(
      "explicit-secret-123",
    );
  });
});

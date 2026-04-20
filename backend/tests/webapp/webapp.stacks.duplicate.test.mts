import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

/**
 * Reproducer for: "two 'production' stacks appear after saving changes".
 *
 * Hypothesis: POST /api/stacks regenerates `id` from `stacktype + name` on
 * every call. If a previously-saved stack is re-saved with a different name
 * or stacktype, the old entry stays in the context and a new entry appears —
 * both visible in the stacks list.
 */
describe("Stack API — duplicate detection on update", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(async () => {
    setup = await createWebAppTestSetup(import.meta.url);
    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  it("same name + stacktype: update replaces the old entry (no duplicate)", async () => {
    // 1. Create
    const created = await request(app)
      .post(ApiUri.Stacks)
      .send({
        name: "production",
        stacktype: "music",
        entries: [{ name: "artist", value: "v1" }],
      });
    expect(created.status).toBe(200);

    // 2. Update (same name, same stacktype)
    const updated = await request(app)
      .post(ApiUri.Stacks)
      .send({
        id: "music_production",
        name: "production",
        stacktype: "music",
        entries: [{ name: "artist", value: "v2" }],
      });
    expect(updated.status).toBe(200);

    // 3. Must be exactly one stack
    const list = await request(app).get(`${ApiUri.Stacks}?stacktype=music`);
    expect(list.body.stacks.length).toBe(1);
    expect(list.body.stacks[0].entries[0].value).toBe("v2");
  });

  it("stacktype array-vs-string: re-saving with normalized form creates duplicate", async () => {
    // 1. Create with string form
    await request(app)
      .post(ApiUri.Stacks)
      .send({
        name: "production",
        stacktype: "music",
        entries: [{ name: "artist", value: "v1" }],
      });

    // 2. Update with array form (which happens if frontend round-trips through
    //    a Stack object where stacktype was serialized as array)
    await request(app)
      .post(ApiUri.Stacks)
      .send({
        id: "music_production",
        name: "production",
        stacktype: ["music"],
        entries: [{ name: "artist", value: "v2" }],
      });

    const list = await request(app).get(`${ApiUri.Stacks}?stacktype=music`);
    // If duplicate: length === 2. If no duplicate (bug absent): length === 1.
    expect(list.body.stacks.length).toBe(1);
  });

  it("rename duplicates: editing name creates a second stack, old remains", async () => {
    // 1. Create "production"
    await request(app)
      .post(ApiUri.Stacks)
      .send({
        name: "production",
        stacktype: "music",
        entries: [{ name: "artist", value: "v1" }],
      });

    // 2. Save a copy with new name "prod" (simulating user renaming)
    await request(app)
      .post(ApiUri.Stacks)
      .send({
        id: "music_production",         // the OLD id from the form
        name: "prod",                    // new name
        stacktype: "music",
        entries: [{ name: "artist", value: "v1" }],
      });

    const list = await request(app).get(`${ApiUri.Stacks}?stacktype=music`);
    // This is the documented failure mode: two entries remain
    // (one under `music_production`, one under `music_prod`).
    expect(list.body.stacks.length).toBeLessThanOrEqual(1);
  });

  it("same-name double-save: verifies no duplicate when user saves same form twice", async () => {
    const payload = {
      name: "production",
      stacktype: "music",
      entries: [{ name: "artist", value: "v1" }],
    };
    await request(app).post(ApiUri.Stacks).send(payload);
    await request(app).post(ApiUri.Stacks).send(payload);

    const list = await request(app).get(`${ApiUri.Stacks}?stacktype=music`);
    expect(list.body.stacks.length).toBe(1);
  });
});

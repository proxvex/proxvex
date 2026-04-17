import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

describe("Stack API", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(async () => {
    setup = await createWebAppTestSetup(import.meta.url);
    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  describe("POST /api/stacks", () => {
    it("creates a new stack and stores it in context", async () => {
      const stack = {
        id: "stack1",
        name: "Test Stack",
        stacktype: "music",
        entries: [{ name: "artist", value: "Test Artist" }],
      };
      const res = await request(app).post(ApiUri.Stacks).send(stack);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("stack_music_Test Stack");

      // Verify stack is stored in context
      const storedStack = setup.ctx.getStack("music_Test Stack");
      expect(storedStack).not.toBeNull();
      expect(storedStack?.id).toBe("music_Test Stack");
      expect(storedStack?.name).toBe("Test Stack");
      expect(storedStack?.stacktype).toBe("music");
      expect(storedStack?.entries).toEqual([
        { name: "artist", value: "Test Artist" },
      ]);
    });

    it("auto-generates id from name when not provided", async () => {
      const res = await request(app)
        .post(ApiUri.Stacks)
        .send({ name: "Test", stacktype: "music", entries: [] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("stack_music_Test");
    });

    it("returns error for missing name", async () => {
      const res = await request(app)
        .post(ApiUri.Stacks)
        .send({ id: "t1", stacktype: "music", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });

    it("returns error for missing stacktype", async () => {
      const res = await request(app)
        .post(ApiUri.Stacks)
        .send({ id: "t1", name: "Test", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });
  });

  describe("GET /api/stacks", () => {
    it("returns empty list initially", async () => {
      const res = await request(app).get(ApiUri.Stacks);
      expect(res.status).toBe(200);
      expect(res.body.stacks).toEqual([]);
    });

    it("returns all stacks", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "t1",
        name: "Stack 1",
        stacktype: "music",
        entries: [],
      });
      await request(app).post(ApiUri.Stacks).send({
        id: "t2",
        name: "Stack 2",
        stacktype: "video",
        entries: [],
      });

      const res = await request(app).get(ApiUri.Stacks);
      expect(res.status).toBe(200);
      expect(res.body.stacks.length).toBe(2);
    });

    it("filters by stacktype", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "t1",
        name: "Stack 1",
        stacktype: "music",
        entries: [],
      });
      await request(app).post(ApiUri.Stacks).send({
        id: "t2",
        name: "Stack 2",
        stacktype: "video",
        entries: [],
      });
      await request(app).post(ApiUri.Stacks).send({
        id: "t3",
        name: "Stack 3",
        stacktype: "music",
        entries: [],
      });

      const res = await request(app).get(`${ApiUri.Stacks}?stacktype=music`);
      expect(res.status).toBe(200);
      expect(res.body.stacks.length).toBe(2);
      expect(
        res.body.stacks.every(
          (t: { stacktype: string }) => t.stacktype === "music",
        ),
      ).toBe(true);
    });

    it("returns empty list when filtering by non-existent stacktype", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "t1",
        name: "Stack 1",
        stacktype: "music",
        entries: [],
      });

      const res = await request(app).get(
        `${ApiUri.Stacks}?stacktype=nonexistent`,
      );
      expect(res.status).toBe(200);
      expect(res.body.stacks).toEqual([]);
    });
  });

  describe("GET /api/stack/:id", () => {
    it("returns 404 for non-existent stack", async () => {
      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "unknown"),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Stack not found");
    });

    it("returns stack by id", async () => {
      await request(app)
        .post(ApiUri.Stacks)
        .send({
          name: "My Stack",
          stacktype: "audio",
          entries: [{ name: "duration", value: 180 }],
        });

      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "audio_My Stack"),
      );
      expect(res.status).toBe(200);
      expect(res.body.stack.id).toBe("audio_My Stack");
      expect(res.body.stack.name).toBe("My Stack");
      expect(res.body.stack.stacktype).toBe("audio");
      expect(res.body.stack.entries).toEqual([
        { name: "duration", value: 180 },
      ]);
    });

    it("returns 404 when looking up by name instead of id", async () => {
      await request(app).post(ApiUri.Stacks).send({
        name: "My Stack",
        stacktype: "audio",
        entries: [],
      });

      // Looking up by name should NOT work — must use stackId
      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "My Stack"),
      );
      expect(res.status).toBe(404);

      // Looking up by stackId works
      const res2 = await request(app).get(
        ApiUri.Stack.replace(":id", "audio_My Stack"),
      );
      expect(res2.status).toBe(200);
      expect(res2.body.stack.name).toBe("My Stack");
    });

    it("returns stack by key with stack_ prefix", async () => {
      await request(app).post(ApiUri.Stacks).send({
        name: "My Stack",
        stacktype: "audio",
        entries: [],
      });

      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "stack_audio_My Stack"),
      );
      expect(res.status).toBe(200);
      expect(res.body.stack.name).toBe("My Stack");
    });
  });

  describe("DELETE /api/stack/:id", () => {
    it("deletes existing stack by id", async () => {
      await request(app).post(ApiUri.Stacks).send({
        name: "Delete Me",
        stacktype: "test",
        entries: [],
      });

      // Verify stack exists in context before deletion
      expect(setup.ctx.getStack("test_Delete Me")).not.toBeNull();

      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "test_Delete Me"),
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deleted).toBe(true);

      // Verify stack is removed from context
      expect(setup.ctx.getStack("test_Delete Me")).toBeNull();

      // Verify via API as well
      const getRes = await request(app).get(
        ApiUri.Stack.replace(":id", "test_Delete Me"),
      );
      expect(getRes.status).toBe(404);
    });

    it("delete by name returns deleted=false (must use stackId)", async () => {
      await request(app).post(ApiUri.Stacks).send({
        name: "Delete Me",
        stacktype: "test",
        entries: [],
      });

      // Deleting by name should NOT work — must use stackId
      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "Delete Me"),
      );
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(false);

      // Deleting by stackId works
      const res2 = await request(app).delete(
        ApiUri.Stack.replace(":id", "test_Delete Me"),
      );
      expect(res2.status).toBe(200);
      expect(res2.body.deleted).toBe(true);
    });

    it("returns deleted=false for non-existent stack", async () => {
      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "nonexistent"),
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.deleted).toBe(false);
    });

    it("deletes stack using stack_ prefix and removes from context", async () => {
      await request(app).post(ApiUri.Stacks).send({
        name: "Delete Me",
        stacktype: "test",
        entries: [],
      });

      // Verify stack exists in context (by stackId)
      expect(setup.ctx.getStack("test_Delete Me")).not.toBeNull();

      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "stack_test_Delete Me"),
      );
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      // Verify stack is removed from context
      expect(setup.ctx.getStack("test_Delete Me")).toBeNull();
    });
  });

  describe("GET /api/stacktypes", () => {
    it("returns empty list when no stacktypes.json exists", async () => {
      const res = await request(app).get(ApiUri.Stacktypes);
      expect(res.status).toBe(200);
      expect(res.body.stacktypes).toEqual([]);
    });

    it("loads legacy array format stacktype", async () => {
      const stacktypesDir = path.join(setup.env.jsonDir, "stacktypes");
      fs.mkdirSync(stacktypesDir, { recursive: true });
      fs.writeFileSync(
        path.join(stacktypesDir, "legacy.json"),
        JSON.stringify([
          { name: "SECRET_A" },
          { name: "SECRET_B", length: 64 },
        ]),
      );

      const res = await request(app).get(ApiUri.Stacktypes);
      expect(res.status).toBe(200);
      const st = res.body.stacktypes.find(
        (s: { name: string }) => s.name === "legacy",
      );
      expect(st).toBeDefined();
      expect(st.entries).toHaveLength(2);
      expect(st.entries[0].name).toBe("SECRET_A");
      expect(st.dependencies).toBeUndefined();
    });

    it("loads object format stacktype with dependencies", async () => {
      const stacktypesDir = path.join(setup.env.jsonDir, "stacktypes");
      fs.mkdirSync(stacktypesDir, { recursive: true });
      fs.writeFileSync(
        path.join(stacktypesDir, "dbstack.json"),
        JSON.stringify({
          variables: [
            { name: "DB_PASSWORD" },
            { name: "API_KEY", length: 48 },
          ],
          dependencies: [{ application: "postgres" }],
        }),
      );

      const res = await request(app).get(ApiUri.Stacktypes);
      expect(res.status).toBe(200);
      const st = res.body.stacktypes.find(
        (s: { name: string }) => s.name === "dbstack",
      );
      expect(st).toBeDefined();
      expect(st.entries).toHaveLength(2);
      expect(st.entries[0].name).toBe("DB_PASSWORD");
      expect(st.dependencies).toHaveLength(1);
      expect(st.dependencies[0].application).toBe("postgres");
    });

    it("auto-generates secrets for object format stacktype", async () => {
      const stacktypesDir = path.join(setup.env.jsonDir, "stacktypes");
      fs.mkdirSync(stacktypesDir, { recursive: true });
      fs.writeFileSync(
        path.join(stacktypesDir, "withsecrets.json"),
        JSON.stringify({
          variables: [{ name: "AUTO_SECRET" }, { name: "MANUAL", external: true }],
          dependencies: [{ application: "mydb", task: "installation" }],
        }),
      );

      // Create a stack using this stacktype (MANUAL is external, must be provided)
      const res = await request(app).post(ApiUri.Stacks).send({
        name: "test-stack",
        stacktype: "withsecrets",
        entries: [{ name: "MANUAL", value: "user-provided-value" }],
      });
      expect(res.status).toBe(200);

      // Verify auto-generated secret
      const stack = setup.ctx.getStack("withsecrets_test-stack");
      expect(stack).not.toBeNull();
      const autoSecret = stack!.entries.find((e) => e.name === "AUTO_SECRET");
      expect(autoSecret).toBeDefined();
      expect(String(autoSecret!.value).length).toBe(32); // default length
    });
  });

  describe("Stack provides", () => {
    it("stores and retrieves provides on a stack", async () => {
      // Create stack
      await request(app).post(ApiUri.Stacks).send({
        name: "provides-test",
        stacktype: "music",
        entries: [],
      });

      // Manually set provides on the stack (simulates what backend does after execution)
      const stack = setup.ctx.getStack("music_provides-test");
      expect(stack).not.toBeNull();
      stack!.provides = [
        { name: "PROTO", value: "https", application: "myapp" },
        { name: "PORT", value: "8443", application: "myapp" },
      ];
      setup.ctx.set(`stack_music_provides-test`, stack);

      // Retrieve and verify
      const url = ApiUri.Stack.replace(":id", "music_provides-test");
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.body.stack.provides).toHaveLength(2);
      expect(res.body.stack.provides[0].name).toBe("PROTO");
      expect(res.body.stack.provides[0].value).toBe("https");
      expect(res.body.stack.provides[0].application).toBe("myapp");
    });

    it("provides are empty by default", async () => {
      await request(app).post(ApiUri.Stacks).send({
        name: "no-provides",
        stacktype: "music",
        entries: [],
      });

      const url = ApiUri.Stack.replace(":id", "music_no-provides");
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      // provides should be undefined or empty
      expect(res.body.stack.provides ?? []).toHaveLength(0);
    });
  });
});

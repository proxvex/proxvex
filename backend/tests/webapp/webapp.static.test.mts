import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  createWebAppStaticTestSetup,
  type WebAppStaticTestSetup,
} from "../helper/webapp-test-helper.mjs";

describe("WebApp serves index.html", () => {
  let setup: WebAppStaticTestSetup;

  beforeAll(async () => {
    setup = await createWebAppStaticTestSetup(import.meta.url);
  });

  afterAll(() => {
    setup.cleanup();
  });

  it("GET / returns 200 and HTML", async () => {
    const res = await request(setup.app)
      .get("/")
      .expect("Content-Type", /html/);
    expect(res.status).toBe(200);
  });
});

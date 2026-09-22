import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";

function writeStacktype(dir: string, name: string, body: object): void {
  const stacktypesDir = path.join(dir, "stacktypes");
  fs.mkdirSync(stacktypesDir, { recursive: true });
  fs.writeFileSync(path.join(stacktypesDir, `${name}.json`), JSON.stringify(body));
}

describe("PersistenceManager.getStacktypes with local layer", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, { jsonIncludePatterns: [] });
    writeStacktype(env.jsonDir, "shared", {
      name: "Shared",
      variables: [{ name: "SHARED_SECRET" }],
    });
    writeStacktype(env.jsonDir, "overridden", {
      name: "From json",
      variables: [{ name: "JSON_ONLY" }],
    });
    writeStacktype(env.localDir, "overridden", {
      name: "From local",
      variables: [{ name: "LOCAL_ONLY" }],
    });
    writeStacktype(env.localDir, "site", {
      name: "Site",
      variables: [{ name: "SITE_KEY", length: 43 }],
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  it("merges json/ and local stacktypes, local wins on name clash", () => {
    const { pm } = env.initPersistence({ enableCache: false });
    const byName = new Map(pm.getStacktypes().map((st) => [st.name, st]));

    expect(byName.get("shared")?.entries).toEqual([{ name: "SHARED_SECRET" }]);
    expect(byName.get("site")?.entries).toEqual([{ name: "SITE_KEY", length: 43 }]);
    expect(byName.get("overridden")?.displayName).toBe("From local");
    expect(byName.get("overridden")?.entries).toEqual([{ name: "LOCAL_ONLY" }]);
  });

  it("works without a local stacktypes directory", () => {
    fs.rmSync(path.join(env.localDir, "stacktypes"), { recursive: true, force: true });
    const { pm } = env.initPersistence({ enableCache: false });
    const names = pm.getStacktypes().map((st) => st.name).sort();

    expect(names).toEqual(["overridden", "shared"]);
    expect(pm.getStacktypes().find((st) => st.name === "overridden")?.displayName).toBe(
      "From json",
    );
  });
});

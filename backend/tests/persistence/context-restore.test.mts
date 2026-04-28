import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, copyFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { Context } from "@src/context.mjs";

/**
 * Test: Context restore after snapshot rollback.
 *
 * Simulates the snapshot lifecycle:
 * 1. Create context A with secret A and stack passwords
 * 2. "Backup" files (copy to backup dir = simulates snapshot)
 * 3. Create context B with new secret B (simulates normal operation)
 * 4. "Restore" files (copy backup back = simulates rollback)
 * 5. Create new Context from restored files
 * 6. Verify: stack passwords from context A must be readable
 */
describe("Context restore after snapshot rollback", () => {
  let tmpDir: string;
  let backupDir: string;
  let contextFile: string;
  let secretFile: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `context-restore-test-${Date.now()}`);
    backupDir = path.join(tmpDir, "backup");
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    contextFile = path.join(tmpDir, "storagecontext.json");
    secretFile = path.join(tmpDir, "secret.txt");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should read restored context after secret.txt and storagecontext.json are replaced", () => {
    // Step 1: Create context A with a stack password
    const ctxA = new Context(contextFile, secretFile);
    ctxA.set("stack_postgres_default", {
      id: "postgres_default",
      name: "default",
      stacktype: "postgres",
      entries: [{ name: "POSTGRES_PASSWORD", value: "secret-password-A" }],
    });

    // Verify context A works
    const stackA = ctxA.get<any>("stack_postgres_default");
    expect(stackA.entries[0].value).toBe("secret-password-A");

    // Step 2: Backup files (simulates snapshot backup to VM)
    copyFileSync(contextFile, path.join(backupDir, "storagecontext.json"));
    copyFileSync(secretFile, path.join(backupDir, "secret.txt"));

    // Step 3: Create context B with different data (simulates normal operation after snapshot)
    // Delete existing files to force new secret generation
    rmSync(secretFile);
    rmSync(contextFile);
    const ctxB = new Context(contextFile, secretFile);
    ctxB.set("stack_postgres_default", {
      id: "postgres_default",
      name: "default",
      stacktype: "postgres",
      entries: [{ name: "POSTGRES_PASSWORD", value: "different-password-B" }],
    });

    // Verify context B has different password
    const stackB = ctxB.get<any>("stack_postgres_default");
    expect(stackB.entries[0].value).toBe("different-password-B");

    // Verify secret files are different
    const secretA = readFileSync(path.join(backupDir, "secret.txt"), "utf-8");
    const secretBCurrent = readFileSync(secretFile, "utf-8");
    expect(secretA).not.toBe(secretBCurrent);

    // Step 4: Restore files (simulates snapshot rollback)
    copyFileSync(path.join(backupDir, "storagecontext.json"), contextFile);
    copyFileSync(path.join(backupDir, "secret.txt"), secretFile);

    // Step 5: Create new Context from restored files (simulates PersistenceManager.reload())
    const ctxRestored = new Context(contextFile, secretFile);

    // Step 6: Verify restored context has original password
    const stackRestored = ctxRestored.get<any>("stack_postgres_default");
    expect(stackRestored).toBeDefined();
    expect(stackRestored.entries[0].value).toBe("secret-password-A");
  });

  it("should handle restore when context B wrote to the same file", () => {
    // Context A: create and save
    const ctxA = new Context(contextFile, secretFile);
    ctxA.set("mykey", "value-A");

    // Backup
    copyFileSync(contextFile, path.join(backupDir, "storagecontext.json"));
    copyFileSync(secretFile, path.join(backupDir, "secret.txt"));

    // Context B: overwrite with same secret (simulates reload without secret change)
    ctxA.set("mykey", "value-B");
    ctxA.set("extra", "only-in-B");

    // Restore
    copyFileSync(path.join(backupDir, "storagecontext.json"), contextFile);
    copyFileSync(path.join(backupDir, "secret.txt"), secretFile);

    // Reload
    const ctxRestored = new Context(contextFile, secretFile);
    expect(ctxRestored.get("mykey")).toBe("value-A");
    expect(ctxRestored.get("extra")).toBeUndefined();
  });
});

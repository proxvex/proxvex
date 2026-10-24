import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import {
  buildRollbackScript,
  parseVmid,
  rollbackTarget,
} from "@src/ve-execution/ve-execution-rollback.mjs";
import { ICommand, IVeExecuteMessage } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";

const dummyVE: IVEContext = { host: "localhost", port: 22 } as IVEContext;
let env: TestEnvironment;

beforeAll(() => {
  env = createTestEnvironment(import.meta.url, { jsonIncludePatterns: [] });
  env.initPersistence({ enableCache: false });
});

afterAll(() => {
  env.cleanup();
});

describe("rollbackTarget", () => {
  const started = new Map<string, unknown>([
    ["started", "true"],
    ["vm_id", "616"],
  ]);

  it("liefert das Paar, wenn NEW gestartet wurde und es einen Vorgaenger gibt", () => {
    expect(rollbackTarget({ previous_vm_id: 615 }, started)).toEqual({ newVmid: 616, oldVmid: 615 });
  });

  it("nichts ohne Vorgaenger, ohne Start, bei gleicher VMID oder Switchover", () => {
    expect(rollbackTarget({}, started)).toBeUndefined();
    expect(rollbackTarget({ previous_vm_id: "NOT_DEFINED" }, started)).toBeUndefined();
    expect(rollbackTarget({ previous_vm_id: 615 }, new Map([["vm_id", "616"]]))).toBeUndefined();
    expect(rollbackTarget({ previous_vm_id: 616 }, started)).toBeUndefined();
    const sw = new Map(started);
    sw.set("switchover_scheduled", "true");
    expect(rollbackTarget({ previous_vm_id: 615 }, sw)).toBeUndefined();
  });

  it("nimmt nur positive ganze Zahlen als VMID", () => {
    expect(parseVmid("615")).toBe(615);
    expect(parseVmid(615)).toBe(615);
    expect(parseVmid("615; rm -rf /")).toBeUndefined();
    expect(parseVmid("0")).toBeUndefined();
    expect(parseVmid(undefined)).toBeUndefined();
  });

  it("Skript schreibt auf stdout nur JSON und leitet nie stderr um", () => {
    const script = buildRollbackScript(616, 615);
    expect(script).toContain("NEW=616");
    expect(script).toContain("OLD=615");
    expect(script).not.toContain("2>&1");
  });
});

describe("VeExecution: Rueckweg nach gescheiterter Ersetzung", () => {
  class Exec extends VeExecution {
    public scripts: string[] = [];
    protected async runOnVeHost(input: string, tmplCommand: ICommand): Promise<IVeExecuteMessage> {
      this.scripts.push(input);
      if (tmplCommand.name === "post_start") throw new Error("heimvio.sh up failed");
      // lxc-start.sh meldet den Start als JSON auf stdout.
      const result =
        tmplCommand.name === "start"
          ? '[{"id":"started","value":"true"},{"id":"vm_id","value":"616"}]'
          : "[]";
      return { stderr: "", result, exitCode: 0, command: tmplCommand.name, index: 0 };
    }
  }

  const commands = (): ICommand[] => [
    {
      name: "start",
      command: `echo '[{"id":"started","value":"true"},{"id":"vm_id","value":"616"}]'`,
      execute_on: "ve",
    },
    { name: "post_start", command: "false", execute_on: "ve" },
    { name: "replace_ct", command: "echo replaced", execute_on: "ve" },
  ];

  it("stoppt NEW und stellt OLD wieder her, wenn ein Schritt nach dem Start scheitert", async () => {
    const exec = new Exec(commands(), [{ id: "previous_vm_id", value: 615 }], dummyVE, new Map(), undefined, ExecutionMode.TEST);
    await exec.run().catch(() => undefined);
    const rollback = exec.scripts.filter((s) => s.includes("=== Rollback"));
    expect(rollback).toHaveLength(1);
    expect(rollback[0]).toContain("NEW=616");
    expect(rollback[0]).toContain("OLD=615");
    expect(exec.scripts.some((s) => s.includes("echo replaced"))).toBe(false);
  });

  it("kein Rueckweg ohne Vorgaenger (Neuinstallation)", async () => {
    const exec = new Exec(commands(), [], dummyVE, new Map(), undefined, ExecutionMode.TEST);
    await exec.run().catch(() => undefined);
    expect(exec.scripts.some((s) => s.includes("=== Rollback"))).toBe(false);
  });
});

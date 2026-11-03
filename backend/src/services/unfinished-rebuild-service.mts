import { ContextManager } from "../context-manager.mjs";
import { IVEContext } from "../backend-types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand, IUnfinishedRebuild, IVeExecuteMessage } from "../types.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("unfinished-rebuild");

/**
 * Unfinished rebuilds: a reconfigure/upgrade clones the source container and
 * replaces it only at the end (900-replace-ct). A task that stops in between
 * leaves the new container next to an unreplaced source — both running, and
 * invisible to the replaced-container cleanup. create-ct-clone.sh tags the new
 * container (proxvex-rebuild-of-<source>), replace-ct.sh removes the tag.
 *
 * - pauseAfterFailure: the failed task's new container is stopped, the source
 *   keeps serving (host-pause-unfinished-rebuild.sh).
 * - resumeForRestart: a task restart past the start phase starts it again.
 * - list / finish / discard: the maintenance UI resolves what is left.
 */
export class UnfinishedRebuildService {
  constructor(private contextManager: ContextManager) {}

  async listAll(): Promise<IUnfinishedRebuild[]> {
    const out: IUnfinishedRebuild[] = [];
    for (const veKey of this.contextManager
      .keys()
      .filter((k) => k.startsWith("ve_"))) {
      const veContext = this.contextManager.getVEContextByKey(veKey);
      if (!veContext) continue;
      const veHost = veContext.host || veKey.replace(/^ve_/, "");
      try {
        const outputs = await runHostScript(
          veContext,
          "host-list-unfinished-rebuilds.py",
          "list",
          ["lxc_config_parser_lib.py"],
          [],
          ["unfinished_rebuilds"],
        );
        const raw = outputs.get("unfinished_rebuilds");
        if (typeof raw !== "string" || raw.trim().length === 0) continue;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        for (const r of parsed) out.push({ ...r, ve_host: veHost });
      } catch (err: any) {
        logger.warn(`Listing unfinished rebuilds failed for ${veHost}`, {
          error: err?.message,
        });
      }
    }
    return out;
  }

  /** The new container takes over; the source is marked replaced. */
  async finish(veHost: string, vmId: number, sourceVmId: number): Promise<void> {
    await this.runAction(
      veHost,
      "host-finish-unfinished-rebuild.sh",
      vmId,
      sourceVmId,
    );
    logger.info(`Finished rebuild ${sourceVmId} -> ${vmId}@${veHost}`);
  }

  /** The new container is destroyed; the source serves again. */
  async discard(veHost: string, vmId: number, sourceVmId: number): Promise<void> {
    await this.runAction(
      veHost,
      "host-discard-unfinished-rebuild.sh",
      vmId,
      sourceVmId,
    );
    logger.info(`Discarded rebuild ${sourceVmId} -> ${vmId}@${veHost}`);
  }

  private async runAction(
    veHost: string,
    script: string,
    vmId: number,
    sourceVmId: number,
  ): Promise<void> {
    const veContext = this.contextManager.getVEContextByKey(`ve_${veHost}`);
    if (!veContext) throw new Error(`VE context not found: ${veHost}`);
    await runHostScript(
      veContext,
      script,
      "maintenance",
      ["pve-common.sh", "vol-common.sh"],
      [
        { id: "vm_id", value: String(vmId) },
        { id: "previous_vm_id", value: String(sourceVmId) },
      ],
      [],
    );
  }
}

/**
 * Called when a task fails. Only acts when the task got as far as cloning
 * (vm_id differs from previous_vm_id); the script itself checks the rebuild
 * tag and that the source is running. Never throws.
 */
export async function pauseUnfinishedRebuild(
  veContext: IVEContext,
  vmId: string,
): Promise<void> {
  try {
    await runHostScript(
      veContext,
      "host-pause-unfinished-rebuild.sh",
      "maintenance",
      ["pve-common.sh", "vol-common.sh"],
      [{ id: "vm_id", value: vmId }],
      [],
    );
  } catch (err: any) {
    logger.warn(`Pausing unfinished rebuild ${vmId} failed`, {
      error: err?.message,
    });
  }
}

/** Counterpart of pauseUnfinishedRebuild before a task restart. */
export async function resumeUnfinishedRebuild(
  veContext: IVEContext,
  vmId: string,
): Promise<void> {
  await runHostScript(
    veContext,
    "host-resume-unfinished-rebuild.sh",
    "maintenance",
    ["pve-common.sh", "vol-common.sh"],
    [{ id: "vm_id", value: vmId }],
    [],
  );
}

/**
 * Run one shared host script on the VE. Throws with the script's last
 * "Error: ..." line (or its last stderr line) when it fails.
 */
async function runHostScript(
  veContext: IVEContext,
  script: string,
  category: string,
  libraries: string[],
  inputs: { id: string; value: string }[],
  outputs: string[],
): Promise<Map<string, string | number | boolean>> {
  const repositories = PersistenceManager.getInstance().getRepositories();
  const scriptContent = repositories.getScript({
    name: script,
    scope: "shared",
    category,
  });
  const libraryContents = libraries.map((name) =>
    repositories.getScript({ name, scope: "shared", category: "library" }),
  );
  if (!scriptContent || libraryContents.some((c) => !c)) {
    throw new Error(`${script} or its libraries not found`);
  }

  const cmd: ICommand = {
    name: script,
    execute_on: "ve",
    script,
    scriptContent,
    libraryContent: libraryContents.join("\n\n"),
    outputs,
  };
  const ve = new VeExecution(
    [cmd],
    inputs,
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  let failure: string | undefined;
  ve.on("message", (msg: IVeExecuteMessage) => {
    if (!msg.partial && msg.exitCode !== 0 && msg.command !== "Failed") {
      failure = msg.stderr;
    }
  });
  const result = await ve.run(null);
  if (result?.lastSuccessfull !== 0) {
    const lines = (failure ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const errorLine =
      [...lines].reverse().find((l) => l.startsWith("Error:")) ?? lines.at(-1);
    throw new Error(errorLine ?? `${script} failed`);
  }
  return ve.outputs;
}

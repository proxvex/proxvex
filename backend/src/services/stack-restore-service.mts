import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand, IStacktypeVariable } from "../types.mjs";
import { IVEContext } from "../backend-types.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("stack-restore");

export interface IStackRestoreRequest {
  stacktype: string | string[];
  name: string;
}

export interface IStackRestoreEntry {
  name: string;
  value: string;
  status: "unique" | "missing";
  sources: string[];
}

export interface IStackRestoreConflict {
  name: string;
  values: { value: string; sources: string[] }[];
}

export interface IStackRestoreResponse {
  stack_id: string;
  entries: IStackRestoreEntry[];
  conflicts: IStackRestoreConflict[];
  errors: string[];
  sources_scanned: number;
}

interface ScanResult {
  containers: {
    vm_id: number;
    hostname: string;
    values: Record<string, { value: string; source: "lxc" | "compose" }>;
  }[];
  errors: string[];
}

export class StackRestoreService {
  constructor(private contextManager: ContextManager) {}

  async scanForRestore(req: IStackRestoreRequest): Promise<IStackRestoreResponse> {
    const stackId = computeStackId(req.stacktype, req.name);
    const stacktypeNames = Array.isArray(req.stacktype) ? req.stacktype : [req.stacktype];

    const pm = PersistenceManager.getInstance();
    const allStacktypes = pm.getStacktypes();
    const wantedVars: IStacktypeVariable[] = [];
    const seen = new Set<string>();
    for (const typeName of stacktypeNames) {
      const def = allStacktypes.find((st) => st.name === typeName);
      if (!def) continue;
      for (const v of def.entries) {
        if (seen.has(v.name)) continue;
        seen.add(v.name);
        wantedVars.push(v);
      }
    }

    if (wantedVars.length === 0) {
      return {
        stack_id: stackId,
        entries: [],
        conflicts: [],
        errors: [`Stacktype '${stacktypeNames.join(",")}' has no variables defined`],
        sources_scanned: 0,
      };
    }

    const veContextKeys = this.contextManager
      .keys()
      .filter((k) => k.startsWith("ve_"));

    const perVarValues = new Map<string, Map<string, string[]>>();
    const aggregatedErrors: string[] = [];
    let sourcesScanned = 0;

    for (const veKey of veContextKeys) {
      const veContext = this.contextManager.getVEContextByKey(veKey);
      if (!veContext) continue;

      let scan: ScanResult;
      try {
        scan = await this.runScanOnContext(veContext, stackId, wantedVars.map((v) => v.name));
      } catch (err: any) {
        logger.warn(`stack-restore scan failed on ${veKey}`, { error: err?.message });
        aggregatedErrors.push(`Scan failed on ${veContext.host}: ${err?.message || String(err)}`);
        continue;
      }

      aggregatedErrors.push(...scan.errors);

      for (const container of scan.containers) {
        sourcesScanned += 1;
        const sourceLabel = `vm ${container.vm_id} (${container.hostname}@${veContext.host})`;
        for (const [varName, entry] of Object.entries(container.values)) {
          let byValue = perVarValues.get(varName);
          if (!byValue) {
            byValue = new Map();
            perVarValues.set(varName, byValue);
          }
          let sources = byValue.get(entry.value);
          if (!sources) {
            sources = [];
            byValue.set(entry.value, sources);
          }
          sources.push(sourceLabel);
        }
      }
    }

    const entries: IStackRestoreEntry[] = [];
    const conflicts: IStackRestoreConflict[] = [];

    for (const v of wantedVars) {
      const byValue = perVarValues.get(v.name);
      if (!byValue || byValue.size === 0) {
        entries.push({ name: v.name, value: "", status: "missing", sources: [] });
        continue;
      }
      if (byValue.size > 1) {
        conflicts.push({
          name: v.name,
          values: Array.from(byValue.entries()).map(([value, sources]) => ({ value, sources })),
        });
        continue;
      }
      const first = Array.from(byValue.entries())[0];
      if (!first) {
        entries.push({ name: v.name, value: "", status: "missing", sources: [] });
        continue;
      }
      const [value, sources] = first;
      entries.push({ name: v.name, value, status: "unique", sources });
    }

    return {
      stack_id: stackId,
      entries,
      conflicts,
      errors: aggregatedErrors,
      sources_scanned: sourcesScanned,
    };
  }

  private async runScanOnContext(
    veContext: IVEContext,
    stackId: string,
    varNames: string[],
  ): Promise<ScanResult> {
    const pm = PersistenceManager.getInstance();
    const repositories = pm.getRepositories();

    const scriptContent = repositories.getScript({
      name: "find-stack-values-on-apps.py",
      scope: "shared",
      category: "list",
    });
    if (!scriptContent) {
      throw new Error("find-stack-values-on-apps.py not found");
    }
    const libraryContent = repositories.getScript({
      name: "lxc_config_parser_lib.py",
      scope: "shared",
      category: "library",
    });
    if (!libraryContent) {
      throw new Error("lxc_config_parser_lib.py not found");
    }

    const substituted = scriptContent
      .replace(/\{\{\s*stack_id\s*\}\}/g, stackId)
      .replace(/\{\{\s*var_names\s*\}\}/g, varNames.join("\n"));

    const cmd: ICommand = {
      name: "Find Stack Values on Apps",
      execute_on: "ve",
      script: "find-stack-values-on-apps.py",
      scriptContent: substituted,
      libraryContent,
      outputs: ["scan_results"],
    };

    const ve = new VeExecution(
      [cmd],
      [],
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );
    await ve.run(null);

    const raw = ve.outputs.get("scan_results");
    if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
      return { containers: [], errors: [] };
    }
    const parsed = JSON.parse(raw);
    return {
      containers: Array.isArray(parsed?.containers) ? parsed.containers : [],
      errors: Array.isArray(parsed?.errors) ? parsed.errors : [],
    };
  }
}

export function computeStackId(stacktype: string | string[], name: string): string {
  const prefix = Array.isArray(stacktype) ? [...stacktype].sort().join("_") : stacktype;
  return `${prefix}_${name}`;
}

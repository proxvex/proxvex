import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand, IStackUsage, IStackUsageVar, IStacktypeVariable } from "../types.mjs";
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

export interface IStackRestoreDependency {
  canonical: string;
  alias: string;
  source: string;
  replacement?: string;
}

export interface IStackRestoreResponse {
  stack_id: string;
  entries: IStackRestoreEntry[];
  conflicts: IStackRestoreConflict[];
  errors: string[];
  sources_scanned: number;
  /**
   * Dependency-analysis trace: for each canonical stack variable, lists
   * the aliases under which it may appear on the target (from stacktype
   * itself and from any application/addon `stack_usage` declaration).
   * Used by the UI and logs to make the alias resolution inspectable.
   */
  dependency_trace: IStackRestoreDependency[];
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
        dependency_trace: [],
      };
    }

    // Build a mapping from each canonical stack-variable name to all aliases
    // under which it may actually appear on the target (e.g. CF_TOKEN on the
    // stack-side maps to CF_API_TOKEN inside acme-renew.sh). The scan needs
    // to look for every alias; results are translated back to canonical names.
    const {
      aliasToCanonical,
      allSearchNames,
      dependencyTrace,
      consumerApps,
      consumerAddons,
    } = buildAliasIndex(pm, stacktypeNames, wantedVars);
    logger.info("Stack-restore dependency analysis", {
      stack_id: stackId,
      stacktypes: stacktypeNames,
      canonical_vars: wantedVars.map((v) => v.name),
      search_names: allSearchNames,
      aliases: dependencyTrace
        .filter((d) => d.alias !== d.canonical)
        .map((d) => `${d.canonical}←${d.alias} (${d.source}${d.replacement ? `, ${d.replacement}` : ""})`),
      consumer_apps: consumerApps,
      consumer_addons: consumerAddons,
    });

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
        scan = await this.runScanOnContext(veContext, stackId, allSearchNames, consumerApps, consumerAddons);
      } catch (err: any) {
        logger.warn(`stack-restore scan failed on ${veKey}`, { error: err?.message });
        aggregatedErrors.push(`Scan failed on ${veContext.host}: ${err?.message || String(err)}`);
        continue;
      }

      aggregatedErrors.push(...scan.errors);

      for (const container of scan.containers) {
        sourcesScanned += 1;
        const sourceLabel = `vm ${container.vm_id} (${container.hostname}@${veContext.host})`;
        for (const [foundName, entry] of Object.entries(container.values)) {
          // Translate alias to canonical: the scan may have found CF_API_TOKEN,
          // the stack stores it under CF_TOKEN.
          const canonical = aliasToCanonical.get(foundName) ?? foundName;
          let byValue = perVarValues.get(canonical);
          if (!byValue) {
            byValue = new Map();
            perVarValues.set(canonical, byValue);
          }
          let sources = byValue.get(entry.value);
          if (!sources) {
            sources = [];
            byValue.set(entry.value, sources);
          }
          sources.push(
            foundName === canonical
              ? sourceLabel
              : `${sourceLabel} [as ${foundName}]`,
          );
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
      dependency_trace: dependencyTrace,
    };
  }

  private async runScanOnContext(
    veContext: IVEContext,
    stackId: string,
    varNames: string[],
    consumerApps: string[],
    consumerAddons: string[],
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
      .replace(/\{\{\s*var_names\s*\}\}/g, varNames.join("\n"))
      .replace(/\{\{\s*consumer_apps\s*\}\}/g, consumerApps.join(","))
      .replace(/\{\{\s*consumer_addons\s*\}\}/g, consumerAddons.join(","));

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

/**
 * For each canonical stack-variable, enumerate every alias under which the
 * value might appear on the target. Example: the `cloudflare` stacktype
 * defines `CF_TOKEN`, but `addon-acme` writes it as `CF_API_TOKEN` into
 * `acme-renew.sh`. The scan must look for both names.
 *
 * Walks all applications and addons, collects their `stack_usage` decls,
 * and for any var matching one of the requested stacktypes, records the
 * on-target variable name (`script_var` / `lxc_var_name` / `compose_key`)
 * as an alias of the canonical `name`.
 */
function buildAliasIndex(
  pm: PersistenceManager,
  stacktypeNames: string[],
  wantedVars: IStacktypeVariable[],
): {
  aliasToCanonical: Map<string, string>;
  allSearchNames: string[];
  dependencyTrace: IStackRestoreDependency[];
  consumerApps: string[];
  consumerAddons: string[];
} {
  const stacktypeSet = new Set(stacktypeNames);
  const aliasToCanonical = new Map<string, string>();
  const searchSet = new Set<string>();
  const trace: IStackRestoreDependency[] = [];
  const consumerApps = new Set<string>();
  const consumerAddons = new Set<string>();
  const traceSeen = new Set<string>();
  const addTrace = (
    canonical: string,
    alias: string,
    source: string,
    replacement?: string,
  ) => {
    const key = `${canonical}|${alias}|${source}`;
    if (traceSeen.has(key)) return;
    traceSeen.add(key);
    const entry: IStackRestoreDependency = { canonical, alias, source };
    if (replacement) entry.replacement = replacement;
    trace.push(entry);
  };

  // Register the canonical names as their own aliases.
  for (const v of wantedVars) {
    aliasToCanonical.set(v.name, v.name);
    searchSet.add(v.name);
    addTrace(v.name, v.name, `stacktype:${stacktypeNames.join(",")}`);
  }

  const collect = (
    sourceLabel: string,
    usageList: IStackUsage[] | undefined,
    sourceKind: "app" | "addon" | "stacktype",
    sourceId: string,
  ) => {
    if (!usageList) return;
    for (const usage of usageList) {
      if (!stacktypeSet.has(usage.stacktype)) continue;
      if (sourceKind === "app") consumerApps.add(sourceId);
      if (sourceKind === "addon") consumerAddons.add(sourceId);
      for (const v of usage.vars) {
        const canonical = v.name;
        const targetNames = collectTargetNames(v);
        if (!aliasToCanonical.has(canonical)) {
          aliasToCanonical.set(canonical, canonical);
          searchSet.add(canonical);
        }
        addTrace(canonical, canonical, sourceLabel, v.replacement);
        for (const alias of targetNames) {
          if (!aliasToCanonical.has(alias)) {
            aliasToCanonical.set(alias, canonical);
            searchSet.add(alias);
          }
          addTrace(canonical, alias, sourceLabel, v.replacement);
        }
      }
    }
  };

  const repositories = pm.getRepositories();
  try {
    for (const entry of repositories.listApplications()) {
      try {
        const app = repositories.getApplication(entry.id);
        collect(`app:${entry.id}`, app.stack_usage, "app", entry.id);
      } catch {
        /* ignore individual application load failures */
      }
    }
  } catch (err: any) {
    logger.warn("Failed to enumerate applications for alias index", { error: err?.message });
  }

  try {
    const addonService = pm.getAddonService();
    const addons = addonService.getAllAddons?.() ?? [];
    if (addons.length === 0) {
      logger.warn("Alias index: getAllAddons() returned 0 addons — alias resolution will miss addon-provided aliases");
    }
    for (const addon of addons) {
      const id = (addon as { id?: string }).id ?? "unknown-addon";
      collect(`addon:${id}`, (addon as { stack_usage?: IStackUsage[] }).stack_usage, "addon", id);
    }
  } catch (err: any) {
    logger.warn("Failed to enumerate addons for alias index", { error: err?.message });
  }

  return {
    aliasToCanonical,
    allSearchNames: Array.from(searchSet),
    dependencyTrace: trace,
    consumerApps: Array.from(consumerApps),
    consumerAddons: Array.from(consumerAddons),
  };
}

function collectTargetNames(v: IStackUsageVar): string[] {
  const names: string[] = [];
  if (v.script_var && v.script_var !== v.name) names.push(v.script_var);
  if (v.lxc_var_name && v.lxc_var_name !== v.name) names.push(v.lxc_var_name);
  if (v.compose_key && v.compose_key !== v.name) names.push(v.compose_key);
  return names;
}

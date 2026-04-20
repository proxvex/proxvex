import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import type {
  IStackUsage,
  IStackUsageVar,
  IManagedOciContainer,
  IStack,
  IAddon,
  StackRefreshMethod,
  ICommand,
} from "../types.mjs";
import type { IApplication, IVEContext } from "../backend-types.mjs";
import { listManagedContainers } from "./container-list-service.mjs";
import { normalizeStacktype } from "../types.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";

/**
 * A single refresh action bound to one container/instance.
 * Produced during discovery, consumed during execution.
 */
export interface IStackRefreshAction {
  /** Container info for identification */
  vmId: number;
  hostname: string;
  applicationId: string;
  /** Where the declaration came from */
  source:
    | { kind: "application"; applicationId: string }
    | { kind: "addon"; addonId: string };
  /** The stack property being refreshed */
  stacktype: string;
  varName: string;
  /** Replacement method and its parameters */
  replacement: StackRefreshMethod;
  composeKey?: string;
  lxcVarName?: string;
  script?: string;
  scriptVar?: string;
  template?: string;
  description?: string;
  check?: string;
}

export interface IStackRefreshPreview {
  stackId: string;
  stacktype: string;
  varName: string;
  /** Actions grouped per container */
  targets: Array<{
    vmId: number;
    hostname: string;
    applicationId: string;
    status: "running" | "stopped" | "unknown";
    actions: IStackRefreshAction[];
  }>;
}

export interface IStackRefreshExecutionResult {
  timestamp: string;
  stackId: string;
  varName: string;
  oldValueHash: string;
  newValueHash: string;
  actions: Array<{
    vmId: number;
    hostname: string;
    source: IStackRefreshAction["source"];
    replacement: StackRefreshMethod;
    status: "ok" | "error" | "skipped";
    detail?: string;
  }>;
}

/**
 * Merges stack_usage declarations of an application and its active addons
 * into a flat list of refresh actions for a given container.
 */
export function buildActionsForContainer(
  container: IManagedOciContainer,
  application: IApplication | null,
  addons: IAddon[],
  stacktype: string,
  varName?: string,
): IStackRefreshAction[] {
  const actions: IStackRefreshAction[] = [];

  const pushFromUsage = (
    usage: IStackUsage[],
    source: IStackRefreshAction["source"],
  ) => {
    for (const u of usage) {
      if (u.stacktype !== stacktype) continue;
      for (const v of u.vars) {
        if (varName !== undefined && v.name !== varName) continue;
        actions.push(usageVarToAction(v, source, container, stacktype));
      }
    }
  };

  if (application?.stack_usage) {
    pushFromUsage(application.stack_usage, {
      kind: "application",
      applicationId: application.id,
    });
  }
  for (const addon of addons) {
    if (!addon.stack_usage) continue;
    pushFromUsage(addon.stack_usage, { kind: "addon", addonId: addon.id });
  }

  return actions;
}

function usageVarToAction(
  v: IStackUsageVar,
  source: IStackRefreshAction["source"],
  container: IManagedOciContainer,
  stacktype: string,
): IStackRefreshAction {
  const replacement: StackRefreshMethod = v.replacement ?? "manual";
  const action: IStackRefreshAction = {
    vmId: container.vm_id,
    hostname: container.hostname ?? "",
    applicationId: container.application_id ?? "",
    source,
    stacktype,
    varName: v.name,
    replacement,
  };
  if (v.compose_key !== undefined) action.composeKey = v.compose_key;
  if (v.lxc_var_name !== undefined) action.lxcVarName = v.lxc_var_name;
  if (v.script !== undefined) action.script = v.script;
  if (v.script_var !== undefined) action.scriptVar = v.script_var;
  if (v.template !== undefined) action.template = v.template;
  if (v.description !== undefined) action.description = v.description;
  if (v.check !== undefined) action.check = v.check;
  return action;
}

/**
 * Discovery: for a given stack + optional variable, enumerates all installed
 * containers that declare usage and produces a preview of refresh actions.
 *
 * Requires a VE context to query `listManagedContainers`. Assumes a single
 * stack binding per container via `stack_name` (today's data model) — future
 * work may expand to per-stacktype bindings.
 */
export async function findRefreshTargets(
  pm: PersistenceManager,
  veContext: IVEContext,
  stack: IStack,
  varName?: string,
  vmIdFilter?: number,
): Promise<IStackRefreshPreview> {
  const containers = await listManagedContainers(pm, veContext);
  const repositories = pm.getRepositories();
  const addonService = pm.getAddonService();
  const stacktypeNames = normalizeStacktype(stack.stacktype);

  const targets: IStackRefreshPreview["targets"] = [];

  for (const container of containers) {
    if (!container.application_id) continue;
    if (vmIdFilter !== undefined && container.vm_id !== vmIdFilter) continue;
    // Match stack binding: today only the single-primary stack_name exists.
    // Include containers that either bind this stack directly, or that have
    // an application whose stacktype list contains one of the stack's types.
    const declares = declaredStacktypes(
      container,
      repositories,
      addonService,
    );
    const relevantStacktypes = stacktypeNames.filter((st) =>
      declares.includes(st),
    );
    if (relevantStacktypes.length === 0) continue;

    // Optional tighter binding: if container has a stack_name and it is not
    // our stack id, skip. This errs on the safe side.
    if (
      container.stack_name &&
      container.stack_name !== stack.id &&
      !stacktypeSharedWithOtherStack(container.stack_name, stack, pm)
    ) {
      // container already bound to a different stack of a different type — keep
    }

    // Load application + active addons
    let application: IApplication | null = null;
    try {
      application = repositories.getApplication(container.application_id);
    } catch {
      application = null;
    }
    const activeAddons: IAddon[] = [];
    for (const addonId of container.addons ?? []) {
      try {
        const addon = addonService.getAddon(addonId);
        if (addon) activeAddons.push(addon);
      } catch {
        // ignore missing addon
      }
    }

    // Build actions per matching stacktype
    const actions: IStackRefreshAction[] = [];
    for (const st of relevantStacktypes) {
      actions.push(
        ...buildActionsForContainer(
          container,
          application,
          activeAddons,
          st,
          varName,
        ),
      );
    }
    if (actions.length === 0) continue;

    targets.push({
      vmId: container.vm_id,
      hostname: container.hostname ?? "",
      applicationId: container.application_id,
      status:
        container.status === "running"
          ? "running"
          : container.status === "stopped"
            ? "stopped"
            : "unknown",
      actions,
    });
  }

  return {
    stackId: stack.id,
    stacktype: stacktypeNames.join(","),
    varName: varName ?? "*",
    targets,
  };
}

/**
 * Returns the list of stacktypes an installed container's application or
 * addons declare (via application.stacktype / addon.stacktype).
 */
function declaredStacktypes(
  container: IManagedOciContainer,
  repositories: ReturnType<PersistenceManager["getRepositories"]>,
  addonService: ReturnType<PersistenceManager["getAddonService"]>,
): string[] {
  const out = new Set<string>();
  if (!container.application_id) return [];
  try {
    const app = repositories.getApplication(container.application_id);
    normalizeStacktype(app.stacktype).forEach((s) => out.add(s));
  } catch {
    /* ignore */
  }
  for (const addonId of container.addons ?? []) {
    try {
      const addon = addonService.getAddon(addonId);
      if (!addon) continue;
      normalizeStacktype(addon.stacktype).forEach((s) => out.add(s));
    } catch {
      /* ignore */
    }
  }
  return Array.from(out);
}

/**
 * Guard used in filter: if the container is bound to a different stack but
 * the two stacks share a stacktype, we cannot safely conclude they are unrelated.
 * For now always return false (safe default: do not skip).
 */
function stacktypeSharedWithOtherStack(
  _boundStackId: string,
  _targetStack: IStack,
  _pm: PersistenceManager,
): boolean {
  return false;
}

/**
 * Utility: sha256 hash a string (hex). Used for audit logs.
 */
export async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Executes all refresh actions of a preview, returning a structured result.
 * Runs actions sequentially to avoid racing concurrent pct commands.
 */
export async function executeRefresh(
  pm: PersistenceManager,
  veContext: IVEContext,
  preview: IStackRefreshPreview,
  newValue: string,
  oldValue: string,
): Promise<IStackRefreshExecutionResult> {
  const result: IStackRefreshExecutionResult = {
    timestamp: new Date().toISOString(),
    stackId: preview.stackId,
    varName: preview.varName,
    oldValueHash: await sha256Hex(oldValue),
    newValueHash: await sha256Hex(newValue),
    actions: [],
  };

  for (const target of preview.targets) {
    for (const action of target.actions) {
      const entry = {
        vmId: action.vmId,
        hostname: action.hostname,
        source: action.source,
        replacement: action.replacement,
      };
      try {
        const status = await executeAction(
          pm,
          veContext,
          target,
          action,
          newValue,
        );
        const actionResult: IStackRefreshExecutionResult["actions"][number] = {
          ...entry,
          status: status.ok ? "ok" : status.skipped ? "skipped" : "error",
        };
        if (status.detail !== undefined) actionResult.detail = status.detail;
        result.actions.push(actionResult);
      } catch (err: any) {
        result.actions.push({
          ...entry,
          status: "error",
          detail: err?.message ?? String(err),
        });
      }
    }
  }

  return result;
}

interface IActionStatus {
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

async function executeAction(
  pm: PersistenceManager,
  veContext: IVEContext,
  target: IStackRefreshPreview["targets"][number],
  action: IStackRefreshAction,
  newValue: string,
): Promise<IActionStatus> {
  switch (action.replacement) {
    case "manual":
      return { ok: true, skipped: true, detail: "manual — user action required" };
    case "no-action":
      return { ok: true, skipped: true, detail: "no action required" };
    case "compose-env":
      return await runComposeEnv(pm, veContext, target, action, newValue);
    case "lxc-config-env":
      return await runLxcConfigEnv(pm, veContext, target, action, newValue);
    case "on-start-env":
      return await runOnStartScriptEnv(pm, veContext, target, action, newValue);
    case "rerun-template":
      return {
        ok: false,
        detail:
          "rerun-template is deprecated for v1 — use on-start-env or manual",
      };
    default:
      return { ok: false, detail: `unknown replacement: ${action.replacement}` };
  }
}

async function runComposeEnv(
  pm: PersistenceManager,
  veContext: IVEContext,
  target: IStackRefreshPreview["targets"][number],
  action: IStackRefreshAction,
  newValue: string,
): Promise<IActionStatus> {
  if (!action.composeKey) {
    return { ok: false, detail: "compose-env: missing compose_key" };
  }
  const repositories = pm.getRepositories();
  const scriptContent = repositories.getScript({
    name: "refresh-compose-env.sh",
    scope: "shared",
    category: "refresh",
  });
  if (!scriptContent) {
    return { ok: false, detail: "script refresh-compose-env.sh not found" };
  }
  const pveCommon = repositories.getScript({
    name: "pve-common.sh",
    scope: "shared",
    category: "library",
  });
  const veGlobal = repositories.getScript({
    name: "ve-global.sh",
    scope: "shared",
    category: "library",
  });
  const libraryContent = [veGlobal ?? "", pveCommon ?? ""].join("\n");

  // Retrieve compose_project from container (default: hostname-based)
  const composeProject = await resolveComposeProject(target);

  const substituted = substituteMarkers(scriptContent, {
    vm_id: String(target.vmId),
    hostname: target.hostname,
    compose_project: composeProject,
    compose_key: action.composeKey,
    new_value: newValue,
  });

  const cmd: ICommand = {
    name: `refresh compose-env ${action.varName}`,
    execute_on: "ve",
    script: "refresh-compose-env.sh",
    scriptContent: substituted,
    libraryContent,
    outputs: [
      "refresh_status",
      "refresh_compose_file",
      "refresh_restarted",
      "refresh_detail",
    ],
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
  const status = String(ve.outputs.get("refresh_status") ?? "error");
  if (status === "ok") {
    const restarted = ve.outputs.get("refresh_restarted");
    const composeFile = String(ve.outputs.get("refresh_compose_file") ?? "");
    const fallbackDetail = String(ve.outputs.get("refresh_detail") ?? "");
    return {
      ok: true,
      detail: fallbackDetail
        ? fallbackDetail
        : restarted === "true"
          ? `patched ${action.composeKey} in ${composeFile} — container restarted`
          : `patched ${action.composeKey} in ${composeFile} (container was stopped; new value active on next start)`,
    };
  }
  return {
    ok: false,
    detail: String(ve.outputs.get("refresh_detail") ?? "unknown error"),
  };
}

async function runLxcConfigEnv(
  pm: PersistenceManager,
  veContext: IVEContext,
  target: IStackRefreshPreview["targets"][number],
  action: IStackRefreshAction,
  newValue: string,
): Promise<IActionStatus> {
  const lxcVarName = action.lxcVarName ?? action.varName;
  const repositories = pm.getRepositories();
  const scriptContent = repositories.getScript({
    name: "refresh-lxc-config-env.sh",
    scope: "shared",
    category: "refresh",
  });
  if (!scriptContent) {
    return { ok: false, detail: "script refresh-lxc-config-env.sh not found" };
  }

  const substituted = substituteMarkers(scriptContent, {
    vm_id: String(target.vmId),
    lxc_var_name: lxcVarName,
    new_value: newValue,
  });

  const cmd: ICommand = {
    name: `refresh lxc-config-env ${action.varName}`,
    execute_on: "ve",
    script: "refresh-lxc-config-env.sh",
    scriptContent: substituted,
    outputs: ["refresh_status", "refresh_needs_restart", "refresh_detail"],
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
  const status = String(ve.outputs.get("refresh_status") ?? "error");
  if (status === "ok") {
    const needsRestart = ve.outputs.get("refresh_needs_restart");
    return {
      ok: true,
      detail:
        needsRestart === "true"
          ? "patched — container restart needed"
          : "patched",
    };
  }
  return {
    ok: false,
    detail: String(ve.outputs.get("refresh_detail") ?? "unknown error"),
  };
}

async function runOnStartScriptEnv(
  pm: PersistenceManager,
  veContext: IVEContext,
  target: IStackRefreshPreview["targets"][number],
  action: IStackRefreshAction,
  newValue: string,
): Promise<IActionStatus> {
  if (!action.script) {
    return { ok: false, detail: "on-start-env: missing script" };
  }
  const scriptVar = action.scriptVar ?? action.varName;

  const repositories = pm.getRepositories();
  const scriptContent = repositories.getScript({
    name: "refresh-on-start-env.sh",
    scope: "shared",
    category: "refresh",
  });
  if (!scriptContent) {
    return {
      ok: false,
      detail: "script refresh-on-start-env.sh not found",
    };
  }
  const pveCommon = repositories.getScript({
    name: "pve-common.sh",
    scope: "shared",
    category: "library",
  });
  const veGlobal = repositories.getScript({
    name: "ve-global.sh",
    scope: "shared",
    category: "library",
  });
  const libraryContent = [veGlobal ?? "", pveCommon ?? ""].join("\n");

  const substituted = substituteMarkers(scriptContent, {
    vm_id: String(target.vmId),
    hostname: target.hostname,
    script: action.script,
    script_var: scriptVar,
    new_value: newValue,
  });

  const cmd: ICommand = {
    name: `refresh on-start-env ${action.varName}`,
    execute_on: "ve",
    script: "refresh-on-start-env.sh",
    scriptContent: substituted,
    libraryContent,
    outputs: ["refresh_status", "refresh_restarted", "refresh_detail"],
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
  const status = String(ve.outputs.get("refresh_status") ?? "error");
  if (status === "ok") {
    const restarted = ve.outputs.get("refresh_restarted");
    const fallbackDetail = String(ve.outputs.get("refresh_detail") ?? "");
    return {
      ok: true,
      detail: fallbackDetail
        ? fallbackDetail
        : restarted === "true"
          ? `patched ${action.script}:${scriptVar} — container restarted`
          : `patched ${action.script}:${scriptVar} (container was stopped; new value active on next start)`,
    };
  }
  return {
    ok: false,
    detail: String(ve.outputs.get("refresh_detail") ?? "unknown error"),
  };
}

/**
 * Substitutes `{{ key }}` markers in the script content with given values.
 * Only used locally — the real VE pipeline substitution handles templating
 * for normal commands, but refresh commands are ad-hoc and need their own
 * simple substitution.
 */
function substituteMarkers(
  content: string,
  values: Record<string, string>,
): string {
  let out = content;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g");
    out = out.replace(re, value);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic: compose_project is usually the container hostname (or derived
 * from it). If more precision is needed later, read it from stored context.
 */
async function resolveComposeProject(
  target: IStackRefreshPreview["targets"][number],
): Promise<string> {
  return target.hostname;
}

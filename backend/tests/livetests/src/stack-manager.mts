/**
 * Stack lifecycle management for live integration tests.
 *
 * Handles stack creation, reuse, cleanup SQL, and stale VM detection.
 * Stacks hold shared passwords between applications in the same deployment
 * (e.g. postgres password shared between postgres and zitadel).
 */

import { nestedSsh } from "./ssh-helpers.mjs";
import type { PlannedScenario } from "./livetest-types.mjs";
import type { SnapshotManager } from "./snapshot-manager.mjs";
import { logOk, logInfo } from "./log-helpers.mjs";

export interface StackMaps {
  stackIdMap: Map<string, string>;
  appStackIdsMap: Map<string, string[]>;
}

/**
 * Run cleanup SQL on reused dependency VMs.
 * E.g. DROP DATABASE for target apps that need a fresh database.
 */
export function runCleanupSql(
  planned: PlannedScenario[],
  pveHost: string,
  sshPort: number,
): void {
  for (const p of planned) {
    if (p.isDependency || !p.scenario.cleanup) continue;
    for (const [depApp, sql] of Object.entries(p.scenario.cleanup)) {
      const depVm = planned.find(d => d.scenario.application === depApp && d.skipExecution);
      if (depVm) {
        logInfo(`Cleanup SQL on ${depApp} (VM ${depVm.vmId}): ${sql}`);
        const sqlParts = sql.split(";").map(s => s.trim()).filter(Boolean);
        const cFlags = sqlParts.map(s => `-c ${JSON.stringify(s)}`).join(" ");
        nestedSsh(pveHost, sshPort,
          `pct exec ${depVm.vmId} -- psql -U postgres ${cFlags}`,
          15000);
      }
    }
  }
}

/**
 * Destroy reused dependency VMs whose stacks are missing from the deployer context.
 * This happens when a VM survives from a previous test run but the deployer context
 * was reset (fresh start or different snapshot).
 */
export async function destroyStaleVms(
  planned: PlannedScenario[],
  pveHost: string,
  sshPort: number,
  apiUrl: string,
  appStacktypes: Map<string, string | string[]>,
  snapMgr?: SnapshotManager,
): Promise<void> {
  let contextRestoreAttempted = false;
  for (const p of planned) {
    if (!p.skipExecution || !p.isDependency) continue;
    const rawSt = appStacktypes.get(p.scenario.application);
    const sts = rawSt ? (Array.isArray(rawSt) ? rawSt : [rawSt]) : [];
    let stackMissing = false;
    for (const st of sts) {
      const sid = `${st}_${p.stackName}`;
      try {
        const r = await fetch(`${apiUrl}/api/stack/${sid}`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) stackMissing = true;
      } catch { stackMissing = true; }
    }
    if (stackMissing) {
      // Stack missing but container is running — context is stale.
      // This happens when a previous failed test run overwrote the deployer context.
      // Try to restore context from the snapshot backup on the nested VM.
      if (!contextRestoreAttempted) {
        contextRestoreAttempted = true;
        logInfo("Stacks missing for running VMs — restoring context from snapshot backup");
        try {
          snapMgr?.restoreContextPublic();
          const reloadResp = await fetch(`${apiUrl}/api/reload`, { method: "POST", signal: AbortSignal.timeout(10000) });
          if (reloadResp.ok) {
            logOk("Context restored and deployer reloaded — rechecking stacks");
            // Recheck this VM's stacks after restore
            stackMissing = false;
            for (const st of sts) {
              const sid = `${st}_${p.stackName}`;
              try {
                const r = await fetch(`${apiUrl}/api/stack/${sid}`, { signal: AbortSignal.timeout(3000) });
                if (!r.ok) stackMissing = true;
              } catch { stackMissing = true; }
            }
          }
        } catch {
          logInfo("Warning: context restore failed");
        }
      }

      if (stackMissing) {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) stack missing — destroying (context mismatch)`);
        nestedSsh(pveHost, sshPort,
          `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
          30000);
        p.skipExecution = false;
      }
    }
  }
}

/**
 * Ensure stacks exist for all planned scenarios.
 * Creates new stacks or reuses existing ones based on VM reuse state.
 */
export async function ensureStacks(
  planned: PlannedScenario[],
  apiUrl: string,
  appStacktypes: Map<string, string | string[]>,
): Promise<StackMaps> {
  const stackIdMap = new Map<string, string>();
  const appStackIdsMap = new Map<string, string[]>();
  const stacksToCreate = new Map<string, { name: string; type: string }>();

  // Fetch addon stacktypes (cached for all scenarios)
  let addonStacktypeCache: Map<string, string | string[]> | undefined;
  try {
    const stResp = await fetch(`${apiUrl}/api/stacktypes`, { signal: AbortSignal.timeout(5000) });
    if (stResp.ok) {
      // Build addon → stacktype map from scenario selectedAddons
      addonStacktypeCache = new Map();
      for (const p of planned) {
        if (p.scenario.selectedAddons) {
          for (const addonId of p.scenario.selectedAddons) {
            if (!addonStacktypeCache.has(addonId)) {
              // Addon stacktypes are named after the addon (e.g. addon-acme → cloudflare)
              // We need to fetch addon info — try from the API
              try {
                // Convention: addon config is at json/addons/<addonId>.json
                // The stacktype is in the addon definition
                // For now, use a simple mapping based on known addons
                const knownAddonStacktypes: Record<string, string> = {
                  "addon-oidc": "oidc",
                  "addon-acme": "cloudflare",
                  "addon-ssl": "",
                  "samba-shares": "",
                };
                const st = knownAddonStacktypes[addonId];
                if (st) addonStacktypeCache.set(addonId, st);
              } catch { /* ignore */ }
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  for (const p of planned) {
    const rawStacktype = appStacktypes.get(p.scenario.application);
    const stacktypes = rawStacktype ? (Array.isArray(rawStacktype) ? rawStacktype : [rawStacktype]) : [];

    // Add addon stacktypes from selectedAddons
    if (addonStacktypeCache && p.scenario.selectedAddons) {
      for (const addonId of p.scenario.selectedAddons) {
        const addonSt = addonStacktypeCache.get(addonId);
        if (addonSt && !stacktypes.includes(addonSt)) {
          stacktypes.push(addonSt);
        }
      }
    }

    if (stacktypes.length === 0) continue;

    const ids: string[] = [];
    for (const st of stacktypes) {
      const stackId = `${st}_${p.stackName}`;
      ids.push(stackId);
      if (!stacksToCreate.has(stackId)) {
        stacksToCreate.set(stackId, { name: p.stackName, type: st });
      }
    }
    stackIdMap.set(p.stackName, ids[0]!);
    appStackIdsMap.set(`${p.scenario.application}/${p.stackName}`, ids);
  }

  for (const [stackId, { name: stackName, type: stacktype }] of stacksToCreate) {
    let stackExists = false;
    try {
      const checkResp = await fetch(`${apiUrl}/api/stack/${stackId}`, {
        signal: AbortSignal.timeout(5000),
      });
      stackExists = checkResp.ok;
    } catch { /* ignore */ }

    if (stackExists) {
      const stackVms = planned.filter(p => {
        const ids = appStackIdsMap.get(`${p.scenario.application}/${p.stackName}`);
        return ids?.includes(stackId);
      });
      const allDestroyed = stackVms.every(p => !p.skipExecution);
      if (allDestroyed) {
        try {
          await fetch(`${apiUrl}/api/stack/${stackId}`, {
            method: "DELETE", signal: AbortSignal.timeout(5000),
          });
        } catch { /* ignore */ }
        stackExists = false;
      } else {
        logOk(`Stack '${stackId}' exists — reusing (passwords unchanged)`);
      }
    }

    if (!stackExists) {
      // Populate entries with external variables from process environment
      const entries: Array<{ name: string; value: string }> = [];
      try {
        const stResp = await fetch(`${apiUrl}/api/stacktypes`, { signal: AbortSignal.timeout(5000) });
        if (stResp.ok) {
          const stData = await stResp.json() as { stacktypes: Array<{ name: string; entries?: Array<{ name: string; external?: boolean }> }> };
          const stDef = stData.stacktypes.find(s => s.name === stacktype);
          if (stDef?.entries) {
            for (const v of stDef.entries) {
              if (v.external && process.env[v.name]) {
                entries.push({ name: v.name, value: process.env[v.name]! });
              }
            }
          }
        }
      } catch { /* ignore — stack will be created without external entries */ }

      try {
        const resp = await fetch(`${apiUrl}/api/stacks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: stackName, stacktype, entries }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          logOk(`Stack '${stackId}' created (type: ${stacktype})`);
          if (entries.length > 0) {
            logInfo(`  External variables injected: ${entries.map(e => e.name).join(", ")}`);
          }
        }
      } catch {
        // Stack creation failed — may already exist from concurrent run
      }
    }
  }

  return { stackIdMap, appStackIdsMap };
}

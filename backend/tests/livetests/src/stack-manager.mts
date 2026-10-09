/**
 * Stack lifecycle management for live integration tests.
 *
 * Handles stack creation, reuse, cleanup SQL, and stale VM detection.
 * Stacks hold shared passwords between applications in the same deployment
 * (e.g. postgres password shared between postgres and zitadel).
 */

import { nestedSsh, withZfsCloneRelease } from "./ssh-helpers.mjs";
import type { PlannedScenario } from "./livetest-types.mjs";
import type { SnapshotManager } from "./snapshot-manager.mjs";
import { logOk, logInfo } from "./log-helpers.mjs";

export interface StackMaps {
  stackIdMap: Map<string, string>;
  appStackIdsMap: Map<string, string[]>;
}

/**
 * Run cleanup SQL on reused dependency VMs.
 *
 * Triggered when a scenario is going to be re-installed and its `cleanup`
 * map declares SQL that should run against a reused dependency. Concretely:
 * zitadel/default's `cleanup.postgres` drops the `zitadel` user + database
 * inside the postgres-default container so the next zitadel install can
 * bootstrap a fresh user with the new oidc_default stack's password.
 *
 * The filter is ``skipExecution`` (will the scenario actually re-install?)
 * — NOT ``isDependency``. When zitadel/default is depended on by gitea
 * but its VM was destroyed (e.g. stack-recreate path), it is a dependency
 * AND has skipExecution=false. The cleanup must still run, otherwise the
 * postgres `zitadel` user keeps the old password while ensureStacks rolls
 * the oidc stack to a new one — and the next zitadel install fails
 * "password authentication failed for user \"zitadel\"" (SQLSTATE 28P01)
 * during start-from-init.
 */
export function runCleanupSql(
  planned: PlannedScenario[],
  pveHost: string,
  sshPort: number,
): void {
  for (const p of planned) {
    if (p.skipExecution || !p.scenario.cleanup) continue;
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
  _snapMgr?: SnapshotManager,
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
      // Stack missing but container is running. In the new pct-snapshot model
      // the deployer is read-only after stack-fill (Secrets write-once) and
      // its context is never rolled back, so this stale-context-recovery
      // path is moot — there is no context backup to restore from. Surface
      // the inconsistency and let the dep-VM destroy path below take over.
      if (!contextRestoreAttempted) {
        contextRestoreAttempted = true;
        logInfo("Stacks missing for running VMs — destroying dep CT and reinstalling (no context-restore in pct-snapshot model)");
      }

      if (stackMissing) {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) stack missing — destroying (context mismatch)`);
        nestedSsh(pveHost, sshPort,
          `pct stop ${p.vmId} 2>/dev/null || true; ${withZfsCloneRelease(p.vmId, `pct destroy ${p.vmId} --force --purge 2>/dev/null`)} || true`,
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
                  "addon-oauth2-proxy": "oidc",
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
        if (!addonSt) continue;
        // addonSt is `string | string[]`; flatten so each stacktype joins the
        // per-VM stacktype list independently.
        const sts = Array.isArray(addonSt) ? addonSt : [addonSt];
        for (const st of sts) {
          if (!stacktypes.includes(st)) stacktypes.push(st);
        }
      }
    }

    if (stacktypes.length === 0) continue;

    // Honour explicit `depends_on: ["<app>/<variant>"]` entries from the test
    // config: if the dep app provides a stacktype that the consumer also
    // selects (via addon or own stacktype), point the consumer at the dep's
    // variant of that stack rather than at the consumer's own variant.
    //
    // Example: modbus2mqtt/ssl uses addon-oidc (stacktype "oidc") and declares
    // `depends_on: ["zitadel/default"]`. Without this map, the consumer would
    // land on stack `oidc_ssl`, dragging in zitadel-ssl as its OIDC backend —
    // but the test explicitly wants the plain-HTTP zitadel-default. With this
    // map, stacktype "oidc" → variant "default" → stack `oidc_default`.
    const depStacktypeVariants = new Map<string, string>();
    for (const depId of (p.scenario.depends_on ?? [])) {
      const slash = depId.indexOf("/");
      if (slash <= 0) continue;
      const depApp = depId.slice(0, slash);
      const depVariant = depId.slice(slash + 1);
      if (!depApp || !depVariant) continue;
      const depRawStacktype = appStacktypes.get(depApp);
      if (!depRawStacktype) continue;
      const depSts = Array.isArray(depRawStacktype) ? depRawStacktype : [depRawStacktype];
      for (const st of depSts) {
        // First dep that provides this stacktype wins. Subsequent deps with
        // the same stacktype are ignored — by convention each stacktype has
        // exactly one provider per scenario chain.
        if (!depStacktypeVariants.has(st)) depStacktypeVariants.set(st, depVariant);
      }
    }

    const ids: string[] = [];
    for (const st of stacktypes) {
      const variant = depStacktypeVariants.get(st) ?? p.stackName;
      const stackId = `${st}_${variant}`;
      ids.push(stackId);
      if (!stacksToCreate.has(stackId)) {
        stacksToCreate.set(stackId, { name: variant, type: st });
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
      // Never delete an existing stack. A stack is the single source of
      // truth for secrets shared across apps (e.g. POSTGRES_PASSWORD), and
      // must outlive container churn: persistent data volumes (pgdata) and
      // whole-VM snapshots survive a destroy+reinstall, so rotating the
      // secret here would desync it from the surviving data and break auth
      // ("password authentication failed"). The legitimate "fresh app user
      // on a reused dependency" case is handled by runCleanupSql (drops the
      // consumer's DB objects) — that does NOT require rotating the shared
      // password. Secret rotation is an explicit user action (refresh-stack)
      // only. The POST handler is idempotent, so even a redundant recreate
      // preserves the existing value.
      logOk(`Stack '${stackId}' exists — reusing (passwords unchanged)`);
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

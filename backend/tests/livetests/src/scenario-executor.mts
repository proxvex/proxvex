/**
 * Scenario execution engine for live integration tests.
 *
 * Runs planned scenarios sequentially: builds CLI parameters, executes the CLI,
 * verifies results, writes test results, and creates snapshots for dependencies.
 */

import { runCli, type CliJsonResult } from "./cli-executor.mjs";
import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, nestedSshStrict, waitForServices, waitForContainerStable, waitForLxcInit } from "./ssh-helpers.mjs";
import { buildParams, partitionAfterFailure } from "./scenario-planner.mjs";
import { TestResultWriter, type TestResultDependency } from "./test-result-writer.mjs";
import { collectFailureLogs } from "./diagnostics.mjs";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario, TestResult } from "./livetest-types.mjs";
import { Verifier, buildDefaultVerify, type AppMeta } from "./verifier.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";
import { resolveVolumeStorage } from "./live-test-runner.mjs";
import { checkVolumeConsistency } from "./volume-consistency-check.mjs";
import { collectScenarioEnv } from "./scenario-env.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/**
 * Evaluate expect2fail + allowed2fail expectations against per-template results.
 *
 * Two distinct semantics:
 *  - `expect2fail`: the template MUST fail with the listed code. Pipeline
 *    success without the failure is a mismatch (test detects when the
 *    expected failure path silently goes away).
 *  - `allowed2fail`: the template MAY fail with the listed code. If it
 *    passes, no foul. If it fails with that code, also no foul. Any other
 *    non-zero is still a real failure.
 *
 * In both cases, OTHER non-zero exits remain real failures.
 *
 * Returns matched=true only when every expect2fail entry matched AND no
 * extraneous non-zero exits occurred.
 *
 * Internal CLI errors with exitCode -1 (output validation, not a real script
 * exit) are excluded — they don't represent template-level failures.
 */
function evaluateExpect2Fail(
  cliResult: CliJsonResult,
  expect2fail: Record<string, number>,
  allowed2fail: Record<string, number> = {},
): { matched: boolean; mismatches: string[] } {
  const mismatches: string[] = [];

  // For each declared expectation, find the corresponding messages.
  for (const [tmpl, expectedCode] of Object.entries(expect2fail)) {
    const msgs = cliResult.messages.filter((m) => m.template === tmpl);
    if (msgs.length === 0) {
      const seenTemplates = [
        ...new Set(cliResult.messages.map((m) => m.template).filter(Boolean)),
      ].sort();
      // Also collect command names for messages without template, to help
      // diagnose whether the template ran but failed to propagate the field.
      const orphanCommands = [
        ...new Set(
          cliResult.messages
            .filter((m) => !m.template && m.command)
            .map((m) => m.command),
        ),
      ].sort();
      const seenSummary = seenTemplates.length > 0
        ? `seen[${seenTemplates.length}]: ${seenTemplates.join(", ")}`
        : "no messages had a 'template' field — runtime did not propagate template filenames";
      const orphanSummary = orphanCommands.length > 0
        ? ` | orphan-cmds[${orphanCommands.length}]: ${orphanCommands.slice(0, 30).join(", ")}`
        : "";
      mismatches.push(
        `${tmpl}: expected to exit ${expectedCode}, but template never ran (${seenSummary}${orphanSummary})`,
      );
      continue;
    }
    // A template may emit multiple messages (one per command, plus a synthetic
    // error wrapper with exitCode=-1 from the catch handler when the script
    // throws). Prefer the real script exit (0..N) over the synthetic -1, and
    // skip partial streaming messages.
    const finals = msgs.filter((m) => !m.partial);
    const realExits = finals.filter((m) => m.exitCode !== -1);
    const lastMsg =
      realExits.length > 0
        ? realExits[realExits.length - 1]
        : finals.length > 0
          ? finals[finals.length - 1]
          : msgs[msgs.length - 1];
    if (lastMsg.exitCode !== expectedCode) {
      mismatches.push(
        `${tmpl}: expected exit ${expectedCode}, got ${lastMsg.exitCode}`,
      );
    }
  }

  // Flag any non-zero exit that's not covered by an expect2fail OR
  // allowed2fail entry. Exclude:
  //  - exitCode 0 / -1 (success / synthetic-error wrapper)
  //  - the "Failed" pipeline-abort message (command="Failed", no template) —
  //    it's the synthetic top-level wrapper VeExecution emits when an inner
  //    template throws; the inner failure is what matters and is matched
  //    separately above
  //  - messages without a template field (typically not real script results;
  //    e.g. "Completed", "Failed" wrappers, hook-trigger streaming chunks)
  for (const msg of cliResult.messages) {
    if (msg.exitCode === undefined || msg.exitCode === 0 || msg.exitCode === -1) {
      continue;
    }
    if (!msg.template) continue;
    if (expect2fail[msg.template] !== undefined) continue;
    if (allowed2fail[msg.template] === msg.exitCode) continue;
    mismatches.push(`unexpected failure: ${msg.template} exited ${msg.exitCode}`);
  }

  return { matched: mismatches.length === 0, mismatches };
}

/** True if any allowed2fail entry was actually triggered (template ran, exited
 * with the listed code). Used to decide whether to rewrite cliResult.exitCode
 * from non-zero to 0 (analogous to expect2fail) and to skip the post-install
 * stability poll. */
function allowed2failTriggered(
  cliResult: CliJsonResult,
  allowed2fail: Record<string, number>,
): boolean {
  for (const [tmpl, code] of Object.entries(allowed2fail)) {
    const msgs = cliResult.messages.filter(
      (m) => m.template === tmpl && !m.partial && m.exitCode !== -1,
    );
    if (msgs.some((m) => m.exitCode === code)) return true;
  }
  return false;
}

/** Find an existing managed container by application_id via the installations API.
 *
 * `expectedHostname` lets the caller disambiguate between sibling containers of
 * the same application (e.g. nginx-default vs nginx-acme vs nginx-oidc-ssl).
 * Without it we fall back to lowest-VMID-first, which after a replace_ct flow
 * may return the wrong sibling — leading to result.vmId pointing at an unrelated
 * container that then gets cleaned up incorrectly while the real target leaks. */
async function findExistingVm(
  _apiUrl: string,
  _veHost: string,
  applicationId: string,
  pveHost: string,
  sshPort: number,
  expectedHostname?: string,
  /**
   * When true, *only* a CT whose hostname matches `expectedHostname` exactly
   * is acceptable — no falling back to the first application-id match. Used
   * by the `--all` driver where the planner has already resolved the right
   * source via depends_on, and a "first match" fallback would pick the wrong
   * sibling (e.g. `nginx-acme` for a `nginx/default`-depending reconfigure).
   */
  strictHostname = false,
): Promise<{ vm_id: number; addons?: string[]; hostname?: string } | null> {
  // Scan PVE host directly for running managed containers.
  // More reliable than deployer context which may be stale after rollbacks.
  try {
    const pctList = nestedSsh(pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1}'`, 10000);
    let firstAppMatch: { vm_id: number; addons?: string[]; hostname?: string } | null = null;
    for (const line of pctList.split("\n")) {
      const vmId = parseInt(line.trim(), 10);
      if (isNaN(vmId)) continue;
      try {
        const conf = nestedSsh(pveHost, sshPort,
          `pct config ${vmId} 2>/dev/null | head -40`, 5000);
        if (!conf.includes("proxvex") || !conf.includes("managed")) continue;
        // Skip containers that replace-ct.sh has retired. They keep the same
        // hostname + application-id as their replacement, but carry a
        // `<!-- proxvex:replaced-by N -->` notes marker plus `lock=migrate`.
        // Picking them as previous_vm_id for the next reconfigure breaks
        // pct snapshot ("CT is locked (migrate)").
        if (/proxvex(%3A|:)replaced-by/.test(conf)) continue;
        const appMatch = conf.match(/application-id\s+(\S+)/);
        const appId = appMatch?.[1]?.replace(/%20/g, " ");
        if (appId !== applicationId) continue;
        const addonMatches = conf.matchAll(/addon\s+(\S+)/g);
        const addons = [...addonMatches].map(m => m[1]!).filter(Boolean);
        const hostMatch = conf.match(/^hostname:\s*(\S+)/m);
        const hostname = hostMatch?.[1];
        const result = {
          vm_id: vmId,
          addons: addons.length > 0 ? addons : undefined,
          hostname,
        };
        if (expectedHostname) {
          if (hostname === expectedHostname) return result;
          if (!firstAppMatch) firstAppMatch = result;
          continue;
        }
        return result;
      } catch { continue; }
    }
    if (firstAppMatch && !strictHostname) return firstAppMatch;
  } catch { /* ignore */ }
  return null;
}

/** Verify a planner-resolved VMID still corresponds to a usable source container.
 *  Returns null if the CT doesn't exist, was retired by replace-ct, or is
 *  locked. Returns hostname/addons when usable. */
function verifyDependencyVm(
  pveHost: string,
  sshPort: number,
  vmId: number,
  applicationId: string,
): { vm_id: number; addons?: string[]; hostname?: string } | null {
  try {
    const conf = nestedSsh(pveHost, sshPort,
      `pct config ${vmId} 2>/dev/null | head -40`, 5000);
    if (!conf.includes("proxvex") || !conf.includes("managed")) return null;
    if (/proxvex(%3A|:)replaced-by/.test(conf)) return null;
    // Locked CTs (migrate/backup/snapshot) can't serve as a clone source.
    if (/^lock:\s*\S+/m.test(conf)) return null;
    const appMatch = conf.match(/application-id\s+(\S+)/);
    const appId = appMatch?.[1]?.replace(/%20/g, " ");
    if (appId !== applicationId) return null;
    const addonMatches = conf.matchAll(/addon\s+(\S+)/g);
    const addons = [...addonMatches].map(m => m[1]!).filter(Boolean);
    const hostMatch = conf.match(/^hostname:\s*(\S+)/m);
    const result: { vm_id: number; addons?: string[]; hostname?: string } = { vm_id: vmId };
    if (addons.length > 0) result.addons = addons;
    if (hostMatch?.[1]) result.hostname = hostMatch[1];
    return result;
  } catch {
    return null;
  }
}

/** Allocate a fresh VMID for a source-isolation clone. Picks a slot well
 *  above the planner's `step.vmId` range so it can't collide with any
 *  scenario the planner has already reserved. Returns null when no slot is
 *  available in the configured search range. */
function allocateCloneVmId(
  pveHost: string,
  sshPort: number,
  startAbove: number,
): number | null {
  // Search 1000–1999 ABOVE the consumer's planner VMID. step.vmId is in the
  // 200+ range, so cloneVmId lands at 1200+ — clearly out of band of the
  // 200-block the planner uses, easy to recognise in `pct list`, and out of
  // the way of test scenarios.
  const baseStart = Math.max(startAbove + 1000, 1200);
  try {
    const taken = nestedSsh(
      pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1}'`,
      10000,
    )
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    const takenSet = new Set(taken);
    for (let id = baseStart; id < baseStart + 800; id++) {
      if (!takenSet.has(id)) return id;
    }
  } catch { /* ignore — return null below */ }
  return null;
}

/** Round-trip a Spoke→Hub call to verify the Hub is reachable.
 *
 * After `qm rollback` the nested VM and the Hub LXC inside it are restarting.
 * `waitForNestedVm` only checks SSH, but the Hub HTTP API needs additional
 * seconds before it accepts requests. The Spoke proxies stack and CA-sign
 * calls to the Hub via curl with a 15s timeout — if the next scenario starts
 * before the Hub is listening, those calls fail with curl rc=7. This helper
 * polls the Spoke's /api/applications endpoint, which (in Spoke mode) forces
 * a Hub round-trip, until it succeeds or the timeout elapses. */
async function waitForHubViaSpoke(apiUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${apiUrl}/api/applications`, {
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) return;
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  logInfo(`Warning: Hub did not respond via Spoke within ${timeoutMs / 1000}s (last: ${lastError}) — continuing anyway`);
}

/** Return VMIDs (other than `excludeVmId`) whose hostname matches `hostname`.
 *
 * Pre-flight guard against leftover containers from previous runs. If a stale
 * postgres-default at VMID 219 lingers when a fresh run installs at VMID 220,
 * the deployer's dependency-resolver picks the lowest VMID (219) but DNS
 * resolves to the new container (220) — yielding silent password mismatches
 * downstream. Catching the duplicate up-front turns the symptom into a clear
 * fail with a `--fresh` hint. */
function findHostnameCollisions(
  pveHost: string,
  sshPort: number,
  hostname: string,
  excludeVmId: number,
): number[] {
  try {
    // pct list columns: VMID Status [Lock] Name. Name (last token) carries
    // the hostname for proxvex-managed containers.
    const out = nestedSsh(
      pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1, $NF}'`,
      10000,
    );
    const collisions: number[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const vmid = parseInt(parts[0]!, 10);
      if (Number.isNaN(vmid)) continue;
      if (vmid === excludeVmId) continue;
      if (parts[parts.length - 1] === hostname) collisions.push(vmid);
    }
    return collisions;
  } catch {
    return [];
  }
}

export async function executeScenarios(
  planned: PlannedScenario[],
  config: {
    instance?: string;
    pveHost: string;
    vmId: number;
    portPveSsh: number;
    bridge: string;
    deployerUrl: string;
    snapshot?: { enabled: boolean };
    portForwarding?: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
    /** Optional: UI-generated PAT for a Zitadel service user with sufficient
     *  org permissions. When set, gets injected as `ZITADEL_PAT` param into
     *  every params.json so OIDC-addon templates use it instead of the
     *  on-LXC /bootstrap/admin-client.pat fallback. */
    zitadelPat?: string;
  },
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
  allTests: Map<string, ResolvedScenario>,
  stackIdMap: Map<string, string[]>,
  resultWriter?: TestResultWriter,
  fixtureBaseDir?: string,
  options?: { failFast?: boolean; debugLevel?: string },
): Promise<TestResult> {
  const result: TestResult = {
    name: planned.map((p) => p.scenario.id).join(", "),
    description: planned.map((p) => p.scenario.description).join("; "),
    passed: 0,
    failed: 0,
    steps: [],
    errors: [],
  };

  const verifier = new Verifier(config.pveHost, config.portPveSsh, apiUrl, veHost);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "livetest-"));

  // Phase: pre-test proxvex rebuild.
  //
  // The proxvex application is a special case among test targets — the
  // image under test is OUR OWN code. The standard pull path
  // (host-get-oci-image.py → ghcr.io/proxvex/proxvex) returns the upstream
  // published version, which by definition lags the local dev tree. For
  // scenarios that exercise unreleased backend behaviour (e.g.
  // proxvex/playwright-oidc relies on the spoke-sync overlay symlink + the
  // dev-session endpoint), running the test against the upstream image
  // produces a confusing 403 / "endpoint not found" instead of the bug
  // we're actually changing.
  //
  // Solution: when any planned target scenario installs the proxvex
  // application, rebuild + stage the local OCI tarball into the nested-VM
  // template cache as `proxvex_latest.tar` and `proxvex_<version>.tar`.
  // host-get-oci-image.py finds those before reaching for the registry.
  //
  // No currency check (per design) — always rebuild when triggered. Set
  // LIVETEST_SKIP_PROXVEX_REBUILD=1 to skip (for iteration loops that
  // intentionally test against whatever's already in cache).
  const hasProxvexTarget = planned.some(
    (p) => p.scenario.application === "proxvex" && !p.skipExecution && !p.isDependency,
  );
  if (hasProxvexTarget && process.env.LIVETEST_SKIP_PROXVEX_REBUILD !== "1") {
    const instanceName = config.instance;
    if (!instanceName) {
      logWarn("Cannot rebuild proxvex: config.instance is undefined — skipping pre-test build");
    } else {
      const helper = path.join(projectRoot, "e2e/build-proxvex-oci-image.sh");
      if (!existsSync(helper)) {
        throw new Error(`build-proxvex-oci-image.sh missing at ${helper} — cannot stage fresh proxvex image for test`);
      }
      logStep("Pre-test", `Building + staging proxvex OCI image for instance=${instanceName}`);
      try {
        execSync(`"${helper}" "${instanceName}"`, {
          cwd: projectRoot,
          stdio: "inherit",
        });
      } catch (err) {
        throw new Error(
          `proxvex rebuild failed: ${err instanceof Error ? err.message : String(err)} — ` +
            `set LIVETEST_SKIP_PROXVEX_REBUILD=1 to bypass and run against the stale cached image`,
        );
      }
    }
  } else if (hasProxvexTarget) {
    logInfo("LIVETEST_SKIP_PROXVEX_REBUILD=1 — using whatever proxvex image is already cached");
  }

  // Fetch deployer version for test results
  let deployerVersion = "unknown";
  let deployerGitHash = "unknown";
  try {
    const vResp = await fetch(`${apiUrl}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (vResp.ok) {
      const v = await vResp.json() as { version?: string; gitHash?: string };
      deployerVersion = v.version ?? "unknown";
      deployerGitHash = v.gitHash ?? "unknown";
    }
  } catch { /* ignore */ }

  // Build hash for snapshot invalidation
  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore */ }

  // Snapshot manager for the single dep-stacks-ready snapshot.
  // Provider/consumer distinction comes from `step.isDependency` set by the
  // planner (planned[].isDependency = true if not in selectedIdSet).
  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  const snapMgr = config.snapshot?.enabled
    ? new SnapshotManager(config.pveHost, config.vmId, config.portPveSsh, (msg) => logInfo(msg), localContextPath)
    : null;

  // OIDC credentials for delegated access (loaded after Zitadel installation)
  // Only used if the deployer itself has OIDC enabled (not for app-level OIDC addons)
  let oidcCredentials: { issuerUrl: string; clientId: string; clientSecret: string } | undefined;

  /**
   * Pull the test-deployer credentials from the oidc_<stackName> stack the
   * way addon-oidc-consuming applications do: Zitadel install emits
   * `DEPLOYER_OIDC_MACHINE_CLIENT_ID/SECRET` and `DEPLOYER_OIDC_ISSUER_URL`
   * as stack provides, so any consumer (including the livetest runner that
   * needs to call the Zitadel token endpoint from the remote Playwright
   * spec) reads them from there — never from the LXC bootstrap files.
   */
  async function loadOidcCredsFromStack(stackName: string): Promise<typeof oidcCredentials> {
    try {
      const resp = await fetch(`${apiUrl}/api/stack/oidc_${stackName}`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return undefined;
      const data = await resp.json() as { stack?: { provides?: Array<{ name: string; value: string }> } };
      const provides = data.stack?.provides ?? [];
      const get = (name: string): string | undefined => provides.find((p) => p.name === name)?.value;
      // Prefer TEST_DEPLOYER_OIDC_* — emitted by template 357 (livetest-local
      // overlay), this user gets ALL project roles granted (template 358 +
      // Phase D refresh-grant hook). Falls back to DEPLOYER_OIDC_* (deployer-cli
      // machine user from template 340) when test-deployer wasn't created —
      // that user has ORG_OWNER but no per-project role, so apps with
      // OIDC_REQUIRED_ROLE will reject its access token (HTTP 403 from
      // /api/auth/dev-session).
      const issuerUrl =
        get("TEST_DEPLOYER_OIDC_ISSUER_URL")
        ?? get("DEPLOYER_OIDC_ISSUER_URL");
      const clientId =
        get("TEST_DEPLOYER_OIDC_MACHINE_CLIENT_ID")
        ?? get("DEPLOYER_OIDC_MACHINE_CLIENT_ID");
      const clientSecret =
        get("TEST_DEPLOYER_OIDC_MACHINE_CLIENT_SECRET")
        ?? get("DEPLOYER_OIDC_MACHINE_CLIENT_SECRET");
      if (issuerUrl && clientId && clientSecret) {
        return { issuerUrl, clientId, clientSecret };
      }
    } catch { /* stack not ready yet */ }
    return undefined;
  }
  let deployerOidcEnabled = false;
  try {
    const authResp = await fetch(`${apiUrl}/api/auth/config`, { signal: AbortSignal.timeout(3000) });
    if (authResp.ok) {
      const authConfig = await authResp.json() as { enabled?: boolean };
      deployerOidcEnabled = !!authConfig.enabled;
    }
  } catch { /* deployer has no OIDC */ }

  try {
    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]!;
      const scenario = step.scenario;
      const task = scenario.task || "installation";

      logStep(
        `${i + 1}/${planned.length}`,
        `${scenario.id} (${task}) [VM ${step.vmId}]`,
      );

      const stepStartTime = new Date();

      // VMIDs of source clones created for Phase-2 isolation. Always cleaned
      // up at iteration end (pass, fail, OR crash) so they don't leak across
      // the --all run. Populated below when consumes_source === "isolate".
      const sourceCloneVmIds: number[] = [];

      // Per-iteration crash safety: an uncaught exception inside the loop
      // body would kill the runner mid-plan, leaving the result dir nearly
      // empty (we've seen this with --all: scenario 1 throws → 42 remaining
      // scenarios never run, no result.md anywhere). Catching here turns the
      // throw into a "crashed" test result and lets the rest of the plan
      // proceed; downstream scenarios that depend on this one will be
      // filtered out by the existing partitionAfterFailure logic.
      try {

      // Skip dependencies that were restored from snapshot or are already running
      if (step.skipExecution) {
        logOk(`Skipping ${scenario.id} (${step.isDependency ? "restored from snapshot" : "already running"})`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        // Even when the zitadel install is skipped (running container reused
        // from a prior run or restored from snapshot), downstream Playwright
        // specs still need DEPLOYER_OIDC_* env vars. The bootstrap file lives
        // in the LXC volume so it survives skipped installs — read it now.
        if (scenario.application === "zitadel" && !oidcCredentials) {
          oidcCredentials = await loadOidcCredsFromStack(step.stackName);
          if (oidcCredentials) {
            logOk(`Test OIDC deployer credentials loaded from oidc_${step.stackName} stack (skipped Zitadel)`);
          }
        }
        continue;
      }

      // Build params.
      // Note: `bridge` is the *container* bridge inside the nested VM, which is
      // always "vmbr1" (created by step1). config.bridge is the host-PVE-side
      // bridge of the outer VM (vmbr1/2/3 depending on instance) and is NOT
      // the same thing.
      //
      // Hidden apps (e.g. proxmox host reconfigure) target the PVE host itself
      // — the runner-derived `${app}-${variant}` is meaningless there. Use the
      // real PVE host's short name so backend cert-signing produces a cert
      // matching the actual web UI hostname. `/api/applications` filters hidden
      // apps out, so missing from appMetaMap == hidden.
      const isHiddenApp = !appMetaMap.has(scenario.application);
      let effectiveHostname = step.hostname;
      if (isHiddenApp) {
        try {
          effectiveHostname = nestedSsh(
            config.pveHost, config.portPveSsh,
            "uname -n | cut -d. -f1",
            5000,
          ).trim() || step.hostname;
        } catch { /* fall back to step.hostname */ }
      }
      const isReplaceCt = REPLACE_CT_TASKS.includes(task);

      // Pre-flight: refuse to install on top of a leftover container that
      // already owns the target hostname. replace_ct (upgrade/reconfigure)
      // legitimately reuses the source's hostname, and hidden apps don't
      // create an LXC at all, so both are excluded.
      if (!isReplaceCt && !isHiddenApp) {
        const collisions = findHostnameCollisions(
          config.pveHost, config.portPveSsh, effectiveHostname, step.vmId,
        );
        if (collisions.length > 0) {
          const errMsg =
            `Hostname '${effectiveHostname}' already in use by VMID(s) ${collisions.join(", ")}. ` +
            `Leftover from a previous run — re-run the livetest with --fresh to wipe.`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          result.steps.push({
            vmId: step.vmId, hostname: effectiveHostname,
            application: scenario.application, scenarioId: scenario.id,
          });
          continue;
        }
      }

      const baseParams = [
        { name: "hostname", value: effectiveHostname },
        { name: "bridge", value: "vmbr1" },
        ...(!isReplaceCt ? [{ name: "vm_id", value: String(step.vmId) }] : []),
        ...(isReplaceCt ? [{ name: "vm_id_start", value: String(step.vmId) }] : []),
        // Enable per-task debug bundle on the backend when --debug was passed
        // to the livetest. Only the user-requested scenario gets the bundle —
        // dependencies (e.g. postgres for a zitadel test) stay quiet so the
        // result directory only carries the artefact for the test the user
        // actually asked for.
        ...(options?.debugLevel
          && options.debugLevel !== "off"
          && !step.isDependency
          ? [{ name: "debug_level", value: options.debugLevel }]
          : []),
      ];

      const templateVars: Record<string, string> = {
        vm_id: String(step.vmId),
        hostname: step.hostname,
        stack_name: step.stackName,
      };

      // Add dependency VM IDs as template variables
      if (scenario.depends_on) {
        for (const depId of scenario.depends_on) {
          const depStep = planned.find((p) => p.scenario.id === depId);
          if (depStep) {
            const depApp = depStep.scenario.application.replace(/-/g, "_");
            templateVars[`dep_${depApp}_vm_id`] = String(depStep.vmId);
          }
        }
      }

      const buildResult = buildParams(scenario, baseParams, templateVars, tmpDir);

      // For upgrade/reconfigure: find existing VM. Resolution order:
      //   1. explicit previous_vm_id from scenario params (e.g. proxmox/oidc-ssl
      //      sets "0" because the PVE host itself is the reconfigure target).
      //   2. same-application entry in depends_on — but VERIFIED on the host
      //      (CT exists, not retired/locked, app-id matches). The planner's
      //      vmId can be stale when an earlier scenario in the run already
      //      consumed the source (lock=migrate after replace-ct).
      //   3. hostname-strict findExistingVm — only accept a CT whose hostname
      //      exactly matches one of the depends_on apps' planner-hostnames.
      //      No silent "first nginx-* CT" fallback: that picked nginx-acme
      //      instead of nginx-default for reconf-addons-off, leaking ACME
      //      errors into the post-rename log.
      let existingVm: { vm_id: number; addons?: string[]; hostname?: string } | null = null;
      if (isReplaceCt) {
        const explicitPrev = buildResult.params.find((p) => p.name === "previous_vm_id");
        if (explicitPrev) {
          existingVm = { vm_id: Number(explicitPrev.value) };
          logInfo(`Using explicit previous_vm_id=${explicitPrev.value} from scenario for ${task}`);
        }
        if (!existingVm && scenario.depends_on) {
          for (const depId of scenario.depends_on) {
            const depStep = planned.find((p) => p.scenario.id === depId);
            if (!depStep || depStep.scenario.application !== scenario.application) continue;
            const verified = verifyDependencyVm(
              config.pveHost, config.portPveSsh, depStep.vmId, scenario.application,
            );
            if (verified) {
              existingVm = verified;
              logInfo(`Using depended-on VM ${verified.vm_id} (hostname=${verified.hostname ?? "?"}) for ${task} (from ${depId})`);
              break;
            }
            logWarn(
              `Planner mapped ${depId} → VM ${depStep.vmId} but that CT is missing/retired/locked — falling back to hostname-strict scan`,
            );
          }
        }
        if (!existingVm) {
          // Strict hostname match: no "first app-id match" fallback.
          // Try each same-application depends_on hostname.
          const candidateHostnames: string[] = [step.hostname];
          if (scenario.depends_on) {
            for (const depId of scenario.depends_on) {
              const depStep = planned.find((p) => p.scenario.id === depId);
              if (depStep && depStep.scenario.application === scenario.application) {
                if (!candidateHostnames.includes(depStep.hostname)) {
                  candidateHostnames.push(depStep.hostname);
                }
              }
            }
          }
          for (const host of candidateHostnames) {
            existingVm = await findExistingVm(
              apiUrl, veHost, scenario.application,
              config.pveHost, config.portPveSsh, host, true /* strictHostname */,
            );
            if (existingVm) {
              logInfo(`Found CT ${existingVm.vm_id} by hostname '${host}' for ${task}`);
              break;
            }
          }
        }
        if (!existingVm) {
          const errMsg = `No existing VM found for ${scenario.application} — cannot ${task}`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          // Skip this scenario but keep running the rest of the --all plan.
          // Aborting here (via `break`) hid many passable scenarios whenever
          // a reconfigure/upgrade task's live dependency VM had already been
          // torn down by a previous scenario's cleanup.
          continue;
        }
        // From here on existingVm is guaranteed non-null. Bind into a typed
        // local so TS keeps the narrowing across the reassignment below
        // (cloning swaps `existingVm` to point at the clone).
        let sourceVm: { vm_id: number; addons?: string[]; hostname?: string } = existingVm;
        // Phase 2: source isolation. If the scenario destructively consumes
        // its source (reconfigure, oci-image upgrade), clone the source into
        // a private throw-away CT and feed the clone into the scenario as
        // previous_vm_id. Original source stays available for other
        // consumers. docker-compose upgrade opts out (in-place modification
        // — see `consumes_source` doc). The clone is registered for cleanup
        // at iteration end regardless of pass/fail.
        const appMetaForVmId = appMetaMap.get(scenario.application) ?? {};
        const isDockerComposeForVmId =
          (appMetaForVmId.framework ?? appMetaForVmId.extends) === "docker-compose";
        const defaultStrategy: "isolate" | "in-place" | "shared" =
          isDockerComposeForVmId && task === "upgrade" ? "in-place" : "isolate";
        const consumesSource = scenario.consumes_source ?? defaultStrategy;
        // Explicit previous_vm_id (the proxmox/oidc-ssl hack with value "0")
        // means there is no source CT to isolate — leave as-is.
        const hasExplicitPrev = !!buildResult.params.find((p) => p.name === "previous_vm_id");
        if (consumesSource === "isolate" && !hasExplicitPrev) {
          const cloneVmId = allocateCloneVmId(config.pveHost, config.portPveSsh, step.vmId);
          if (cloneVmId !== null) {
            logInfo(`Isolating source: cloning VM ${sourceVm.vm_id} → ${cloneVmId} for ${scenario.id}`);
            // `pct clone --full` on a RUNNING source requires `--snapname`
            // (Proxmox: "Full clone of a running container is only possible
            // from a snapshot"). Take an ephemeral snapshot, clone from it,
            // and delete the snapshot afterwards. The source CT stays
            // running throughout — its kernel mounts keep working until next
            // stop, so no data is lost.
            const snapName = `iso-clone-${cloneVmId}`;
            let snapTaken = false;
            try {
              nestedSsh(
                config.pveHost, config.portPveSsh,
                `pct snapshot ${sourceVm.vm_id} ${snapName}`,
                120000,
              );
              snapTaken = true;
              nestedSsh(
                config.pveHost, config.portPveSsh,
                `pct clone ${sourceVm.vm_id} ${cloneVmId} --snapname ${snapName} --full 1`,
                300000,
              );
              // `pct clone` does NOT carry over the source's notes by default.
              // In Proxmox LXC, notes live as `#`-prefixed comment lines at
              // the very top of `/etc/pve/lxc/<vmid>.conf` (NOT as a
              // `description:` line). Downstream proxvex templates check the
              // notes for `proxvex:managed` / `application-id` markers and
              // refuse to operate on CTs missing them.
              //
              // Implementation: prepend the source's leading `#` block to the
              // target's conf. Encoded as a single-line shell command because
              // nestedSsh passes the command through JSON.stringify, which
              // turns embedded newlines into literal `\n` escapes that the
              // remote shell does NOT re-interpret as command separators.
              const SRC_CONF = `/etc/pve/lxc/${sourceVm.vm_id}.conf`;
              const DST_CONF = `/etc/pve/lxc/${cloneVmId}.conf`;
              // Pipe the script via stdin (`sh -s`) so we don't fight nested
              // shell quoting: the runner→ssh→remote-sh chain otherwise
              // expands $(mktemp) on the LOCAL machine before reaching the
              // remote, which clobbers the cloned CT's conf and yields
              // `missing 'arch' - internal error` on `pct start`.
              const copyNotesScript =
                `set -e\n` +
                `T=$(mktemp)\n` +
                `awk 'BEGIN{skip=1} skip && /^[^#]/ {skip=0} !skip {print}' '${DST_CONF}' > "$T"\n` +
                `{ awk '/^[^#]/ {exit} {print}' '${SRC_CONF}'; cat "$T"; } > '${DST_CONF}'\n` +
                `rm -f "$T"\n`;
              try {
                nestedSshStrict(
                  config.pveHost, config.portPveSsh,
                  "sh -s",
                  30000,
                  copyNotesScript,
                );
              } catch (descErr) {
                logWarn(`Could not copy notes from ${sourceVm.vm_id} to ${cloneVmId}: ${descErr instanceof Error ? descErr.message : String(descErr)}`);
              }
              // Delete the source-side snapshot — we don't need it again.
              try {
                nestedSsh(
                  config.pveHost, config.portPveSsh,
                  `pct delsnapshot ${sourceVm.vm_id} ${snapName}`,
                  60000,
                );
                snapTaken = false;
              } catch {
                // Non-fatal: the leftover snapshot is cleanup-able later but
                // a) it occupies disk, b) repeated isolations stack up. Log
                // for visibility.
                logWarn(`Could not delete source snapshot ${snapName} on VM ${sourceVm.vm_id}`);
              }
              // Start the clone so downstream `pct exec` works (the clone is
              // stopped by default).
              try {
                nestedSsh(
                  config.pveHost, config.portPveSsh,
                  `pct start ${cloneVmId} 2>&1 || true`,
                  60000,
                );
                // Poll until lxc-attach succeeds (init PID is reachable).
                // nestedSsh swallows errors; use nestedSshStrict here so the
                // poll loop sees failures and retries.
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                  try {
                    nestedSshStrict(
                      config.pveHost, config.portPveSsh,
                      `pct exec ${cloneVmId} -- /bin/true 2>/dev/null`,
                      5000,
                    );
                    break;
                  } catch {
                    await new Promise((r) => setTimeout(r, 1000));
                  }
                }
              } catch (startErr) {
                logWarn(`pct start on clone ${cloneVmId} failed: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
              }
              sourceCloneVmIds.push(cloneVmId);
              const cloned: { vm_id: number; addons?: string[]; hostname?: string } = { vm_id: cloneVmId };
              if (sourceVm.addons) cloned.addons = sourceVm.addons;
              if (sourceVm.hostname) cloned.hostname = sourceVm.hostname;
              sourceVm = cloned;
              logOk(`Source clone ready: VM ${cloneVmId} (will be destroyed after scenario)`);
            } catch (err) {
              logWarn(`pct clone failed (${err instanceof Error ? err.message : String(err)}) — falling back to shared source`);
              // Best-effort cleanup of a snapshot we may have created.
              if (snapTaken) {
                try {
                  nestedSsh(
                    config.pveHost, config.portPveSsh,
                    `pct delsnapshot ${sourceVm.vm_id} ${snapName} 2>/dev/null || true`,
                    60000,
                  );
                } catch { /* ignore */ }
              }
            }
          } else {
            logWarn(`Could not allocate a clone VMID — falling back to shared source for ${scenario.id}`);
          }
        } else if (consumesSource === "shared") {
          logInfo(`consumes_source=shared: ${scenario.id} runs against original source ${sourceVm.vm_id}`);
        }

        // Keep existingVm in sync so downstream code (addon resolution, etc.)
        // also sees the (possibly cloned) source.
        existingVm = sourceVm;

        if (!buildResult.params.some((p) => p.name === "previous_vm_id")) {
          buildResult.params.push({ name: "previous_vm_id", value: String(sourceVm.vm_id) });
        }
        logInfo(`Found existing VM ${sourceVm.vm_id} for ${task} (previous_vm_id, strategy=${consumesSource})`);

        // For in-place upgrade (docker-compose), also push vm_id =
        // sourceVm.vm_id so the auto-appended check templates
        // (900-host-check-container etc.) can resolve `{{ vm_id }}`.
        // Without this, post-upgrade verification runs with VM='' and
        // fails. Skip for clone-replace flows (oci-image upgrade, all
        // reconfigures): there `vm_id` is the *new* clone's id which the
        // create_ct/replace-ct chain allocates — pushing it here makes
        // source=target → "must differ" abort.
        if (isDockerComposeForVmId && task === "upgrade") {
          if (!buildResult.params.some((p) => p.name === "vm_id")) {
            buildResult.params.push({ name: "vm_id", value: String(sourceVm.vm_id) });
            logInfo(`In-place docker-compose upgrade: vm_id=${sourceVm.vm_id}`);
          }
        }
      }

      resolveVolumeStorage(config.pveHost, config.portPveSsh, buildResult.params);

      const allAddons = buildResult.selectedAddons ?? [];

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const paramsList = buildResult.params.map((p) => ({ name: p.name, value: p.value }));
      // Inject Zitadel PAT from e2e/config.json so OIDC-addon templates
      // (conf-setup-oidc-client.sh & friends) use it as `ZITADEL_PAT` template
      // var instead of the on-LXC /bootstrap/admin-client.pat fallback.
      // Only when the addons require it AND no explicit value already in
      // buildResult.params (operator override wins).
      if (config.zitadelPat && !paramsList.some((p) => p.name === "ZITADEL_PAT")) {
        paramsList.push({ name: "ZITADEL_PAT", value: config.zitadelPat });
      }
      const paramsObj: Record<string, unknown> = {
        application: scenario.application,
        task,
        params: paramsList,
      };

      if (allAddons.length > 0) paramsObj.selectedAddons = allAddons;
      if (isReplaceCt && existingVm?.addons && existingVm.addons.length > 0) {
        paramsObj.installedAddons = existingVm.addons;
        logInfo(`Installed addons: ${existingVm.addons.join(", ")}`);
      }
      if (buildResult.stackId) {
        paramsObj.stackId = buildResult.stackId;
      } else {
        // step.hasStacktype only reflects the application's own stacktype, but
        // addons can pull in their own stacktypes (e.g. nginx + addon-acme →
        // cloudflare). ensureStacks records the full picture in stackIdMap, so
        // use that as the source of truth — passes addon-only stacks too.
        const appStackIds = stackIdMap.get(`${scenario.application}/${step.stackName}`);
        if (appStackIds && appStackIds.length > 1) {
          paramsObj.stackIds = appStackIds;
        } else if (appStackIds && appStackIds.length === 1) {
          paramsObj.stackId = appStackIds[0];
        }
      }

      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      if (allAddons.length > 0) logInfo(`Addons: ${allAddons.join(", ")}`);

      // Reload deployer
      try {
        const reloadResp = await fetch(`${apiUrl}/api/reload`, { method: "POST" });
        if (reloadResp.ok) logInfo("Deployer reloaded");
        else logInfo(`Deployer reload returned ${reloadResp.status} (continuing)`);
      } catch {
        logInfo("Deployer reload not available (continuing)");
      }

      // No pre-test snapshot — failure rollback uses the single
      // dep-stacks-ready host snapshot (created once after all providers).

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const scenarioFixtureDir = fixtureBaseDir
        ? path.join(fixtureBaseDir, scenario.id.replace("/", "-"))
        : undefined;
      // Use OIDC credentials only if the deployer itself requires OIDC auth
      const useOidc = deployerOidcEnabled && oidcCredentials;
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout, scenarioFixtureDir,
        useOidc ? oidcCredentials : undefined,
      );

      // expect2fail: if the scenario declares specific templates expected
      // to fail with specific exit codes, evaluate those expectations against
      // the per-template messages. When all expectations are met (and no
      // other unexpected failures occurred), override cliResult.exitCode to
      // 0 so the rest of the pipeline treats this as a passing scenario.
      // Skip wait_seconds in that case — the install was expected to abort,
      // so the container may legitimately be in a partial state.
      const allowed2fail = scenario.allowed2fail ?? {};
      let expect2failApplied = false;
      if (
        (scenario.expect2fail && Object.keys(scenario.expect2fail).length > 0) ||
        Object.keys(allowed2fail).length > 0
      ) {
        const verdict = evaluateExpect2Fail(
          cliResult, scenario.expect2fail ?? {}, allowed2fail,
        );
        if (verdict.matched) {
          const e2f = scenario.expect2fail ?? {};
          const e2fSummary = Object.keys(e2f).length > 0
            ? `expect2fail: ${Object.entries(e2f).map(([t, c]) => `${t}→${c}`).join(", ")}`
            : "";
          const a2fHit = allowed2failTriggered(cliResult, allowed2fail);
          const a2fSummary = Object.keys(allowed2fail).length > 0
            ? `allowed2fail: ${Object.entries(allowed2fail).map(([t, c]) => `${t}→${c}${a2fHit ? " (triggered)" : ""}`).join(", ")}`
            : "";
          logInfo(
            `tolerated failures satisfied — ${[e2fSummary, a2fSummary].filter(Boolean).join("; ")} — treating scenario as passed`,
          );
          cliResult.exitCode = 0;
          // Skip wait_seconds whenever a tolerated failure short-circuited
          // the pipeline — the container may be in a partial state on purpose.
          expect2failApplied = Object.keys(e2f).length > 0 || a2fHit;
        } else {
          // Force failure with a clear diagnostic; preserve original
          // exit code if non-zero, otherwise synthesize 1.
          if (cliResult.exitCode === 0) cliResult.exitCode = 1;
          const mismatchBlock = verdict.mismatches.map((m) => `  - ${m}`).join("\n");
          cliResult.output =
            `${cliResult.output}\n--- tolerated-failure MISMATCH ---\n${mismatchBlock}\n`;
        }
      }

      // Container-stability poll during wait_seconds. The install pipeline's
      // `900-host-check-container` runs once near the end of the installer and
      // can miss late crashes (e.g. postgres PANIC during initdb when the data
      // volume is too small). Polling `pct status` here closes that window so
      // a crashed container fails the scenario instead of silently passing.
      // Docker-compose apps still use waitForServices in the success path.
      const appMeta = appMetaMap.get(scenario.application) ?? {};
      const waitSeconds = scenario.wait_seconds ?? appMeta.verification?.wait_seconds ?? 0;
      // Use the resolved framework (walks the full extends chain) — `extends`
      // is the direct parent only, which is e.g. `json:zitadel` for a local
      // test override that ultimately inherits from docker-compose.
      const isDockerCompose = (appMeta.framework ?? appMeta.extends) === "docker-compose";

      // docker-compose `upgrade` is in-place: it patches compose image tags
      // and restarts services on the existing container — no new LXC. The
      // planned `step.vmId` (next-free reserved by the test planner) was
      // never allocated by the pipeline, so subsequent waitForServices /
      // verifier checks would target a missing VM. Snap step.vmId back to
      // the previous container that actually got upgraded.
      if (cliResult.exitCode === 0 && isDockerCompose && task === "upgrade" && existingVm?.vm_id) {
        if (step.vmId !== existingVm.vm_id) {
          logInfo(`docker-compose in-place upgrade: target VM is ${existingVm.vm_id} (was ${step.vmId})`);
          step.vmId = existingVm.vm_id;
        }
      }

      // Hidden host apps (e.g. proxmox host reconfigure) don't create an LXC,
      // so polling pct status against step.vmId would always fail. Also skip
      // when expect2fail rewrote the result — the install was expected to
      // abort, so the container may legitimately be in a partial state.
      if (cliResult.exitCode === 0 && waitSeconds > 0 && !isDockerCompose && !isHiddenApp && !expect2failApplied) {
        logInfo(`Waiting ${waitSeconds}s for container to stay healthy...`);
        const health = await waitForContainerStable(
          config.pveHost, config.portPveSsh, step.vmId, waitSeconds,
        );
        if (!health.ok) {
          cliResult.exitCode = 1;
          const crashMsg = `Container ${step.vmId} (${step.hostname}) crashed during wait_seconds (status: ${health.status})`;
          cliResult.output = `${cliResult.output}\n--- POST-INSTALL CRASH ---\n${crashMsg}\n`;
        }
      }

      if (cliResult.exitCode !== 0) {
        const errMsg = `Scenario failed: ${scenario.id} (${task})`;
        logFail(errMsg);

        // Collect failure logs BEFORE rollback (VM still in broken state)
        const failureLogs = collectFailureLogs(
          config.pveHost, config.portPveSsh,
          step.vmId, step.hostname, cliResult.output,
        );

        // Rollback to dep-stacks-ready (atomic whole-VM snapshot on host PVE)
        // to restore consistent state across all stack-provider LXCs and the
        // nested-VM host FS (storagecontext-backup, deployer-context, etc.).
        // Skipped if no providers were planned (no dep-stacks-ready snapshot).
        // KEEP_VM also skips the rollback so the failed LXC stays available
        // for inspection (rollback would destroy it atomically).
        const keepForDebug = !!process.env.KEEP_VM;
        if (keepForDebug) {
          logInfo(`KEEP_VM set — skipping rollback to dep-stacks-ready (failed VM ${step.vmId} preserved for inspection)`);
        }
        if (snapMgr && !step.isDependency && !keepForDebug && snapMgr.exists("dep-stacks-ready")) {
          try {
            snapMgr.rollbackHostSnapshot("dep-stacks-ready");
            // After qm rollback the nested VM (and Hub LXC inside it) is
            // restarting. The Spoke proxies all stack/CA-sign requests to the
            // Hub, so the next scenario's POST /api/stacks or /api/hub/ca/sign
            // will fail with curl rc=7 if Hub isn't listening yet. Round-trip
            // a Spoke→Hub call here to wait until the Hub answers.
            await waitForHubViaSpoke(apiUrl, 60000);
            checkVolumeConsistency(
              config.pveHost, config.portPveSsh, projectRoot,
              `rollback to dep-stacks-ready`,
            );
          } catch (err) {
            logInfo(`Warning: rollback to dep-stacks-ready failed: ${err}`);
          }
        }

        result.errors.push(errMsg);
        result.failed++;
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
          cliOutput: cliResult.output,
        });

        if (resultWriter) {
          await resultWriter.write(TestResultWriter.buildResult({
            runId: resultWriter.getRunId(),
            scenarioId: scenario.id, application: scenario.application, task,
            status: "failed", vmId: step.vmId, hostname: step.hostname,
            stackName: step.stackName, addons: scenario.selectedAddons ?? [],
            startedAt: stepStartTime, finishedAt: new Date(),
            deployerVersion, deployerGitHash,
            commandLine: resultWriter.getCommandLine(),
            dependencies: [], verifyResults: {}, errorMessage: errMsg,
            logs: failureLogs,
            ...(cliResult.restartKey ? { restartKey: cliResult.restartKey } : {}),
          }));
        }

        // Partition remaining tests: skip those that depend on the failed scenario
        const remaining = planned.slice(i + 1);
        const allTestsMap = new Map(planned.map((p) => [p.scenario.id, p.scenario]));
        const { unaffected, blocked } = partitionAfterFailure(scenario.id, remaining, allTestsMap);

        if (unaffected.length > 0 && blocked.length > 0) {
          logInfo(`${scenario.id} failed — running ${unaffected.length} unaffected test(s), skipping ${blocked.length} blocked`);
          for (let u = 0; u < unaffected.length; u++) {
            planned[i + 1 + u] = unaffected[u]!;
          }
          for (let b = 0; b < blocked.length; b++) {
            planned[i + 1 + unaffected.length + b] = blocked[b]!;
          }
        }

        for (const b of blocked) {
          logWarn(`Skipping ${b.scenario.id} (blocked by failed dependency ${scenario.id})`);
          b.skipExecution = true;
          result.errors.push(`Skipped: ${b.scenario.id} (dependency ${scenario.id} failed)`);
        }

        continue;
      }

      // For replace_ct: discover new VM ID. Pass step.hostname so the lookup
      // disambiguates between siblings of the same application (e.g. nginx
      // tests run with hostnames nginx-default, nginx-acme, nginx-oidc-ssl,
      // nginx-reconf-addons-on, nginx-reconf-addons-off — all share
      // application-id=nginx, so without hostname the lowest-VMID match wins
      // and we record the wrong container).
      if (isReplaceCt) {
        const newVm = await findExistingVm(apiUrl, veHost, scenario.application, config.pveHost, config.portPveSsh, step.hostname);
        if (newVm) {
          logOk(`replace_ct: new VM_ID=${newVm.vm_id} (was ${step.vmId})`);
          step.vmId = newVm.vm_id;
        }
      }

      // Block until lxc-attach actually works on the (possibly freshly
      // replaced) container. `pct status: running` flips early — the
      // kernel can be done bringing up the LXC engine state long before
      // init/cgroup are responsive. Without this gate the next pipeline
      // step (or the very next scenario, e.g. docker-compose's reconfigure
      // pre-pull which `lxc-attach`es into the previous container) races
      // init startup and fails with
      //   "lxc-attach: 406 Connection refused - Failed to get init pid"
      // Applies to all frameworks — oci-image and docker-compose alike;
      // hidden host-only apps (vm_id=0) and dependency steps that were
      // skipped (via snapshot restore) skip this poll.
      if (!isHiddenApp && step.vmId > 0 && cliResult.exitCode === 0) {
        const initWait = await waitForLxcInit(config.pveHost, config.portPveSsh, step.vmId, 30);
        if (!initWait.ok) {
          logWarn(`LXC ${step.vmId} init not responsive after 30s: ${initWait.lastError}`);
        } else if (initWait.waitedMs > 1500) {
          // Don't log the fast path (sub-1.5s) to keep output clean; surface
          // only when the race window actually mattered.
          logInfo(`LXC ${step.vmId} init responsive after ${initWait.waitedMs}ms`);
        }
      }

      logOk(`Container ready: VM_ID=${step.vmId}, hostname=${step.hostname}`);
      result.steps.push({
        vmId: step.vmId, hostname: step.hostname,
        application: scenario.application, scenarioId: scenario.id,
        cliOutput: cliResult.output,
      });

      // After Zitadel installation: load test-deployer credentials from the
      // oidc_<stack> stack (Zitadel emits DEPLOYER_OIDC_* as provides during
      // its post_start templates — same mechanism every addon-oidc consumer
      // uses to wire its container envs).
      if (scenario.application === "zitadel" && task === "installation" && !oidcCredentials) {
        oidcCredentials = await loadOidcCredsFromStack(step.stackName);
        if (oidcCredentials) {
          logOk(`Test OIDC deployer credentials loaded from oidc_${step.stackName} stack`);
        } else {
          logInfo(`OIDC credentials not in oidc_${step.stackName} stack (delegated access not available)`);
        }
      }

      // Wait for services. Docker-compose apps use waitForServices to poll
      // `docker ps` for "Up" status. Non-docker-compose apps already had their
      // wait period (with `pct status` polling) before the failure check above.
      if (waitSeconds > 0 && isDockerCompose) {
        await waitForServices(config.pveHost, config.portPveSsh, step.vmId, waitSeconds, { info: logInfo, ok: logOk, warn: logWarn });
      }

      // Verify
      const defaultVerify = buildDefaultVerify(scenario, appMeta);
      const finalVerify = { ...defaultVerify, ...(scenario.verify ?? {}) };
      for (const [k, v] of Object.entries(finalVerify)) {
        if (v === false) delete finalVerify[k];
      }
      logInfo("Verifying...");
      await verifier.runAll(step.vmId, step.hostname, finalVerify, planned);

      // Optional Playwright spec(s) — runs after verifications pass. The
      // browser server is reached via PLAYWRIGHT_WS (port-forwarded outer
      // PVE), the app under test is addressed by container hostname (the
      // remote browser is on the same vmbr1 network and resolves it via
      // dnsmasq). Specs receive APP_HOSTNAME and decide port/scheme based
      // on app convention. Opt-out via LIVETEST_SKIP_PLAYWRIGHT=1.
      let playwrightFailed = false;
      if (
        scenario.playwright_spec &&
        process.env.LIVETEST_SKIP_PLAYWRIGHT !== "1"
      ) {
        const specs = Array.isArray(scenario.playwright_spec)
          ? scenario.playwright_spec
          : [scenario.playwright_spec];
        const usesSsl = (scenario.selectedAddons ?? []).includes("addon-ssl");
        const instanceFile = path.join(projectRoot, "e2e/.current-instance");
        const instance = existsSync(instanceFile)
          ? readFileSync(instanceFile, "utf-8").trim()
          : "yellow";
        const playwrightEnv: Record<string, string> = {
          ...collectScenarioEnv({
            instance,
            pveHost: config.pveHost,
            pveSshPort: config.portPveSsh,
            projectRoot,
            appHostname: step.hostname,
            appVmId: step.vmId,
            appHttps: usesSsl,
          }),
        };
        // Forward Zitadel test-deployer credentials so the spec's
        // getDeployerToken() fixture can do client_credentials grant.
        if (oidcCredentials) {
          // scenario-executor's port-forward rewrite only replaces the
          // bare hostname, leaving a stray ".local" tail when the source URL
          // ended on a hostname.local TLD. Strip it so URL parsing works.
          const cleanIssuer = oidcCredentials.issuerUrl
            .replace(/\.local(?=[/:]|$)/, "");
          playwrightEnv.OIDC_ISSUER_URL = cleanIssuer;
          playwrightEnv.DEPLOYER_OIDC_MACHINE_CLIENT_ID =
            oidcCredentials.clientId;
          playwrightEnv.DEPLOYER_OIDC_MACHINE_CLIENT_SECRET =
            oidcCredentials.clientSecret;
        }

        // Pre-step: grant the test-deployer machine user all roles of all
        // currently-existing OIDC projects on the *specific* Zitadel instance
        // this scenario depends on. We resolve the right Zitadel via
        // scenario.depends_on so test variants targeting different Zitadel
        // deployments (e.g. zitadel/default vs. zitadel/ssl) hit the matching
        // one instead of whichever container `pct list` returns first.
        //
        // Tests that need an authenticated OIDC session MUST declare a
        // dependency on a zitadel scenario; otherwise this step is skipped
        // (the dev-session bypass still validates the token via UserInfo, so
        // it can succeed if no OIDC_REQUIRED_ROLE is enforced).
        try {
          const zitadelDep = (scenario.depends_on ?? [])
            .map((depId) => planned.find((p) => p.scenario.id === depId))
            .find((p) => p?.scenario.application === "zitadel");
          if (!zitadelDep) {
            logWarn(
              `No zitadel/* in depends_on of ${scenario.id} — skipping test-deployer grant refresh`,
            );
          } else {
            const grantScriptPath = path.join(
              projectRoot,
              "livetest-local/applications/zitadel/scripts/post-grant-test-deployer-all-roles.sh",
            );
            if (existsSync(grantScriptPath)) {
              const zitadelHostname = zitadelDep.hostname;
              const usesSslZitadel = (zitadelDep.scenario.selectedAddons ?? [])
                .includes("addon-ssl");
              const rendered = readFileSync(grantScriptPath, "utf-8")
                .replace(/\{\{\s*hostname\s*\}\}/g, zitadelHostname)
                .replace(/\{\{\s*project_domain_suffix\s*\}\}/g, "")
                .replace(
                  /\{\{\s*ssl_mode\s*\}\}/g,
                  usesSslZitadel ? "certs" : "",
                );
              logInfo(
                `Granting test-deployer all project roles on ${zitadelDep.scenario.id} (CT ${zitadelDep.vmId})...`,
              );
              nestedSshStrict(
                config.pveHost,
                config.portPveSsh,
                `pct exec ${zitadelDep.vmId} -- sh -s`,
                60000,
                rendered,
              );
              logOk("test-deployer grants refreshed");
            }
          }
        } catch (err) {
          // Non-fatal: the grant refresh may legitimately fail when zitadel
          // is already hardened (PAT gone). The dev-session bypass works
          // without role updates if no OIDC_REQUIRED_ROLE is enforced.
          logWarn(
            `test-deployer grant refresh failed (continuing): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Per-scenario artifact dir: lives next to the backend bundle so
        // everything related to the failing run sits in one place. Playwright
        // writes trace.zip / screenshot / video / report.json here (see
        // playwright.config.ts), and we mirror its stdout/stderr into
        // playwright-output.log so the spec's own assertion text is preserved
        // without needing to scroll the terminal.
        const scenarioResultDir = resultWriter
          ? path.join(resultWriter.getOutputDir(), scenario.id.replace("/", "-"))
          : path.join(projectRoot, "livetest-results", "_no-writer", scenario.id.replace("/", "-"));
        const pwArtifactsDir = path.join(scenarioResultDir, "playwright-artifacts");
        const pwLogPath = path.join(scenarioResultDir, "playwright-output.log");
        try { writeFileSync(pwLogPath, ""); } catch { /* dir may not exist yet — runner creates it */ }

        for (const spec of specs) {
          const specPath = path.join(
            "json/applications",
            scenario.application,
            "tests/playwright",
            spec,
          );
          const absSpec = path.join(projectRoot, specPath);
          if (!existsSync(absSpec)) {
            throw new Error(
              `playwright_spec missing: ${specPath} (resolved to ${absSpec})`,
            );
          }
          logInfo(`Playwright: ${specPath} (artifacts → ${path.relative(projectRoot, pwArtifactsDir)})`);
          const proc = spawnSync(
            "pnpm",
            ["run", "test:applications", "--", specPath],
            {
              cwd: projectRoot,
              env: {
                ...process.env,
                ...playwrightEnv,
                PLAYWRIGHT_OUTPUT_DIR: pwArtifactsDir,
              },
              stdio: "pipe",
              encoding: "utf-8",
            },
          );
          // Mirror to terminal (so the live run is still watchable) AND
          // persist to disk for the bundle.
          const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
          process.stdout.write(combined);
          try {
            const { appendFileSync, mkdirSync } = await import("node:fs");
            mkdirSync(scenarioResultDir, { recursive: true });
            appendFileSync(
              pwLogPath,
              `\n=== ${specPath} (exit ${proc.status}) ===\n${combined}`,
            );
          } catch { /* non-fatal — we still threw above */ }
          if (proc.status !== 0) {
            // Write a `status: failed` result so the bundle (test-result.md +
            // artifacts) is accessible post-mortem, then mark this scenario
            // failed and move on. Previously we threw, which aborted the
            // entire --all run on the first failing spec.
            const errMsg = `Playwright spec failed: ${specPath} (exit ${proc.status})`;
            if (resultWriter) {
              await resultWriter.write(TestResultWriter.buildResult({
                runId: resultWriter.getRunId(),
                scenarioId: scenario.id, application: scenario.application, task,
                status: "failed", vmId: step.vmId, hostname: step.hostname,
                stackName: step.stackName, addons: scenario.selectedAddons ?? [],
                startedAt: stepStartTime, finishedAt: new Date(),
                deployerVersion, deployerGitHash,
                commandLine: resultWriter.getCommandLine(),
                dependencies: [], verifyResults: {}, errorMessage: errMsg,
                ...(cliResult.restartKey ? { restartKey: cliResult.restartKey } : {}),
              }));
            }
            logFail(errMsg);
            result.errors.push(errMsg);
            result.failed++;
            playwrightFailed = true;
            break;  // skip remaining specs for this scenario, fall through to cleanup below
          }
          logOk(`Playwright passed: ${specPath}`);
        }
      }
      if (playwrightFailed) continue;

      // Write test result
      if (resultWriter) {
        const depInfos: TestResultDependency[] = (scenario.depends_on ?? []).map((depId) => {
          const depStep = planned.find((p) => p.scenario.id === depId);
          const depApp = depId.split("/")[0] ?? "";
          const prefix = depApp.toUpperCase().replace(/-/g, "_");
          let version = cliResult.resolvedVersions.get(prefix) ?? "";
          if (!version && depStep) {
            try {
              const raw = nestedSsh(config.pveHost, config.portPveSsh,
                `sed -n 's/.*proxvex%3Aversion \\([^ <]*\\).*/\\1/p' /etc/pve/lxc/${depStep.vmId}.conf 2>/dev/null | head -1`,
                5000);
              version = decodeURIComponent(raw.trim());
            } catch { /* ignore */ }
          }
          return {
            scenario_id: depId, vm_id: depStep?.vmId ?? 0,
            status: "passed" as const, version,
            snapshot_used: snapMgr ? "dep-stacks-ready" : null,
            snapshot_date: null,
          };
        });
        await resultWriter.write(TestResultWriter.buildResult({
          runId: resultWriter.getRunId(),
          scenarioId: scenario.id, application: scenario.application, task,
          status: "passed", vmId: step.vmId, hostname: step.hostname,
          stackName: step.stackName, addons: scenario.selectedAddons ?? [],
          startedAt: stepStartTime, finishedAt: new Date(),
          deployerVersion, deployerGitHash,
          commandLine: resultWriter.getCommandLine(),
          dependencies: depInfos,
          verifyResults: Object.fromEntries(
            Object.entries(finalVerify).map(([k, v]) => [k, !!v]),
          ),
          ...(cliResult.restartKey ? { restartKey: cliResult.restartKey } : {}),
        }));
      }

      // Consumer-test success: destroy the consumer LXC. Provider LXCs stay
      // alive for subsequent consumer tests. Test-level cleanup (e.g. dropping
      // a database in postgres) is handled separately via test.json `cleanup`.
      //
      // Phase 2 caveat: docker-compose in-place upgrade reassigns step.vmId
      // to the source's VMID (see in-place block above). If the source is a
      // dependency for downstream consumers (e.g. postgrest/reconf-ssl also
      // depends on postgrest/ssl), destroying step.vmId here tears down the
      // shared source. Skip cleanup when step.vmId matches any planned-dep's
      // vmId — the dep cleanup at end-of-run handles those CTs.
      const isSharedSourceVm = planned.some(
        (p) => p.scenario.id !== scenario.id && p.vmId === step.vmId,
      );
      if (snapMgr && !step.isDependency && !step.skipExecution && !isSharedSourceVm) {
        try {
          nestedSsh(config.pveHost, config.portPveSsh,
            `pct stop ${step.vmId} 2>/dev/null; pct destroy ${step.vmId} --force --purge 2>/dev/null; true`,
            30000);
        } catch { /* ignore */ }
      } else if (isSharedSourceVm) {
        logInfo(`Skipping cleanup of VM ${step.vmId} — shared with another planned scenario (in-place upgrade source)`);
      }

      // After the LAST stack-provider step, create the single dep-stacks-ready
      // snapshot on the host PVE. All subsequent consumer tests use this as
      // their failure-rollback target. Encode the full captured dep set in the
      // description so the next run can verify the snapshot covers its needs
      // (see SnapshotManager.coversRun).
      if (snapMgr && step.isDependency && !step.skipExecution
          && planned.slice(i + 1).every((p) => !p.isDependency)) {
        try {
          const capturedDeps = planned
            .filter((p) => p.isDependency)
            .map((p) => p.scenario.application);
          snapMgr.createHostSnapshot("dep-stacks-ready", buildHash, capturedDeps);
        } catch (err) {
          logInfo(`Snapshot creation failed (non-fatal): ${err}`);
        }
      }
      } catch (iterErr) {
        // Uncaught exception during this scenario — turn it into a "failed"
        // result so the run continues with the remaining scenarios. The
        // partitionAfterFailure logic above (used by the cliResult.exitCode !== 0
        // path) is bypassed here because we may have thrown before reaching it,
        // so blocked downstream scenarios will simply fail their own pre-flight
        // checks rather than being marked "skipped" — that's acceptable for the
        // crash path (better than zero results).
        const errMsg = `Scenario crashed: ${scenario.id} (${task}): ${iterErr instanceof Error ? iterErr.message : String(iterErr)}`;
        logFail(errMsg);
        if (iterErr instanceof Error && iterErr.stack) {
          logInfo(iterErr.stack);
        }
        result.errors.push(errMsg);
        result.failed++;
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        if (resultWriter) {
          try {
            await resultWriter.write(TestResultWriter.buildResult({
              runId: resultWriter.getRunId(),
              scenarioId: scenario.id, application: scenario.application, task,
              status: "failed", vmId: step.vmId, hostname: step.hostname,
              stackName: step.stackName, addons: scenario.selectedAddons ?? [],
              startedAt: stepStartTime, finishedAt: new Date(),
              deployerVersion, deployerGitHash,
              commandLine: resultWriter.getCommandLine(),
              dependencies: [], verifyResults: {}, errorMessage: errMsg,
            }));
          } catch { /* result write failure — already logging the throw above */ }
        }
        if (options?.failFast) {
          throw iterErr;
        }
      } finally {
        // Phase 2: destroy any source clones we made for this scenario.
        // Runs on pass, fail AND crash so isolated clones never leak across
        // the --all run. KEEP_VM=1 preserves them for post-mortem inspection
        // (same flag honoured for the main consumer CT below).
        if (process.env.KEEP_VM) {
          for (const cloneVmId of sourceCloneVmIds) {
            logInfo(`KEEP_VM set — preserving source clone VM ${cloneVmId} for inspection`);
          }
        } else {
          for (const cloneVmId of sourceCloneVmIds) {
            try {
              nestedSsh(
                config.pveHost, config.portPveSsh,
                `pct stop ${cloneVmId} 2>/dev/null; pct unlock ${cloneVmId} 2>/dev/null; pct destroy ${cloneVmId} --force --purge 2>/dev/null; true`,
                30000,
              );
              logInfo(`Destroyed source clone VM ${cloneVmId}`);
            } catch { /* best-effort */ }
          }
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  result.passed = verifier.passed;
  result.failed += verifier.failed;
  return result;
}

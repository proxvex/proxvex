/**
 * Shared type definitions for the live integration test runner.
 */

// ── Constants ──

export const VM_ID_START = 200;

// ── Types ──

/** One scenario from <app>/tests/test.json */
export interface TestScenario {
  description: string;
  depends_on?: string[];
  task?: string;
  vm_id?: number;
  addons?: string[];
  wait_seconds?: number;
  cli_timeout?: number;
  verify?: Record<string, boolean | number | string>;
  cleanup?: Record<string, string>;
  /** Override stack name (default: derived from scenario id variant). Use when
   * a reconfigure-only scenario (e.g. proxmox/oidc-ssl) needs to join the
   * stack of a same-typed dependency (zitadel/default) instead of creating a
   * fresh stack named after its own variant. */
  stack_name?: string;
  /**
   * Templates that are expected to fail with a specific exit code in this
   * scenario. Keys are template filenames (e.g. "342-foo.json"), values are
   * the expected non-zero exit code. The test passes for that entry only if
   * the template ran AND exited with exactly that code. A different exit
   * code (including 0) or "never ran" both fail the test.
   */
  expect2fail?: Record<string, number>;
  /**
   * Templates that MAY fail with a specific exit code without breaking the
   * scenario. Keys are template filenames, values are the tolerated non-zero
   * exit code. Unlike `expect2fail` (which *requires* the template to fail),
   * `allowed2fail` only relaxes a failure: if the template exits 0 the
   * scenario continues normally; if it exits with the listed code the
   * scenario still passes; any other non-zero exit is a real failure.
   *
   * Use case: an early gate template that fails when an env-driven
   * precondition isn't met (e.g. CF_TOKEN_TEST unset for nginx/acme-real),
   * so the scenario green-passes in unconfigured environments but exercises
   * the full pipeline when the env is set.
   */
  allowed2fail?: Record<string, number>;
  /**
   * Free-form tags for scenario selection. Used by `--tag` / `--set` filters in
   * the runner. Conventional vocabulary: `cost:quick`, `cost:slow`,
   * `needs:internet`, `needs:cf-token`, `coverage:critical`,
   * `coverage:representative`. Computed tags (`app:*`, `base:*`, `addon:*`,
   * `task:*`, `coverage:essentials`) are injected at runtime and should NOT be
   * stored here.
   */
  tags?: string[];
  /**
   * If set, the scenario cannot be automated (e.g. requires audio/USB/serial
   * hardware passthrough). The string is a human-readable reason. Untestable
   * scenarios are excluded from all preset runs by default; use
   * `--include-untestable` to override.
   */
  untestable?: string;
  /**
   * Optional Playwright spec(s) to run against the deployed application after
   * the scenario's own verifications pass. String for a single spec, array
   * for multiple. Files live at
   * `json/applications/<app>/tests/playwright/<spec>`. Skipped when
   * env LIVETEST_SKIP_PLAYWRIGHT=1 is set.
   */
  playwright_spec?: string | string[];

  /**
   * Environment variables that must be set (and non-empty) on the dev box
   * before this scenario is selectable. The runner drops the scenario from
   * the plan with a warning when any of these are missing. Use for
   * scenarios that need real-world credentials the source tree can't ship
   * (e.g. `["CF_TOKEN"]` for ACME Cloudflare DNS-01 challenges).
   */
  requires_env?: string[];

  /**
   * Declares how this upgrade/reconfigure scenario interacts with its source
   * (the CT named in depends_on as a same-application entry).
   *
   * - `isolate` (default for upgrade + reconfigure): before running, the
   *   runner takes a host-side `pct clone` of the source CT into a private
   *   throw-away CT and feeds *that* into the scenario as `previous_vm_id`.
   *   The original source stays untouched and is available to subsequent
   *   consumers (e.g. postgrest/upgrade-ssl can still find postgrest/ssl
   *   intact after postgrest/reconf-ssl has run).
   * - `in-place`: the scenario modifies the source CT directly (no clone).
   *   Required for docker-compose `upgrade` where `vm_id = previous_vm_id`
   *   is set explicitly by scenario-executor and a clone would orphan the
   *   docker-compose state.
   * - `shared`: legacy behaviour — pre-Phase-2. No isolation. Use only when
   *   you need to inspect the actual destructive sequence (e.g. debugging
   *   replace-ct).
   *
   * Installation scenarios ignore this field.
   */
  consumes_source?: "isolate" | "in-place" | "shared";

  /**
   * When true, the runner resolves `previous_vm_id` by finding the CT on
   * the PVE host that carries the `proxvex:deployer-instance` marker
   * (i.e. the running deployer/Hub). Used for the self-upgrade test where
   * the target is whatever CT is currently the deployer — vmid is not
   * known statically. Skips the standard hostname-based existingVm
   * discovery.
   */
  target_deployer_instance?: boolean;

  /**
   * When true, the runner expects this scenario to destroy the deployer-CT
   * mid-run and have a new CT take over its IP+hostname (self-upgrade-via-
   * clone). Used as documentation for now; future runner extensions may
   * use it to trigger additional post-test verification (clone-bundle
   * pull, etc.).
   */
  expect_clone_lifecycle?: boolean;

  /**
   * Reconfigure/upgrade scenarios whose `expect2fail` aborts the pipeline
   * between start and replace-ct. The runner then checks that the failure
   * hook paused the new container (stopped, onboot 0, tagged
   * proxvex-rebuild-of-<source>, source still running), finds it through the
   * Unfinished Rebuilds API and resolves it with the given action, checking
   * the outcome (discard: new container gone, source running; finish: new
   * container running and untagged, source replaced).
   */
  unfinished_rebuild?: "discard" | "finish";

  /**
   * When true, the scenario MUST run against the deployer-LXC inside the
   * nested VM (nested-deployer mode, via `--config <instance>`), not
   * against the local-backend Spoke. Used for self-upgrade tests where
   * the local Node-process "Deployer" can't meaningfully clone itself.
   * In default mode the runner skips the scenario with a hint to re-run
   * via `--config <instance>`.
   */
  run_in_ve?: boolean;

  /**
   * Addons to deactivate via the CLI's `--disable-addons` flag (passes
   * through as `disabledAddons` body param). Triggers the corresponding
   * `conf-disable-<addon>-app.sh` pre_start templates on reconfigure.
   * Used by the disable-OIDC test to actively strip OIDC_* env vars from
   * /config/proxvex.env.
   */
  disabledAddons?: string[];
}

/** Discovered scenario with resolved identity */
export interface ResolvedScenario extends TestScenario {
  id: string;
  application: string;
  /** Params from scenario params file (delivered by API) */
  params?: ParamEntry[];
  selectedAddons?: string[];
  stackId?: string;
  uploads?: { name: string; content: string }[];
  /**
   * Tags computed by the coverage analyzer or runtime: `app:<id>`,
   * `base:<extends>`, `addon:<id>`, `task:<task>`, `coverage:critical`,
   * `coverage:essentials`, `coverage:representative`. Never persisted —
   * derived from app metadata and scenario configuration.
   */
  computedTags?: string[];
  /**
   * Filesystem directory of the application that defines this scenario,
   * e.g. `json/applications/proxvex`. Used by the runtime spec-resolver to
   * walk the `extends` chain when locating Playwright spec files. Set by the
   * coverage analyzer / scenario loader; absent for API-delivered scenarios.
   */
  appDir?: string;
}

/** Planned scenario ready for execution */
export interface PlannedScenario {
  vmId: number;
  hostname: string;
  stackName: string;
  scenario: ResolvedScenario;
  hasStacktype: boolean;
  isDependency: boolean;
  skipExecution: boolean;
  /** Scenario ids added by `addImplicitDestructiveTaskDeps` to gate
   *  upgrade/reconfigure on every same-tree installation. Kept separate
   *  from `scenario.depends_on` so the UI / dependency analysis can show
   *  only the test-authored relations. classifyParallel consults both. */
  implicitDeps?: string[];
}

export interface StepResult {
  vmId: number;
  hostname: string;
  application: string;
  cliOutput?: string;
  scenarioId?: string;
}

export interface TestResult {
  name: string;
  description: string;
  passed: number;
  failed: number;
  steps: StepResult[];
  errors: string[];
}

export interface E2EConfig {
  default: string;
  instances: Record<string, {
    pveHost: string;
    vmId: number;
    vmName: string;
    portOffset: number;
    subnet: string;
    bridge: string;
    /** Inner bridge used by test LXC containers INSIDE the nested VM.
     *  Defaults to `vmbr1` (standard nested-PVE setup). Only set if the
     *  nested VM's internal bridge is named differently. */
    lxcBridge?: string;
    filesystem?: string;
    deployerHost?: string;
    deployerPort?: string;
    veHost?: string;
    veSshPort?: number;
    snapshot?: { enabled: boolean };
    registryMirror?: { dnsForwarder: string };
    portForwarding?: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
    /** Optional Zitadel PAT (UI-generated for a service user with sufficient
     *  org permissions). When set, gets injected as `ZITADEL_PAT` param into
     *  every params.json before the CLI invocation, so OIDC-addon templates
     *  use it instead of the on-LXC /bootstrap/admin-client.pat fallback.
     *  In CI this comes from the secret-vault-loaded config.json; locally
     *  the tester edits e2e/config.json (gitignored). Empty / missing →
     *  templates fall back to admin-client.pat as before. */
    zitadelPat?: string;
  }>;
  defaults: Record<string, unknown>;
  ports: {
    pveWeb: number;
    pveSsh: number;
    deployer: number;
    deployerHttps: number;
  };
}

/**
 * Run mode classification — determined by the positional test argument and
 * snapshot flags. Drives qm-rollback, parallel default, pre-cleanup, and
 * teardown semantics across the runner.
 *
 *  - `all`           — `livetest --all`: qm rollback to deployer-installed,
 *                       parallel default, no teardown, per-catalog-member
 *                       snapshot after success.
 *  - `file`          — `livetest @<file.lst>`: same as `all`, scoped to the
 *                       scenarios listed in the file (plus their deps).
 *  - `snapshot-build`— legacy `livetest --snapshot <name> "<list>"` mode.
 *                       Unchanged Phase-3b behaviour.
 *  - `single`        — explicit single scenario or comma-list/regex selection.
 *                       Always sequential. Pre-cleanup deletes non-snapshot,
 *                       non-needed CTs. Per-catalog-member snapshot still runs.
 */
export type RunMode = "all" | "file" | "single" | "snapshot-build";

/**
 * Sanitize a scenario id (e.g. "zitadel/default") into a pct-snapshot-safe
 * name (e.g. "zitadel-default"). pct snapshot names must be valid filesystem
 * component characters — `/` is the only id-internal character that is not.
 */
export function sanitizeScenarioIdForSnapshot(id: string): string {
  return id.replace(/\//g, "-");
}

/**
 * Resolve the dependency-snapshot name for a run, or `null` when no
 * dependency snapshot may be created/restored.
 *
 * Strategy (see plan residuum-separat-pre-existing-curried-leaf):
 * the single global `dep-stacks-ready` snapshot is replaced by a
 * per-target-application snapshot `<app>_deps`. It is only valid for an
 * explicitly-selected single-application run — there the tested app is always
 * a *target* (never a dependency), so its dependency state (e.g. postgres) is
 * clean by construction at snapshot time. A `--all` run, or any run spanning
 * more than one selected application, gets NO dependency snapshot (those go
 * the parallelisation route instead) so a broad run can never bake a
 * consumer's state into a snapshot a narrow run would later reuse.
 *
 * @param testArg     the positional test argument (e.g. "--all", "zitadel/default")
 * @param planned     the planned scenarios
 * @param selectedIds the set of explicitly-selected scenario ids (NOT the
 *                    transitively-pulled dependencies)
 */
export function resolveDepSnapshotName(
  testArg: string,
  planned: PlannedScenario[],
  selectedIds: Set<string>,
): string | null {
  if (testArg === "--all") return null;
  const selectedApps = new Set(
    planned
      .filter((p) => selectedIds.has(p.scenario.id))
      .map((p) => p.scenario.application),
  );
  if (selectedApps.size !== 1) return null;
  const [app] = [...selectedApps];
  return `${app}_deps`;
}

/** Param entry in a scenario params file */
export interface ParamEntry {
  name: string;
  value?: string;
  append?: string;
}

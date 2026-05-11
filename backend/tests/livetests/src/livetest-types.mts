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

/** Param entry in a scenario params file */
export interface ParamEntry {
  name: string;
  value?: string;
  append?: string;
}

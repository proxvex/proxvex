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

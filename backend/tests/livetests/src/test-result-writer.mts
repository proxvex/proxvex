/**
 * Writes per-scenario test results as PostgREST-compatible JSON files.
 * Each file can be directly POST'd to a PostgREST endpoint for storage.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LogSummary } from "./diagnostics.mjs";

export interface TestResultDependency {
  scenario_id: string;
  vm_id: number;
  status: "passed" | "failed" | "skipped";
  version: string;
  snapshot_used: string | null;
  snapshot_date: string | null;
}

export interface TestResultData {
  run_id: string;
  scenario_id: string;
  application: string;
  variant: string;
  task: string;
  status: "passed" | "failed" | "skipped";
  vm_id: number;
  hostname: string;
  stack_name: string;
  addons: string[];
  duration_seconds: number;
  started_at: string;
  finished_at: string;
  deployer_version: string;
  deployer_git_hash: string;
  command_line: string;
  dependencies: TestResultDependency[];
  verify_results: Record<string, boolean>;
  error_message: string | null;
  skipped_reason: string | null;
  logs?: LogSummary[];
}

const FILTER_MAX_LEN = 30;

function sanitizeFilter(filterArg: string): string {
  let slug = filterArg.replace(/^-+/, "").replace(/\//g, "-").replace(/[^A-Za-z0-9_-]/g, "_");
  if (slug.length === 0) slug = "all";
  return slug.slice(0, FILTER_MAX_LEN);
}

export class TestResultWriter {
  private outputDir: string;
  private runId: string;
  private commandLine: string;

  constructor(baseDir: string, instanceName: string, filterArg: string, commandLine: string) {
    const unix = Math.floor(Date.now() / 1000);
    const filterSlug = sanitizeFilter(filterArg);
    this.runId = `${unix}-${instanceName}-${filterSlug}`;
    this.outputDir = path.join(baseDir, "livetest-results", this.runId);
    this.commandLine = commandLine;
    mkdirSync(this.outputDir, { recursive: true });
  }

  getRunId(): string {
    return this.runId;
  }

  getOutputDir(): string {
    return this.outputDir;
  }

  getCommandLine(): string {
    return this.commandLine;
  }

  write(data: TestResultData): void {
    const filename = `${data.scenario_id.replace(/\//g, "-")}.json`;
    writeFileSync(
      path.join(this.outputDir, filename),
      JSON.stringify(data, null, 2),
    );
  }

  /**
   * Build a TestResultData object from scenario execution context.
   */
  static buildResult(opts: {
    runId: string;
    scenarioId: string;
    application: string;
    task: string;
    status: "passed" | "failed" | "skipped";
    vmId: number;
    hostname: string;
    stackName: string;
    addons: string[];
    startedAt: Date;
    finishedAt: Date;
    deployerVersion: string;
    deployerGitHash: string;
    commandLine: string;
    dependencies: TestResultDependency[];
    verifyResults: Record<string, boolean>;
    errorMessage?: string;
    skippedReason?: string;
    logs?: LogSummary[];
  }): TestResultData {
    const variant = opts.scenarioId.split("/")[1] ?? "default";
    const result: TestResultData = {
      run_id: opts.runId,
      scenario_id: opts.scenarioId,
      application: opts.application,
      variant,
      task: opts.task,
      status: opts.status,
      vm_id: opts.vmId,
      hostname: opts.hostname,
      stack_name: opts.stackName,
      addons: opts.addons,
      duration_seconds: Math.round((opts.finishedAt.getTime() - opts.startedAt.getTime()) / 1000),
      started_at: opts.startedAt.toISOString(),
      finished_at: opts.finishedAt.toISOString(),
      deployer_version: opts.deployerVersion,
      deployer_git_hash: opts.deployerGitHash,
      command_line: opts.commandLine,
      dependencies: opts.dependencies,
      verify_results: opts.verifyResults,
      error_message: opts.errorMessage ?? null,
      skipped_reason: opts.skippedReason ?? null,
    };
    if (opts.logs && opts.logs.length > 0) {
      result.logs = opts.logs;
    }
    return result;
  }
}

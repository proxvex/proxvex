/**
 * Writes per-scenario livetest artefacts into `livetest-results/<runId>/<scenarioId>/`.
 *
 * Per scenario the writer produces:
 *   - test-result.md     — TestResultData embedded as a JSON code block (the
 *                          old PostgREST-compatible payload). Sed/awk can
 *                          extract it for downstream upload.
 *   - host-diagnostics.md — LogSummary[] in human + machine form (replaces
 *                          the standalone `logs` field).
 *   - livetest-index.md  — points at test-result + host-diagnostics, and at
 *                          the backend-side debug bundle (index.md /
 *                          scripts/ / variables.md) when one is available.
 *
 * If `restartKey` is set on the TestResultData and the writer has an
 * `apiUrl`, the writer additionally pulls the per-task debug bundle from
 * `GET /api/ve/debug/:restartKey/*` and drops every file alongside in the
 * same scenario directory.
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
  /** Backend restartKey — when set the writer pulls the debug bundle. */
  restart_key?: string;
}

const FILTER_MAX_LEN = 30;

function sanitizeFilter(filterArg: string): string {
  let slug = filterArg.replace(/^-+/, "").replace(/\//g, "-").replace(/[^A-Za-z0-9_-]/g, "_");
  if (slug.length === 0) slug = "all";
  return slug.slice(0, FILTER_MAX_LEN);
}

function sanitizeScenarioId(id: string): string {
  return id.replace(/\//g, "-").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export class TestResultWriter {
  private outputDir: string;
  private runId: string;
  private commandLine: string;
  private apiUrl: string | undefined;

  constructor(
    baseDir: string,
    instanceName: string,
    filterArg: string,
    commandLine: string,
    apiUrl?: string,
  ) {
    const unix = Math.floor(Date.now() / 1000);
    const filterSlug = sanitizeFilter(filterArg);
    this.runId = `${unix}-${instanceName}-${filterSlug}`;
    this.outputDir = path.join(baseDir, "livetest-results", this.runId);
    this.commandLine = commandLine;
    this.apiUrl = apiUrl;
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

  /**
   * Write the artefact bundle for a single scenario. Async because it may
   * fetch the backend debug bundle. Errors during the bundle fetch are
   * swallowed — the test-result.md is still produced.
   */
  async write(data: TestResultData): Promise<void> {
    const dir = path.join(this.outputDir, sanitizeScenarioId(data.scenario_id));
    mkdirSync(dir, { recursive: true });

    // 1) test-result.md — the canonical JSON record stays embedded so that
    // a PostgREST upload pipeline can recover it via sed/awk.
    writeFileSync(path.join(dir, "test-result.md"), renderTestResultMd(data));

    // 2) host-diagnostics.md — only when we have LogSummary entries.
    if (data.logs && data.logs.length > 0) {
      writeFileSync(
        path.join(dir, "host-diagnostics.md"),
        renderHostDiagnostics(data.logs),
      );
    }

    // 3) Backend debug bundle (optional) — pulled when restart_key + apiUrl
    // are both available. Each file is written verbatim to preserve the
    // relative-link structure (e.g. scripts/01-foo.md → ../index.md).
    let bundleNote = "";
    if (data.restart_key && this.apiUrl) {
      const fetched = await this.fetchBundle(data.restart_key, dir);
      if (fetched.length > 0) {
        bundleNote = `Backend bundle (${fetched.length} files): see index.md\n`;
      } else {
        bundleNote = `_backend bundle unavailable — debug_level was off, or the bundle expired._\n`;
      }
    } else if (data.restart_key) {
      bundleNote = `_backend bundle skipped — no apiUrl configured for the writer._\n`;
    } else {
      bundleNote = `_no restartKey on this test result — debug bundle could not be fetched._\n`;
    }

    // 4) livetest-index.md — entry point that links the rest.
    writeFileSync(
      path.join(dir, "livetest-index.md"),
      renderLivetestIndex(data, bundleNote),
    );
  }

  private async fetchBundle(
    restartKey: string,
    targetDir: string,
  ): Promise<string[]> {
    if (!this.apiUrl) return [];
    try {
      const manifestResp = await fetch(
        `${this.apiUrl}/api/ve/debug/${encodeURIComponent(restartKey)}`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!manifestResp.ok) return [];
      const manifest = (await manifestResp.json()) as { files?: string[] };
      const files = manifest.files ?? [];
      const written: string[] = [];
      for (const filePath of files) {
        const fileResp = await fetch(
          `${this.apiUrl}/api/ve/debug/${encodeURIComponent(restartKey)}/${filePath}`,
          { signal: AbortSignal.timeout(10000) },
        );
        if (!fileResp.ok) continue;
        const content = await fileResp.text();
        const target = path.join(targetDir, filePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
        written.push(filePath);
      }
      return written;
    } catch {
      return [];
    }
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
    restartKey?: string;
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
    if (opts.logs && opts.logs.length > 0) result.logs = opts.logs;
    if (opts.restartKey) result.restart_key = opts.restartKey;
    return result;
  }
}

function renderTestResultMd(data: TestResultData): string {
  // The JSON code block must hold exactly the legacy PostgREST-compatible
  // payload so existing upload pipelines (`sed -n '/```json$/,/```$/p'`)
  // recover it without modification.
  const payload: Record<string, unknown> = { ...data };
  // `logs` and `restart_key` belong elsewhere in the bundle — strip them
  // from the canonical block so it stays in sync with the previous schema.
  delete payload.logs;
  delete payload.restart_key;
  return [
    `# Test Result — ${data.scenario_id} (${data.task})`,
    `[↩ index](livetest-index.md)`,
    ``,
    `**status**: \`${data.status}\` · **vm_id**: ${data.vm_id} · **duration**: ${data.duration_seconds}s`,
    ``,
    `## Canonical (machine)`,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    ``,
  ].join("\n");
}

function renderHostDiagnostics(logs: LogSummary[]): string {
  const sections: string[] = [`# Host-side Diagnostics`, ``];
  for (const log of logs) {
    sections.push(`## ${log.name}`);
    if (log.errors.length > 0) {
      sections.push(`**Errors (${log.errors.length}):**`);
      sections.push("```text");
      sections.push(log.errors.join("\n") || "(none)");
      sections.push("```");
    }
    sections.push(`**Last ${log.last_lines.length} lines:**`);
    sections.push("```text");
    sections.push(log.last_lines.join("\n") || "(empty)");
    sections.push("```");
    sections.push(``);
  }
  sections.push(`## Machine`);
  sections.push("```json");
  sections.push(JSON.stringify(logs, null, 2));
  sections.push("```");
  return sections.join("\n");
}

function renderLivetestIndex(data: TestResultData, bundleNote: string): string {
  const lines = [
    `# Livetest — ${data.scenario_id}`,
    `**run**: \`${data.run_id}\` · **status**: \`${data.status}\` · **vm_id**: ${data.vm_id}`,
    ``,
    `## Artifacts`,
    `- [test-result.md](test-result.md) — canonical PostgREST payload`,
  ];
  if (data.logs && data.logs.length > 0) {
    lines.push(`- [host-diagnostics.md](host-diagnostics.md) — LXC log, dmesg, docker logs`);
  }
  if (data.restart_key) {
    lines.push(`- [index.md](index.md) — backend debug bundle (start here)`);
    lines.push(`- [variables.md](variables.md) — variable cross-reference`);
  }
  lines.push(``);
  lines.push(`## Bundle`);
  lines.push(bundleNote.trim());
  return lines.join("\n");
}

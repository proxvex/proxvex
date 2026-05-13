import type { LogLevel } from "../logger/index.mjs";
import type { IVarSubstitution } from "../variable-resolver.mjs";
import type { IVeDebugEvent } from "../ve-execution/ve-execution-message-emitter.mjs";

const RETENTION_MS = 30 * 60 * 1000; // 30 min, matches WebAppVeMessageManager

export type DebugLevel = "off" | "extLog" | "script";

type TraceEvent =
  | {
      ts: number;
      source: "logger";
      level: LogLevel;
      component: string;
      msg: string;
      meta?: Record<string, unknown>;
    }
  | { ts: number; source: "stderr"; line: string }
  | {
      ts: number;
      source: "substitution";
      varName: string;
      redactedValue: string;
      line: number;
      secure: boolean;
    };

interface DebugScript {
  index: number;
  command: string;
  executeOn: string | undefined;
  template?: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  redactedScript: string;
  substitutions: IVarSubstitution[];
}

interface DebugEntry {
  application: string;
  task: string;
  restartKey: string;
  debugLevel: DebugLevel;
  startedAt: number;
  finishedAt?: number;
  scripts: DebugScript[];
  events: TraceEvent[];
}

/**
 * Collects per-task debug information (logger lines, redacted scripts,
 * variable substitutions, script stderr) and renders them as a linked
 * Markdown bundle. RAM-only, expires after 30 minutes.
 *
 * Wiring overview:
 *   - `start()` is called by the route handler at task start with the
 *     restartKey + selected debugLevel.
 *   - `attachLogLine()` is fed from the Logger debug sink.
 *   - `attachStderr()` is fed from the MessageManager listener when a
 *     partial message arrives.
 *   - `attachScriptStart()` / `attachScriptEnd()` are fed from the VeExecution
 *     `"debug"` channel.
 *   - `finish()` marks the entry complete (timestamp).
 *   - `renderBundle()` returns the virtual file map.
 */
export class WebAppDebugCollector {
  private entries: Map<string, DebugEntry> = new Map();
  /** Tracks which restartKey is currently active for the logger sink. */
  private activeRestartKey: string | null = null;

  /** Returns the currently active restartKey (logger sink uses this). */
  getActiveRestartKey(): string | null {
    return this.activeRestartKey;
  }

  start(
    restartKey: string,
    application: string,
    task: string,
    debugLevel: DebugLevel,
  ): void {
    if (debugLevel === "off") return;
    const now = Date.now();
    this.entries.set(restartKey, {
      application,
      task,
      restartKey,
      debugLevel,
      startedAt: now,
      scripts: [],
      events: [],
    });
    this.activeRestartKey = restartKey;
  }

  finish(restartKey: string): void {
    const entry = this.entries.get(restartKey);
    if (!entry) return;
    entry.finishedAt = Date.now();
    if (this.activeRestartKey === restartKey) this.activeRestartKey = null;
  }

  has(restartKey: string): boolean {
    return this.entries.has(restartKey);
  }

  attachLogLine(
    restartKey: string,
    entry: {
      ts: number;
      level: LogLevel;
      component: string;
      message: string;
      meta?: Record<string, unknown>;
    },
  ): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    e.events.push({
      ts: entry.ts,
      source: "logger",
      level: entry.level,
      component: entry.component,
      msg: entry.message,
      ...(entry.meta ? { meta: entry.meta } : {}),
    });
  }

  attachStderr(restartKey: string, line: string): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    // Split multi-line stderr chunks; each line becomes its own event so
    // they interleave cleanly with logger lines.
    const parts = line.split("\n");
    for (const p of parts) {
      if (p.length === 0) continue;
      e.events.push({ ts: Date.now(), source: "stderr", line: p });
    }
  }

  handleDebugEvent(restartKey: string, event: IVeDebugEvent): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    if (event.type === "script-start") {
      e.scripts.push({
        index: event.index,
        command: event.command,
        executeOn: event.executeOn,
        ...(event.template ? { template: event.template } : {}),
        startedAt: event.ts,
        redactedScript: event.redactedScript,
        substitutions: event.substitutions,
      });
      // Also record substitution events so they appear in the trace.
      for (const s of event.substitutions) {
        e.events.push({
          ts: event.ts,
          source: "substitution",
          varName: s.var,
          redactedValue: s.redactedValue,
          line: s.line,
          secure: s.secure,
        });
      }
    } else {
      const script = e.scripts.find((s) => s.index === event.index);
      if (script) {
        script.finishedAt = event.ts;
        script.exitCode = event.exitCode;
      }
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      const ref = entry.finishedAt ?? entry.startedAt;
      if (now - ref > RETENTION_MS) this.entries.delete(key);
    }
  }

  /**
   * Render the bundle for `restartKey` as a virtual file map. Returns null
   * when the entry does not exist (debug was off or expired).
   *
   * The bundle uses two file types:
   *   - `.md`   — for humans. Tables, prose, the redacted script body, the
   *               chronological text trace. Linked together.
   *   - `.json` — for machines. Sidecar files alongside each .md hold the
   *               raw event records (header, substitutions, trace events,
   *               variable cross-reference). The .md links to them; humans
   *               don't need to read them.
   */
  renderBundle(restartKey: string): Map<string, string> | null {
    const entry = this.entries.get(restartKey);
    if (!entry) return null;
    const files = new Map<string, string>();

    // Sort scripts by index for deterministic output
    entry.scripts.sort((a, b) => a.index - b.index);
    const sortedEvents = [...entry.events].sort((a, b) => a.ts - b.ts);

    const buckets = this.bucketEvents(entry, sortedEvents);

    const { md: indexMd, json: headerJson } = this.renderIndex(entry, buckets);
    files.set("index.md", indexMd);
    files.set("header.json", headerJson);

    const { md: variablesMd, json: variablesJson } = this.renderVariables(entry);
    files.set("variables.md", variablesMd);
    files.set("variables.json", variablesJson);

    for (const script of entry.scripts) {
      const slug = slugify(script.command, script.index);
      const base = `${pad2(script.index)}-${slug}`;
      const scriptFiles = this.renderScript(
        script,
        buckets.scripts.get(script.index) ?? [],
        buckets.postTraces.get(script.index) ?? [],
        base,
      );
      files.set(`scripts/${base}.md`, scriptFiles.md);
      files.set(`scripts/${base}.meta.json`, scriptFiles.metaJson);
      files.set(`scripts/${base}.substitutions.json`, scriptFiles.substJson);
      files.set(`scripts/${base}.trace.json`, scriptFiles.traceJson);
    }
    return files;
  }

  /**
   * Distribute trace events into preamble / per-script / post-trace /
   * postamble buckets based on the script start/end timestamps.
   */
  private bucketEvents(
    entry: DebugEntry,
    events: TraceEvent[],
  ): {
    preamble: TraceEvent[];
    postamble: TraceEvent[];
    scripts: Map<number, TraceEvent[]>;
    postTraces: Map<number, TraceEvent[]>;
  } {
    const preamble: TraceEvent[] = [];
    const postamble: TraceEvent[] = [];
    const scripts = new Map<number, TraceEvent[]>();
    const postTraces = new Map<number, TraceEvent[]>();

    if (entry.scripts.length === 0) {
      preamble.push(...events);
      return { preamble, postamble, scripts, postTraces };
    }

    const firstStart = entry.scripts[0]!.startedAt;
    const lastEnd =
      entry.scripts[entry.scripts.length - 1]!.finishedAt ?? Number.MAX_VALUE;

    for (const ev of events) {
      if (ev.ts < firstStart) {
        preamble.push(ev);
        continue;
      }
      if (ev.ts > lastEnd) {
        postamble.push(ev);
        continue;
      }
      // Find script containing this timestamp
      let assignedToScript = false;
      for (const s of entry.scripts) {
        const end = s.finishedAt ?? Number.MAX_VALUE;
        if (ev.ts >= s.startedAt && ev.ts <= end) {
          let arr = scripts.get(s.index);
          if (!arr) {
            arr = [];
            scripts.set(s.index, arr);
          }
          arr.push(ev);
          assignedToScript = true;
          break;
        }
      }
      if (assignedToScript) continue;
      // Event sits in a gap between two scripts → attach to the preceding one
      let precedingIdx = -1;
      for (const s of entry.scripts) {
        if ((s.finishedAt ?? 0) <= ev.ts) precedingIdx = s.index;
        else break;
      }
      if (precedingIdx >= 0) {
        let arr = postTraces.get(precedingIdx);
        if (!arr) {
          arr = [];
          postTraces.set(precedingIdx, arr);
        }
        arr.push(ev);
      } else {
        preamble.push(ev);
      }
    }
    return { preamble, postamble, scripts, postTraces };
  }

  private renderIndex(
    entry: DebugEntry,
    buckets: ReturnType<WebAppDebugCollector["bucketEvents"]>,
  ): { md: string; json: string } {
    const duration =
      entry.finishedAt !== undefined ? entry.finishedAt - entry.startedAt : 0;
    const header = {
      application: entry.application,
      task: entry.task,
      restartKey: entry.restartKey,
      debugLevel: entry.debugLevel,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt ?? null,
      durationMs: duration,
      scriptCount: entry.scripts.length,
    };

    const scriptRows = entry.scripts.map((s) => {
      const slug = slugify(s.command, s.index);
      const exit = s.exitCode ?? "?";
      const dur =
        s.finishedAt !== undefined ? `${s.finishedAt - s.startedAt}ms` : "?";
      return `| ${s.index} | \`${escapeMd(s.command)}\` | ${s.executeOn ?? "?"} | ${exit} | ${dur} | [scripts/${pad2(s.index)}-${slug}.md](scripts/${pad2(s.index)}-${slug}.md) |`;
    });

    const md = [
      `# Debug Bundle — ${entry.application} ${entry.task}`,
      `**restartKey**: \`${entry.restartKey}\` · **level**: \`${entry.debugLevel}\` · **duration**: ${duration}ms`,
      ``,
      traceStyleBlock(),
      ``,
      `Machine-readable header: [header.json](header.json)`,
      ``,
      `## Contents`,
      `- [Scripts (chronological)](#scripts-chronological)`,
      `- [Preamble Trace](#preamble-trace)`,
      `- [Postamble Trace](#postamble-trace)`,
      `- [Cross-References](#cross-references)`,
      ``,
      section("Scripts (chronological)"),
      `| # | Command | execute_on | exit | duration | Link |`,
      `|--:|---|---|---:|---:|---|`,
      ...scriptRows,
      ``,
      section("Preamble Trace"),
      `_Events before the first script (backend setup, parameter resolve)._`,
      renderTraceHtml(buckets.preamble),
      ``,
      section("Postamble Trace"),
      `_Events after the last script (cleanup, notes update)._`,
      renderTraceHtml(buckets.postamble),
      ``,
      section("Cross-References"),
      `- [Variables](variables.md) — where each variable is used`,
      ``,
    ].join("\n");

    return { md, json: JSON.stringify(header, null, 2) };
  }

  private renderVariables(entry: DebugEntry): { md: string; json: string } {
    // Aggregate substitutions across scripts: var → [{script, line, secure}]
    type Use = { script: number; line: number; secure: boolean };
    const byVar = new Map<string, Use[]>();
    for (const s of entry.scripts) {
      for (const sub of s.substitutions) {
        let arr = byVar.get(sub.var);
        if (!arr) {
          arr = [];
          byVar.set(sub.var, arr);
        }
        arr.push({ script: s.index, line: sub.line, secure: sub.secure });
      }
    }
    const sortedVars = [...byVar.keys()].sort();
    const sections: string[] = [
      `# Variable Cross-Reference`,
      ``,
      `Machine-readable map: [variables.json](variables.json)`,
      ``,
    ];

    // Variable TOC — clickable links to each variable's own section.
    if (sortedVars.length > 0) {
      sections.push(`## Contents`);
      for (const v of sortedVars) {
        const isSecure = byVar.get(v)!.some((u) => u.secure);
        sections.push(
          `- [${v}${isSecure ? " (secure)" : ""}](#${anchorSlug(v)})`,
        );
      }
      sections.push(``);
    }

    for (const v of sortedVars) {
      const uses = byVar.get(v)!;
      const isSecure = uses.some((u) => u.secure);
      const title = isSecure ? `${v} _(secure)_` : v;
      // Anchor uses the bare variable name so it stays stable regardless of
      // the secure-flag marker we add for humans.
      sections.push(section(title, anchorSlug(v)));
      for (const u of uses) {
        const script = entry.scripts.find((s) => s.index === u.script);
        if (!script) continue;
        const slug = slugify(script.command, script.index);
        sections.push(
          `- [scripts/${pad2(u.script)}-${slug}.md](scripts/${pad2(u.script)}-${slug}.md) — script ${u.script}, line ${u.line}`,
        );
      }
      sections.push(``);
    }

    const machine: Record<string, Use[]> = {};
    for (const [v, uses] of byVar.entries()) machine[v] = uses;

    return { md: sections.join("\n"), json: JSON.stringify(machine, null, 2) };
  }

  private renderScript(
    script: DebugScript,
    traceEvents: TraceEvent[],
    postTraceEvents: TraceEvent[],
    base: string,
  ): { md: string; metaJson: string; substJson: string; traceJson: string } {
    const duration =
      script.finishedAt !== undefined
        ? script.finishedAt - script.startedAt
        : 0;
    const meta = {
      index: script.index,
      command: script.command,
      executeOn: script.executeOn ?? null,
      template: script.template ?? null,
      exitCode: script.exitCode ?? null,
      startedAt: script.startedAt,
      finishedAt: script.finishedAt ?? null,
      durationMs: duration,
    };
    const substMeta = script.substitutions.map((s) => ({
      var: s.var,
      redactedValue: s.redactedValue,
      line: s.line,
      secure: s.secure,
    }));

    const lang = script.redactedScript.startsWith("#!")
      ? script.redactedScript.includes("python")
        ? "python"
        : "sh"
      : "text";

    const machineTrace = traceEvents.map((e) => {
      if (e.source === "logger") {
        return {
          ts: e.ts,
          source: "logger",
          level: e.level,
          component: e.component,
          msg: e.msg,
          ...(e.meta ? { meta: e.meta } : {}),
        };
      }
      if (e.source === "stderr")
        return { ts: e.ts, source: "stderr", line: e.line };
      return {
        ts: e.ts,
        source: "substitution",
        var: e.varName,
        redactedValue: e.redactedValue,
        line: e.line,
        secure: e.secure,
      };
    });

    const md = [
      `# Script ${script.index}: \`${escapeMd(script.command)}\``,
      `**execute_on**: \`${script.executeOn ?? "?"}\` · **exit**: ${script.exitCode ?? "?"} · **duration**: ${duration}ms · [↩ index](../index.md)`,
      `**startedAt**: ${formatTime(script.startedAt)} · **finishedAt**: ${script.finishedAt !== undefined ? formatTime(script.finishedAt) : "?"}`,
      ``,
      traceStyleBlock(),
      ``,
      `Sidecars: [meta](${base}.meta.json) · [substitutions](${base}.substitutions.json) · [trace](${base}.trace.json)`,
      ``,
      `## Contents`,
      `- [Redacted Script](#redacted-script)`,
      `- [Trace (chronological)](#trace-chronological)`,
      `- [Post-Trace](#post-trace)`,
      ``,
      section("Redacted Script"),
      "```" + lang,
      script.redactedScript,
      "```",
      ``,
      section("Trace (chronological)"),
      `_Backend logger lines and script stderr interleaved by timestamp._`,
      renderTraceHtml(traceEvents),
      ``,
      section("Post-Trace"),
      `_Events between the end of this script and the start of the next (if any)._`,
      renderTraceHtml(postTraceEvents),
      ``,
    ].join("\n");

    return {
      md,
      metaJson: JSON.stringify(meta, null, 2),
      substJson: JSON.stringify(substMeta, null, 2),
      traceJson: JSON.stringify(machineTrace, null, 2),
    };
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function slugify(name: string, fallbackIdx: number): string {
  if (!name || !name.trim()) return `script-${fallbackIdx}`;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `script-${fallbackIdx}`;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * Produce a stable anchor slug for in-document links. We emit explicit
 * `<a id="…"></a>` tags rather than relying on the renderer's auto-anchor
 * heuristics (which differ between GitHub, VS Code, and markserv).
 */
function anchorSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Emit an explicit anchor immediately followed by an `##` header. The empty
 * `<a id="…"></a>` is rendered as a no-op by every Markdown viewer but gives
 * us a deterministic jump target.
 */
function section(title: string, anchor?: string): string {
  const slug = anchor ?? anchorSlug(title);
  return `<a id="${slug}"></a>\n## ${title}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One-time-per-document `<style>` block. Wraps a `.trace-block` so toggle
 * checkboxes affect only their sibling `.trace`. Uses `:has()` for scoped
 * filtering — supported by every modern Markdown renderer (VS Code, GitHub,
 * markserv) since 2022.
 */
function traceStyleBlock(): string {
  return [
    "<style>",
    "  .trace-block { margin: 0.5em 0 1.5em 0; }",
    "  .trace-block .filters { margin: 0.25em 0; font-family: sans-serif; font-size: 0.9em; }",
    "  .trace-block .filters label { margin-right: 1em; cursor: pointer; user-select: none; }",
    "  .trace { font-family: monospace; font-size: 0.85em; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }",
    "  .trace .tr { display: block; padding: 1px 0; }",
    "  .trace .ts { color: #888; margin-right: 0.5em; }",
    "  .trace .tag { color: #06b; margin-right: 0.5em; }",
    "  .trace .component { color: #666; margin-right: 0.5em; }",
    "  .trace .msg { color: inherit; }",
    "  .trace .tr.source-stderr .tag { color: #888; }",
    "  .trace .tr.source-subst .tag { color: #a60; }",
    "  .trace .tr.level-debug { color: #888; }",
    "  .trace .tr.level-warn .msg { color: #c80; }",
    "  .trace .tr.level-error .msg { color: #c00; font-weight: bold; }",
    "  /* Toggle rules — scoped to the containing .trace-block via :has() */",
    "  .trace-block:has(.filter-logger:not(:checked)) .tr.source-logger { display: none; }",
    "  .trace-block:has(.filter-stderr:not(:checked)) .tr.source-stderr { display: none; }",
    "  .trace-block:has(.filter-subst:not(:checked))  .tr.source-subst  { display: none; }",
    "  .trace-block:has(.filter-debug:not(:checked))  .tr.level-debug   { display: none; }",
    "  .trace-block:has(.filter-info:not(:checked))   .tr.level-info    { display: none; }",
    "  .trace-block:has(.filter-warn:not(:checked))   .tr.level-warn    { display: none; }",
    "  .trace-block:has(.filter-error:not(:checked))  .tr.level-error   { display: none; }",
    "</style>",
  ].join("\n");
}

/**
 * Render a trace section as semantic HTML with per-source/level CSS classes
 * and a sibling filter-checkbox bar. Toggling a checkbox hides matching
 * rows via the `:has()` rules defined in `traceStyleBlock()`.
 *
 * Empty traces render as a single muted line — no checkboxes needed.
 */
function renderTraceHtml(events: TraceEvent[]): string {
  if (events.length === 0) {
    return `<div class="trace-block"><div class="trace empty"><em>(no events)</em></div></div>`;
  }

  // Collect which categories are present so we only show relevant filters.
  const present = {
    logger: false,
    stderr: false,
    subst: false,
    debug: false,
    info: false,
    warn: false,
    error: false,
  };
  for (const e of events) {
    if (e.source === "logger") {
      present.logger = true;
      present[e.level as "debug" | "info" | "warn" | "error"] = true;
    } else if (e.source === "stderr") present.stderr = true;
    else if (e.source === "substitution") present.subst = true;
  }

  const filters: string[] = [];
  const filter = (cls: string, label: string) =>
    `<label><input type="checkbox" class="${cls}" checked /> ${label}</label>`;
  if (present.logger) filters.push(filter("filter-logger", "Logger"));
  if (present.stderr) filters.push(filter("filter-stderr", "Stderr"));
  if (present.subst) filters.push(filter("filter-subst", "Substitutions"));
  // Level toggles only meaningful when there's logger output
  if (present.logger) {
    if (present.debug) filters.push(filter("filter-debug", "debug"));
    if (present.info) filters.push(filter("filter-info", "info"));
    if (present.warn) filters.push(filter("filter-warn", "warn"));
    if (present.error) filters.push(filter("filter-error", "error"));
  }

  const rows = events.map((e) => {
    const t = formatTime(e.ts);
    if (e.source === "logger") {
      return `<div class="tr source-logger level-${e.level}"><span class="ts">${t}</span><span class="tag">[${e.level}]</span><span class="component">[${escapeHtml(e.component)}]</span><span class="msg">${escapeHtml(e.msg)}</span></div>`;
    }
    if (e.source === "stderr") {
      return `<div class="tr source-stderr"><span class="ts">${t}</span><span class="tag">[stderr]</span><span class="msg">${escapeHtml(e.line)}</span></div>`;
    }
    const secureMark = e.secure ? " (secure)" : "";
    return `<div class="tr source-subst"><span class="ts">${t}</span><span class="tag">[subst]</span><span class="msg">${escapeHtml(e.varName)}=${escapeHtml(e.redactedValue)}${secureMark} (line ${e.line})</span></div>`;
  });

  return [
    `<div class="trace-block">`,
    `  <div class="filters">${filters.join(" ")}</div>`,
    `  <div class="trace">`,
    ...rows.map((r) => `    ${r}`),
    `  </div>`,
    `</div>`,
  ].join("\n");
}

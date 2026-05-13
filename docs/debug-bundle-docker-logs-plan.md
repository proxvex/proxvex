# Plan: Docker-Logs ins Debug-Bundle integrieren

**Status**: vorgeschlagen, nicht implementiert
**Aufwand**: ~2.3 h (Range 2–3.5 h mit Debugging)
**Voraussetzung**: Extended-Logging-Feature ist gemerged

## Kontext

Das `WebAppDebugCollector`-Bundle ([backend/src/webapp/webapp-debug-collector.mts](../backend/src/webapp/webapp-debug-collector.mts)) zeichnet heute Backend-Logger-Lines und Script-Stderr in den Per-Script-Traces auf. Für docker-compose-Applikationen entstehen die *interessanten* Logs aber **nach** dem letzten Script — beim Container-Boot. Die landen aktuell nirgends im Bundle.

Ziel: Nach Task-Ende einmalig Docker-Logs pro Container `--since=<taskStart> --timestamps` einsammeln, als zeitstempel-getragene Trace-Events in den DebugCollector pushen. Die bestehende `bucketEvents`-Logik schiebt sie automatisch in die passende Per-Script- bzw. Postamble-Sektion.

Nutzer-Vorgabe: nur **einmal am Ende aller Tasks** sammeln. Zuordnung ausschließlich über Timestamp. Keine zusätzliche Wartezeit.

## Wieso Option B (per-Container `docker logs`)

Drei untersuchte Wege:

| Variante | Aufruf | Output-Format | Wahl |
|---|---|---|---|
| A | `docker compose logs --timestamps --no-log-prefix <svc>` pro Service | `<ts> <msg>` mit Service aus Call-Kontext | OK, aber CLI-Output abhängig vom Compose-Plugin |
| **B** | `docker logs --timestamps --since=<iso> <container>` pro Container | `<ISO-ts> <msg>` strikt standardisiert | **gewählt** |
| C | `/var/lib/docker/containers/<id>/<id>-json.log` direkt cat'en | JSON-per-line `{log, stream, time}` | fragil bei abweichenden Log-Drivern |

Option B kombiniert das standardisierte `docker logs`-Format (split-on-first-space) mit Server-side-Filtering via `--since`. Service-Mapping kommt aus dem strukturierten `docker compose ps --format json`-Output, nicht aus den Log-Zeilen.

## Architektur

```
VeExecution.run() loop
    ↓ (last script done)
collectDockerLogsIfApplicable()        ← NEW
    │
    ├── application.extends === "docker-compose"?
    │       └── NO  → return (no-op)
    │
    └── YES → VeLogsService.listContainersAndLogs(vmId, sinceTs)
                  │
                  ├── lxc-attach <vmid> -- docker compose ps --format json
                  │     → [{Service, ID, Name}, ...]
                  │
                  ├── pro Container:
                  │     lxc-attach <vmid> -- docker logs --timestamps
                  │         --since=<iso> --tail 500 <id>
                  │     → split lines, parse ISO timestamp + message
                  │
                  └── return DockerLogLine[]
                        │
                        ▼
                  collector.attachDockerLogs(restartKey, lines)
                        │
                        ▼
                  bucketEvents (existing) verteilt nach ts
                        │
                        ▼
emit "finished" → setupExecution closes collector → bundle ready
```

## File-Touches

| Datei | Änderung |
|---|---|
| [backend/src/ve-execution/ve-logs-service.mts](../backend/src/ve-execution/ve-logs-service.mts) | Neue Methode `getStructuredDockerLogs(vmId, sinceTs)` — gibt `Array<{ service, container, ts, line, stream }>` zurück. Reuse `executeOnHost` und `lxc-attach` Infrastruktur. |
| [backend/src/webapp/webapp-debug-collector.mts](../backend/src/webapp/webapp-debug-collector.mts) | (1) Neuer `TraceEvent`-Typ-Variant `source: "docker"` mit `container`, `service`, `stream`. (2) `attachDockerLogs(restartKey, lines)` API. (3) `renderTraceText` rendert `[docker:<svc>]`-Prefix. |
| [backend/src/ve-execution/ve-execution.mts](../backend/src/ve-execution/ve-execution.mts) | In `run()` nach erfolgreichem Command-Loop, vor `emit("finished")`: `collectDockerLogsForBundle(taskStartTs)` aufrufen. Hook bekommt Zugriff auf die VeContext und vm_id. |
| [backend/src/webapp/webapp-ve-execution-setup.mts](../backend/src/webapp/webapp-ve-execution-setup.mts) | DebugCollector-Reference und `applicationExtends`-Info an VeExecution durchreichen, damit der Logs-Hook weiß ob er aktiv werden soll. |
| (optional) [backend/src/persistence/application-persistence-handler.mts](../backend/src/persistence/application-persistence-handler.mts) | Helper `getExtendsForApplication(appId)` falls noch nicht vorhanden. |

## Implementation Steps

### 1. `VeLogsService.getStructuredDockerLogs`

```ts
interface DockerLogLine {
  service: string;
  container: string;
  ts: number;       // ms since epoch
  line: string;     // message without timestamp
  stream?: "stdout" | "stderr";  // optional, requires --details
}

async getStructuredDockerLogs(
  vmId: number,
  sinceTs: number,
  tailPerContainer = 500,
): Promise<DockerLogLine[]>
```

**SSH-Script** (composed in TypeScript, executed via `lxc-attach`):

```sh
# Phase 1: discover containers + services via docker compose ps --format json
COMPOSE_DIR=$(find /opt/docker-compose -maxdepth 1 -type d ! -name docker-compose | head -1)
[ -z "$COMPOSE_DIR" ] && exit 0
cd "$COMPOSE_DIR"
docker compose ps --format json
```

Output ist eine JSON-Zeile pro Container:
```json
{"Name":"app-zitadel-1","Service":"zitadel","ID":"abc...","State":"running",...}
```
(Newline-Delimited JSON, kein Array — wichtig beim Parsen.)

**Phase 2: per Container `docker logs`**:
```sh
docker logs --timestamps --since="${ISO_TIMESTAMP}" --tail 500 "${CONTAINER_ID}"
```

Output je Zeile:
```
2026-05-13T08:50:01.123456789Z this is the message
```

**Parser** (TypeScript-seitig):
```ts
function parseDockerLogLine(
  raw: string,
  service: string,
  container: string,
): DockerLogLine | null {
  const spaceIdx = raw.indexOf(" ");
  if (spaceIdx < 1) return null;
  const tsRaw = raw.slice(0, spaceIdx);
  const ts = Date.parse(tsRaw);
  if (Number.isNaN(ts)) return null;
  return { service, container, ts, line: raw.slice(spaceIdx + 1) };
}
```

ISO mit Nanosekunden ist `Date.parse`-kompatibel (Nanos werden ignoriert, das ist OK — wir brauchen nur Millisekunden-Genauigkeit).

### 2. DebugCollector erweitern

`TraceEvent` um Variante erweitern:
```ts
| {
    ts: number;
    source: "docker";
    service: string;
    container: string;
    line: string;
    stream?: "stdout" | "stderr";
  }
```

Neue API:
```ts
attachDockerLogs(restartKey: string, lines: DockerLogLine[]): void {
  const e = this.entries.get(restartKey);
  if (!e) return;
  for (const l of lines) {
    e.events.push({ ts: l.ts, source: "docker", ...l });
  }
}
```

Renderer (`renderTraceText`):
```ts
if (e.source === "docker") {
  return `${t} [docker:${e.service.padEnd(15)}] ${e.line}`;
}
```

### 3. Hook in VeExecution

In `VeExecution.run()` direkt vor dem `emit("finished")`-Block:

```ts
// Collect docker logs for the debug bundle if this app extends docker-compose.
// Runs once, after the last script — chronological assignment via timestamp
// happens automatically in DebugCollector.bucketEvents.
if (this.shouldCollectDockerLogs()) {
  try {
    const vmId = Number(this.outputs.get("vm_id"));
    if (Number.isFinite(vmId)) {
      const logsService = new VeLogsService(this.veContext!, this.executionMode);
      const lines = await logsService.getStructuredDockerLogs(
        vmId,
        this.taskStartTs,
        500,
      );
      this.emit("docker-logs", lines);  // setupExecution forwards to collector
    }
  } catch { /* never fail the task on debug-collection error */ }
}
```

Listener-Seite in `setupExecution`:
```ts
exec.on("docker-logs", (lines: DockerLogLine[]) => {
  if (debugCollector && debugLevel !== "off") {
    debugCollector.attachDockerLogs(restartKey, lines);
  }
});
```

Detection-Helper:
```ts
private shouldCollectDockerLogs(): boolean {
  if (readDebugLevel(this.inputs, this.defaults) === "off") return false;
  // application.extends === "docker-compose"
  const ext = this.defaults.get("application_extends") ?? this.inputs["application_extends"];
  return ext === "docker-compose";
}
```

`application_extends` als Default-Wert wird beim Task-Start in `webapp-ve-route-handlers.mts` gesetzt (analog zu `task`, `task_type`). Heutiger Code befindet sich dort um Zeile 583. Alternative: direkt aus dem geladenen Application-Config in `setupExecution` extrahieren und als Konstruktor-Param durchreichen.

### 4. `taskStartTs` tracken

`VeExecution` braucht den Zeitpunkt des Task-Starts (= vor dem ersten Script). Heutiger Code hat das nicht explizit. Hinzufügen:
```ts
private taskStartTs = Date.now();  // set in constructor
```

## Edge Cases

- **Compose-Plugin fehlt**: `docker compose ps` schlägt fehl → leeres Result → kein Push → kein Effekt aufs Bundle. ✓
- **Keine Container laufen**: `docker compose ps --format json` gibt leere Zeile zurück → leeres Result. ✓
- **JSON-Parse-Error pro Zeile**: Try/Catch um jeden `JSON.parse`-Call, fehlerhafte Zeilen einfach skippen. ✓
- **Container neu gestartet während Task**: Logs ab `--since=<taskStart>` enthalten beide Lifetimes — gewollt. ✓
- **Massiver Log-Output**: `--tail 500` pro Container cappt. SSH-Timeout 10s schützt vor Hängen.
- **Restart-Flow**: Wenn `VeExecution.run(restartInfo)` läuft (Resume aus früherem Lauf), ist `taskStartTs` der Resume-Zeitpunkt → Logs ab Resume sammeln. Bewusste Wahl: alte Logs des vorherigen Versuchs sind irrelevant.

## Bekannte Limits

- Logs nach Bundle-Erzeugung sind verloren (kein Nachladen). User muss `--since` manuell auf der Konsole nachvollziehen wenn er mehr braucht.
- Multi-LXC-Applikationen werden nicht unterstützt (single `vm_id`).
- Log-Driver muss `docker logs` unterstützen (default `json-file` und `local` tun das; `none` würde leer liefern → harmlos).
- Container-Uhr-Drift gegenüber Host kann Events um 1-2s in den falschen Bucket schieben — in LXC-Containern in Proxvex aber praktisch immer ≤ Hundertstel Sekunden.

## Verification

End-to-End-Test gegen einen docker-compose-Test, der laut Output sichtbare Container-Logs produziert:

```sh
DEPLOYER_PORT=3201 npx tsx backend/tests/livetests/src/live-test-runner.mts \
    green zitadel/default --debug script
```

Erwartung:
1. `livetest-results/<runId>/zitadel-default/scripts/<N>-wait-for-services.md` enthält in `## Trace (chronological)` Zeilen mit Prefix `[docker:postgres ]` und `[docker:zitadel  ]`.
2. `index.md`'s "Postamble Trace" enthält die Container-Boot-Logs, die nach dem letzten Script reinkamen.
3. `variables.md` und JSON-Sidecars unverändert.

Smoke-Test mit Nicht-Compose-App:
```sh
DEPLOYER_PORT=3201 npx tsx backend/tests/livetests/src/live-test-runner.mts \
    green eclipse-mosquitto --debug script
```

Erwartung: Bundle ist identisch zur Vor-Implementierung — keine `[docker:…]`-Zeilen, kein Performance-Hit.

## Design-Erweiterung: Trace als HTML statt Codeblock

**Kontext**: Heute rendert `renderTraceText` einen `\`\`\`text`-Codeblock mit fixed-width-Prefix-Spalten (`[stderr]`, `[debug ]`, `[docker:<svc>]`). Funktioniert, aber:

- Schwer pro Event-Typ ein-/ausblendbar
- Maschinenlesbarkeit ist Regex-basiert (JSON-Sidecar gleicht das aus, ist aber Format-Duplikation)
- Lange Traces sind unfilterbar

**Vorschlag**: Trace als HTML-Block mit CSS-Klassen rendern. Markdown lässt inline-HTML überall durch (VS Code, GitHub, markserv).

Struktur:
```html
<div class="trace">
  <div class="trace-row source-logger level-debug" data-ts="1778653817003">
    <span class="ts">12:00:02.100</span>
    <span class="tag">[debug]</span>
    <span class="component">ve-execution</span>
    <span class="msg">Executing command on lxc vm_id=125</span>
  </div>
  <div class="trace-row source-docker" data-ts="1778653820001" data-service="zitadel">
    <span class="ts">12:00:05.001</span>
    <span class="tag">[docker:zitadel]</span>
    <span class="msg">starting server on :8080</span>
  </div>
</div>
```

Mit Toggles via Checkbox + CSS-Sibling-Selektor (kein JS nötig):

```html
<label><input type="checkbox" checked> Logger</label>
<label><input type="checkbox" checked> Stderr</label>
<label><input type="checkbox" checked> Docker</label>
<div class="trace">…</div>
<style>
.trace-row { font-family: monospace; white-space: pre; }
/* Beispiel: wenn die "Docker"-Checkbox abgewählt ist, alle docker-rows ausblenden.
   In modernem CSS via :has(); klassischer Fallback: parent <label> + :not(:checked) */
</style>
```

Implementierungsumfang (additiv, kein Breaking Change):
- Neuer Helper `renderTraceHtml(events)` parallel zu `renderTraceText`
- `renderScript` / `renderIndex` schalten auf HTML
- JSON-Sidecars unverändert (sie waren immer das primäre Maschinenformat)
- Codeblock-Variante kann als Fallback bleiben (Term-Reader, `glow`), oder retired werden — letzteres bevorzugt zur Reduktion von Format-Duplikation

Aufwand zusätzlich: ~30–45 min (HTML-Renderer, Style-Block, Beispiel-Checkboxen). Sollte in einem Rutsch mit der Docker-Logs-Integration mitlaufen, weil der neue `source: "docker"`-Typ ohnehin im Renderer behandelt werden muss.

## Offene Designfragen

- **Stderr/stdout-Trennung**: `docker logs --details` würde stream-Info liefern, aber komplizierter formatiert. Default: nur `--timestamps`, alles in einem Strom. Können wir später anflanschen wenn nötig.
- **Sammlung bei abgebrochener Task**: Bei Task-Fail (vor letztem Script) — sammeln wir trotzdem? Empfehlung: ja, Hook in `run()`'s `finally`-Block. Logs eines fehlgeschlagenen Containers sind oft genau das was der User sehen will.
- **Konfigurierbarkeit**: `debug_docker_wait_seconds`-Parameter wurde explizit verworfen. Falls später gewünscht, sauber via neuem Parameter in `debug_level=script`-Pfad nachrüstbar.

## Aufwand-Schätzung (final)

| Schritt | Min |
|---|---:|
| `VeLogsService.getStructuredDockerLogs` inkl. JSON-Parse | 25 |
| `TraceEvent`-Erweiterung + `attachDockerLogs` API | 20 |
| Renderer-Update (`[docker:<svc>]`) | 10 |
| Hook in `VeExecution.run()` + `taskStartTs` | 30 |
| `application_extends` durchreichen | 15 |
| Event-Forwarding in `setupExecution` | 10 |
| Build + Lint | 10 |
| Livetest gegen zitadel/default | 20 |
| **Summe (Docker-Logs only)** | **~140 min (2,3 h)** |
| HTML-Trace-Renderer (siehe Design-Erweiterung) | +30–45 |
| **Summe inkl. HTML-Trace** | **~180 min (3 h)** |

Range mit Debugging: **3–4,5 h** für beides zusammen.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemRepositories } from "../../src/persistence/repositories.mjs";
import type { IConfiguredPathes } from "../../src/backend-types.mjs";

// Der Skript-Cache wurde beim Start befuellt und nie invalidiert. Ein laufender
// Deployer fuehrte damit bis zum naechsten Neustart die Skripte aus, die beim
// Start auf der Platte lagen — beim Self-Upgrade genau die falschen: Das
// Upgrade legt neue Skripte ab, der Prozess klont sich mit den alten.
//
// Befund vom 24.09.2026 (pve1): Vier Kopien von clone-as-temp-deployer.sh
// trugen den VLAN-Fix, jeder Klon entstand trotzdem ohne `tag=`, und eine zur
// Probe eingebaute Logzeile schrieb nie etwas — weil keine der Dateien gelesen
// wurde. Der Prozess lief seit 08:47, die Fixes kamen um 16:17 und 19:55.
describe("Skript-Cache bemerkt Aenderungen auf der Platte", () => {
  let base: string;
  let repos: FileSystemRepositories;

  const REF = { name: "probe.sh", scope: "shared" as const, category: "root" };

  const write = (dir: string, content: string): void => {
    const target = path.join(dir, "shared", "scripts");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "probe.sh"), content);
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "proxvex-script-cache-"));
    const pathes: IConfiguredPathes = {
      schemaPath: path.join(base, "schema"),
      jsonPath: path.join(base, "json"),
      localPath: path.join(base, "local"),
    };
    // persistence wird fuer shared-Skripte nicht angefasst (nur loadTemplate).
    repos = new FileSystemRepositories(pathes, {} as never, true);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("liefert nach einer Aenderung den NEUEN Inhalt, nicht den vom ersten Lesen", () => {
    write(path.join(base, "json"), "#!/bin/sh\necho alt\n");
    expect(repos.getScript(REF)).toContain("echo alt");

    // Laenge bewusst verschieden: Auf Dateisystemen mit grober mtime-Aufloesung
    // faengt die Groessenpruefung den Fall ab.
    write(path.join(base, "json"), "#!/bin/sh\necho neu und laenger\n");
    expect(repos.getScript(REF), "Cache liefert den alten Stand").toContain(
      "echo neu und laenger",
    );
  });

  it("sieht ein Overlay, das erst nach dem ersten Lesen angelegt wurde", () => {
    // Genau der Fall von pve1: Der Fix wurde in den local-Layer gelegt, waehrend
    // der Prozess lief — und blieb unsichtbar.
    write(path.join(base, "json"), "#!/bin/sh\necho kanonisch\n");
    expect(repos.getScript(REF)).toContain("echo kanonisch");

    write(path.join(base, "local"), "#!/bin/sh\necho overlay gewinnt\n");
    expect(repos.getScript(REF), "local schlaegt json").toContain(
      "echo overlay gewinnt",
    );
  });

  it("liest unveraenderte Dateien weiterhin aus dem Cache", () => {
    write(path.join(base, "json"), "#!/bin/sh\necho stabil\n");
    const first = repos.getScript(REF);

    // Datei loeschen, aber Cache-Eintrag steht: Ohne Revalidierung kaeme der
    // alte Inhalt. MIT Revalidierung ist die Datei weg -> null. Das ist die
    // ehrliche Antwort und zeigt zugleich, dass wirklich die Platte befragt wird.
    fs.rmSync(path.join(base, "json", "shared", "scripts", "probe.sh"));
    expect(first).toContain("echo stabil");
    expect(repos.getScript(REF)).toBeNull();
  });
});

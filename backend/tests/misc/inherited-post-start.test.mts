import { ApplicationLoader } from "@src/apploader.mjs";
import { FileSystemPersistence } from "@src/persistence/filesystem-persistence.mjs";
import { ITemplateReference, IReadApplicationOptions } from "@src/backend-types.mjs";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "../helper/test-persistence-helper.mjs";

function names(t: (ITemplateReference | string)[] | undefined): string[] {
  return (t ?? []).map((x) => (typeof x === "string" ? x : x.name));
}

// Eine App, deren einzige eigene Arbeit in installation.post_start steht, muss
// diesen Schritt behalten, wenn sie von einem Framework erbt, das selbst
// post_start UND check beisteuert.
//
// Befund vom 24.09.2026: heimvio-runner (extends docker-compose) deklariert
// post_start: ["heimvio-runner-up.json"] — der Schritt, der den Gitea-
// act_runner startet. Im Lauf tauchte er NIE auf: 31 Schritte, davon 8 Checks,
// kein heimvio-runner-up, null Treffer in den Diagnosedaten. Template und
// application.json lagen zu dem Zeitpunkt nachweislich im Deployer und waren
// gelesen worden (atime), die Definition war korrekt. Der Schritt verschwand
// lautlos — ohne Fehler, ohne Warnung.
describe("geerbtes post_start bleibt erhalten", () => {
  let env: TestEnvironment;
  let helper: TestPersistenceHelper;
  let loader: ApplicationLoader;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, { jsonIncludePatterns: [] });
    const init = env.initPersistence({ enableCache: false });
    helper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    const pathes = { schemaPath: env.schemaDir, jsonPath: env.jsonDir, localPath: env.localDir };
    loader = new ApplicationLoader(
      pathes,
      new FileSystemPersistence(pathes, init.pm.getJsonValidator()),
    );
  });

  const read = (app: string): string[] => {
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { name: "", message: "", details: [] },
      taskTemplates: [],
    };
    loader.readApplicationJson(app, opts);
    return names(opts.taskTemplates.find((t) => t.task === "installation")?.templates);
  };

  it("behaelt den eigenen post_start-Schritt neben den Checks des Frameworks", () => {
    // Framework wie docker-compose: eigene post_start-Schritte UND Checks.
    helper.writeJsonSync(Volume.JsonApplications, "framework/application.json", {
      name: "framework",
      installation: {
        pre_start: ["100-pre.json"],
        post_start: ["330-svc-start.json", "350-check-hook-log.json"],
        check: ["945-check-https-cert.json"],
      },
    });
    // Die App bringt nur ihren einen Schritt mit — so wie heimvio-runner.
    helper.writeJsonSync(Volume.LocalRoot, "applications/runner/application.json", {
      name: "runner",
      extends: "framework",
      installation: { post_start: ["runner-up.json"] },
    });

    const list = read("runner");
    expect(list, "der eigene Schritt der App fehlt").toContain("runner-up.json");
    expect(list).toContain("330-svc-start.json");
  });

  it("ordnet den eigenen Schritt vor die check-Kategorie ein", () => {
    // Checks pruefen einen Zustand, den erst post_start herstellt. Liegt der
    // App-Schritt dahinter, entscheidet jeder rote Check darueber, ob die App
    // ihre Arbeit ueberhaupt tut.
    helper.writeJsonSync(Volume.JsonApplications, "framework/application.json", {
      name: "framework",
      installation: {
        post_start: ["330-svc-start.json"],
        check: ["945-check-https-cert.json"],
      },
    });
    helper.writeJsonSync(Volume.LocalRoot, "applications/runner/application.json", {
      name: "runner",
      extends: "framework",
      installation: { post_start: ["runner-up.json"] },
    });

    const list = read("runner");
    const own = list.indexOf("runner-up.json");
    const check = list.indexOf("945-check-https-cert.json");
    expect(own, "eigener Schritt nicht eingeplant").toBeGreaterThanOrEqual(0);
    expect(check, "Check nicht eingeplant").toBeGreaterThanOrEqual(0);
    expect(own, "post_start muss vor check liegen").toBeLessThan(check);
  });
});

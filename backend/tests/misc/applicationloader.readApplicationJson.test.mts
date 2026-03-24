import { ApplicationLoader } from "@src/apploader.mjs";
import { FileSystemPersistence } from "@src/persistence/filesystem-persistence.mjs";
import { ITemplateReference } from "@src/backend-types.mjs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "../helper/test-persistence-helper.mjs";

// Helper to extract template names from templates array (which may contain strings or ITemplateReference objects)
function getTemplateNames(
  templates: (ITemplateReference | string)[] | undefined,
): string[] {
  if (!templates) return [];
  return templates.map((t) => (typeof t === "string" ? t : t.name));
}

// Helper to get template name at index
function getTemplateName(
  templates: (ITemplateReference | string)[] | undefined,
  index: number,
): string | undefined {
  if (!templates || index >= templates.length) return undefined;
  const t = templates[index];
  return typeof t === "string" ? t : t.name;
}

describe("ApplicationLoader.readApplicationJson", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let localPath: string;
  let jsonPath: string;
  let schemaPath: string;
  let loader: ApplicationLoader;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    const init = env.initPersistence({ enableCache: false });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    localPath = env.localDir;
    jsonPath = env.jsonDir;
    schemaPath = env.schemaDir;
    const pm = init.pm;
    const persistence = new FileSystemPersistence(
      { schemaPath, jsonPath, localPath },
      pm.getJsonValidator(),
    );
    loader = new ApplicationLoader(
      { schemaPath, jsonPath, localPath },
      persistence,
    );
  });
  afterEach(() => {
    env.cleanup();
  });

  it("1. Application in localPath, extends application in jsonPath, different names", () => {
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "baseapp/application.json",
      {
        name: "baseapp",
        installation: { post_start: ["base-template.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      "applications/myapp/application.json",
      {
        name: "myapp",
        extends: "baseapp",
        installation: { post_start: ["my-template.json"] },
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { name: "", message: "", details: [] },
      taskTemplates: [],
    };
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    const templateNames = getTemplateNames(templates);
    expect(templateNames).toContain("base-template.json");
    expect(templateNames).toContain("my-template.json");
  });

  it("2. Like 1. Same names", () => {
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "myapp/application.json",
      {
        name: "myapp",
        installation: { post_start: ["base-template.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      "applications/myapp/application.json",
      {
        name: "myapp",
        extends: "json:myapp",
        installation: { post_start: ["my-template.json"] },
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { name: "", message: "", details: [] },
      taskTemplates: [],
    };
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    const templateNames = getTemplateNames(templates);
    expect(templateNames).toContain("base-template.json");
    expect(templateNames).toContain("my-template.json");
  });

  it("3. localPath application has a template with {position: start} in same category", () => {
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "baseapp/application.json",
      {
        name: "baseapp",
        installation: { post_start: ["base-template.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      "applications/myapp/application.json",
      {
        name: "myapp",
        extends: "baseapp",
        installation: {
          post_start: [
            { name: "my-template.json", position: "start" },
          ],
        },
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    expect(templates).toBeDefined();
    // Child template inserted at start of category, before parent template
    expect(getTemplateName(templates, 0)).toBe("my-template.json");
    expect(getTemplateName(templates, 1)).toBe("base-template.json");
  });

  it("4. extends application has 2 templates, localPath application appends at end of category", () => {
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "baseapp/application.json",
      {
        name: "baseapp",
        installation: { post_start: ["base1.json", "base2.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      "applications/myapp/application.json",
      {
        name: "myapp",
        extends: "baseapp",
        installation: { post_start: ["my-template.json"] },
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    expect(templates).toBeDefined();
    // Parent templates first, then child template appended at end of category
    expect(getTemplateName(templates, 0)).toBe("base1.json");
    expect(getTemplateName(templates, 1)).toBe("base2.json");
    expect(getTemplateName(templates, 2)).toBe("my-template.json");
  });
  it("5. recursion application extends itself", () => {
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "myapp/application.json",
      {
        name: "myapp",
        installation: { post_start: ["base-template.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      "applications/myapp/application.json",
      {
        name: "myapp",
        extends: "myapp",
        installation: { post_start: ["my-template.json"] },
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    expect(() => loader.readApplicationJson("myapp", opts)).toThrow();
  });
});

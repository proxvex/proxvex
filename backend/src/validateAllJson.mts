import path from "node:path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { TaskType, IJsonError } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { TemplateProcessor } from "./templates/templateprocessor.mjs";
import { ExecutionMode } from "./ve-execution/ve-execution-constants.mjs";

/**
 * Error thrown when validation fails.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Validates all JSON files (templates, applications, frameworks, addons)
 * Uses PersistenceManager for consistent path handling and validation.
 * @throws {ValidationError} if validation fails
 */
export async function validateAllJson(localPathArg?: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "..");
  const rootDir = path.resolve(projectRoot, "..");

  // Resolve paths
  const defaultLocalPath = path.join(rootDir, "examples");
  let localPath: string;
  if (localPathArg) {
    localPath = path.isAbsolute(localPathArg)
      ? localPathArg
      : path.join(process.cwd(), localPathArg);
  } else {
    localPath = process.env.LXC_MANAGER_LOCAL_PATH || defaultLocalPath;
  }

  // Ensure localPath exists for PersistenceManager
  if (!fs.existsSync(localPath)) {
    fs.mkdirSync(localPath, { recursive: true });
  }

  const storageContextPath = path.join(localPath, "storagecontext.json");
  const secretFilePath = path.join(localPath, "secret.txt");

  // Create minimal files if they don't exist
  if (!fs.existsSync(storageContextPath)) {
    fs.writeFileSync(
      storageContextPath,
      JSON.stringify({ veContexts: [] }, null, 2),
    );
  }
  if (!fs.existsSync(secretFilePath)) {
    fs.writeFileSync(secretFilePath, "dummy-secret-for-validation");
  }

  // Initialize PersistenceManager (validates directory structure)
  try {
    PersistenceManager.getInstance().close();
  } catch {
    // Ignore if not initialized
  }

  let pm: PersistenceManager;
  try {
    pm = PersistenceManager.initialize(
      localPath,
      storageContextPath,
      secretFilePath,
    );
  } catch (err: any) {
    console.error("Failed to initialize PersistenceManager:");
    console.error(`  ${err.message || err}`);
    // Print nested error details if available (JsonError has details array)
    if (err.details && Array.isArray(err.details)) {
      for (const detail of err.details) {
        const line = detail.line ? ` (line ${detail.line})` : "";
        console.error(`    - ${detail.message}${line}`);
        if (detail.details?.length) {
          for (const sub of detail.details) {
            const subLine = sub.line ? ` (line ${sub.line})` : "";
            console.error(`      - ${sub.message}${subLine}`);
          }
        }
      }
    }
    // Print stack trace if available for debugging
    if (err.stack) {
      console.error("  Stack:", err.stack.split("\n").slice(1, 4).join("\n"));
    }
    throw new ValidationError(
      `Failed to initialize PersistenceManager: ${err.message || err}`,
    );
  }

  const pathes = pm.getPathes();
  const validator = pm.getJsonValidator();
  let hasError = false;

  // Helper to print errors
  const printErrors = (errors: IJsonError[], indent = "    ") => {
    for (const err of errors) {
      const line = err.line ? ` (line ${err.line})` : "";
      console.error(`${indent}- ${err.message}${line}`);
      if (err.details?.length) {
        printErrors(err.details, indent + "  ");
      }
    }
  };

  // === 1. Validate Templates ===
  interface TemplateGroup {
    label: string;
    count: number;
    errors: { file: string; err: any }[];
  }
  const templateGroups: TemplateGroup[] = [];

  const templateDirs = findTemplateDirs(pathes.jsonPath).concat(
    findTemplateDirs(pathes.localPath),
  );

  for (const dir of templateDirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const errors: { file: string; err: any }[] = [];

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        validator.serializeJsonFileWithSchema(filePath, "template.schema.json");
      } catch (err: any) {
        hasError = true;
        errors.push({ file, err });
      }
    }

    // Determine label
    const isJson = dir.startsWith(pathes.jsonPath);
    const relToBase = path.relative(
      isJson ? pathes.jsonPath : pathes.localPath,
      dir,
    );
    const parts = relToBase.split(path.sep);
    const prefix = isJson ? "json" : "local";

    let label: string;
    if (parts[0] === "shared") {
      label = `${prefix}/shared`;
    } else if (parts[0] === "applications" && parts.length >= 2 && parts[1]) {
      const appName = parts.slice(1, -1).join("/");
      label = `${prefix}/applications/${appName}`;
    } else {
      label = `${prefix}/${relToBase}`;
    }

    templateGroups.push({ label, count: files.length, errors });
  }

  // Print Templates
  const templateErrors = templateGroups.filter((g) => g.errors.length > 0);
  const templateTotal = templateGroups.reduce((sum, g) => sum + g.count, 0);

  if (templateErrors.length === 0) {
    console.log(`✔ Templates (${templateTotal})`);
  } else {
    console.error(
      `✖ Templates (${templateTotal - templateErrors.flatMap((g) => g.errors).length}/${templateTotal})`,
    );
    for (const group of templateErrors) {
      for (const { file, err } of group.errors) {
        console.error(`  ✖ ${group.label}/${file}`);
        if (err.details) printErrors(err.details);
        else console.error(`    - ${err.message || err}`);
      }
    }
  }

  // === 2. Validate Frameworks ===
  const frameworkSources = [
    { dir: path.join(pathes.jsonPath, "frameworks"), label: "json" },
    { dir: path.join(pathes.localPath, "frameworks"), label: "local" },
  ];

  let frameworkTotal = 0;
  const frameworkErrors: { file: string; err: any }[] = [];

  for (const { dir } of frameworkSources) {
    if (!fs.existsSync(dir)) continue;
    const files = findJsonFiles(dir);
    frameworkTotal += files.length;

    for (const filePath of files) {
      const relFile = path.relative(dir, filePath);
      try {
        validator.serializeJsonFileWithSchema(
          filePath,
          "framework.schema.json",
        );
      } catch (err: any) {
        hasError = true;
        frameworkErrors.push({ file: relFile, err });
      }
    }
  }

  if (frameworkTotal > 0) {
    if (frameworkErrors.length === 0) {
      console.log(`✔ Frameworks (${frameworkTotal})`);
    } else {
      console.error(
        `✖ Frameworks (${frameworkTotal - frameworkErrors.length}/${frameworkTotal})`,
      );
      for (const { file, err } of frameworkErrors) {
        console.error(`  ✖ ${file}`);
        if (err.details) printErrors(err.details);
        else console.error(`    - ${err.message || err}`);
      }
    }
  }

  // === 3. Validate Addons ===
  const addonSources = [
    { dir: path.join(pathes.jsonPath, "addons"), label: "json" },
    { dir: path.join(pathes.localPath, "addons"), label: "local" },
  ];

  let addonTotal = 0;
  const addonErrors: { file: string; err: any }[] = [];

  for (const { dir } of addonSources) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    addonTotal += files.length;

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        validator.serializeJsonFileWithSchema(filePath, "addon.schema.json");
      } catch (err: any) {
        hasError = true;
        addonErrors.push({ file, err });
      }
    }
  }

  if (addonTotal > 0) {
    if (addonErrors.length === 0) {
      console.log(`✔ Addons (${addonTotal})`);
    } else {
      console.error(
        `✖ Addons (${addonTotal - addonErrors.length}/${addonTotal})`,
      );
      for (const { file, err } of addonErrors) {
        console.error(`  ✖ ${file}`);
        if (err.details) printErrors(err.details);
        else console.error(`    - ${err.message || err}`);
      }
    }
  }

  // === 4. Validate Applications (schema + tasks) ===
  const apps = pm.getApplicationService().listApplicationsForFrontend();

  // check is excluded from standalone validation because its templates rely on
  // parameters (vm_id, hostname) produced by other tasks. Check templates are
  // auto-appended to installation/upgrade/reconfigure and validated there.
  const VALID_TASK_TYPES: TaskType[] = [
    "installation",
    "backup",
    "restore",
    "uninstall",
    "update",
    "upgrade",
    "webui",
  ];

  const contextManager = pm.getContextManager();
  const dummyVeContext: IVEContext = {
    host: "validation-dummy",
    current: false,
    getStorageContext: () => contextManager,
    getKey: () => "ve_validation-dummy",
  };

  const appErrors: {
    id: string;
    schemaErrors?: IJsonError[];
    taskErrors?: { task: string; err: any }[];
  }[] = [];

  for (const app of apps) {
    // Check for schema errors first
    if (app.errors?.length) {
      hasError = true;
      appErrors.push({ id: app.id, schemaErrors: app.errors });
      continue;
    }

    // Validate tasks - only validate tasks that are defined in the application
    const taskErrors: { task: string; err: any }[] = [];
    for (const task of VALID_TASK_TYPES) {
      try {
        const templateProcessor = new TemplateProcessor(
          pathes,
          contextManager,
          pm.getPersistence(),
        );
        await templateProcessor.loadApplication(
          app.id,
          task,
          dummyVeContext,
          ExecutionMode.TEST,
        );
      } catch (err: any) {
        // Only count as error if it's not a "task not found" error
        // Tasks like backup, restore, etc. are optional
        const isTaskNotFoundError =
          err.message?.includes("not found in") &&
          err.message?.includes("application");
        if (!isTaskNotFoundError) {
          hasError = true;
          taskErrors.push({ task, err });
        }
      }
    }

    if (taskErrors.length > 0) {
      appErrors.push({ id: app.id, taskErrors });
    }
  }

  // Get extends info for better error messages
  const getExtendsInfo = (appId: string): string => {
    const app = apps.find((a) => a.id === appId);
    if (app?.extends) {
      const failedBase = appErrors.find((e) => e.id === app.extends);
      if (failedBase) {
        return ` (extends: ${app.extends} ✖)`;
      }
      return ` (extends: ${app.extends})`;
    }
    return "";
  };

  if (appErrors.length === 0) {
    console.log(`✔ Applications (${apps.length})`);
  } else {
    console.error(
      `✖ Applications (${apps.length - appErrors.length}/${apps.length})`,
    );
    for (const appErr of appErrors) {
      const extendsInfo = getExtendsInfo(appErr.id);
      if (appErr.schemaErrors) {
        console.error(`  ✖ ${appErr.id}${extendsInfo}`);
        printErrors(appErr.schemaErrors);
      } else if (appErr.taskErrors) {
        const passed = VALID_TASK_TYPES.length - appErr.taskErrors.length;
        console.error(
          `  ✖ ${appErr.id}${extendsInfo} (${passed}/${VALID_TASK_TYPES.length} tasks)`,
        );
        for (const { task, err } of appErr.taskErrors) {
          console.error(`    ✖ ${task}`);
          if (err.details?.length) {
            printErrors(err.details, "      ");
          } else {
            console.error(`      - ${err.message || err}`);
          }
        }
      }
    }
  }

  // === Check for duplicates across categories ===
  const repositories = pm.getRepositories();
  if (repositories.checkForDuplicates) {
    const duplicateWarnings = repositories.checkForDuplicates();
    if (duplicateWarnings.length > 0) {
      hasError = true;
      console.error("Duplicate files across categories:");
      for (const warning of duplicateWarnings) {
        console.error(`  ✖ ${warning}`);
      }
    }
  }

  // === Summary ===
  console.log("");
  if (hasError) {
    console.error("✖ Validation failed.");
    throw new ValidationError("Validation failed");
  } else {
    console.log("✔ All validations passed.");
  }
}

// Helper: Find all template directories
function findTemplateDirs(baseDir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(baseDir)) return results;

  const scan = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "templates") {
            results.push(fullPath);
          } else {
            scan(fullPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  };

  scan(baseDir);
  return results;
}

// Helper: Find all JSON files recursively
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const scan = (d: string) => {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  };

  scan(dir);
  return results;
}

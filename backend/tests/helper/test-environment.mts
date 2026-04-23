import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import type { ContextManager } from "@src/context-manager.mjs";

export interface TestEnvironment {
  /** Root temp dir for this environment */
  rootDir: string;
  /** Used as PersistenceManager localPath */
  localDir: string;
  /** Used as PersistenceManager jsonPath */
  jsonDir: string;
  /** Used as PersistenceManager schemaPath */
  schemaDir: string;
  storageContextFilePath: string;
  secretFilePath: string;
  /** Repo root (derived from test file location) */
  repoRoot: string;
  repoJsonDir: string;
  repoSchemasDir: string;

  /** Initialize PersistenceManager singleton for this env */
  initPersistence: (opts?: {
    enableCache?: boolean;
    resetSingleton?: boolean;
  }) => { pm: PersistenceManager; ctx: ContextManager };

  /** Close PersistenceManager singleton (best-effort) */
  closePersistence: () => void;
  /** Cleanup helper */
  cleanup: () => void;
}

export interface CreateTestEnvironmentOptions {
  /**
   * Regex patterns (as strings) matched against the repo-relative path under `json/`.
   * If empty/undefined, nothing is copied from `json/`.
   * Example: [".*proxvex.*"]
   */
  jsonIncludePatterns?: string[];

  /**
   * Regex patterns (as strings) matched against paths under `backend/tests/fixtures/`.
   * Files are copied into the json directory as if they were in `json/`.
   * Example: ["^applications/test-enum/.*"]
   */
  fixturesIncludePatterns?: string[];

  /**
   * Regex patterns (as strings) matched against schema filenames under `schemas/`.
   * If empty/undefined, nothing is copied from `schemas/`.
   */
  schemaIncludePatterns?: string[];

  /**
   * Where schemas should come from.
   * - "repo": use the repo `schemas/` directly (default; no copying, fastest)
   * - "temp": copy matched schemas into the temp env `schemaDir`
   */
  schemaSource?: "repo" | "temp";

  /** @deprecated Prefer jsonIncludePatterns */
  copyJson?: boolean;
  /** @deprecated Prefer schemaIncludePatterns */
  copySchemas?: boolean;
  /** @deprecated Prefer schemaIncludePatterns */
  schemaFiles?: string[];
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function repoRootFromTestFile(testFileUrl: string): string {
  const testFilePath = fileURLToPath(testFileUrl);

  // Walk up from the test file directory until we find the repo root.
  // Repo root is identified by containing both `json/` and `schemas/`.
  let dir = path.dirname(testFilePath);
  for (let i = 0; i < 12; i++) {
    const jsonDir = path.join(dir, "json");
    const schemasDir = path.join(dir, "schemas");
    if (fs.existsSync(jsonDir) && fs.existsSync(schemasDir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Unable to locate repo root from test file: ${testFilePath}. Expected ancestor containing json/ and schemas/.`,
  );
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function compileRegexes(
  patterns: string[] | undefined,
  label: string,
): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => {
    try {
      return new RegExp(p);
    } catch (e: any) {
      throw new Error(`Invalid ${label} regex: ${p}. ${e?.message || e}`);
    }
  });
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function copyMatchingFiles(params: {
  sourceRoot: string;
  destRoot: string;
  patterns: RegExp[];
}): void {
  const { sourceRoot, destRoot, patterns } = params;
  if (patterns.length === 0) return;
  if (!fs.existsSync(sourceRoot)) return;

  const files = listFilesRecursive(sourceRoot);
  for (const abs of files) {
    const rel = toPosixPath(path.relative(sourceRoot, abs));
    if (!patterns.some((r) => r.test(rel))) continue;
    const dst = path.join(destRoot, rel);
    mkdirp(path.dirname(dst));
    fs.copyFileSync(abs, dst);
  }
}

export function createTestEnvironment(
  testFileUrl: string,
  opts: CreateTestEnvironmentOptions = {},
): TestEnvironment {
  const repoRoot = repoRootFromTestFile(testFileUrl);
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "proxvex-test-"),
  );

  const localDir = path.join(rootDir, "local");
  const jsonDir = path.join(rootDir, "json");
  const tempSchemaDir = path.join(rootDir, "schemas");

  mkdirp(localDir);
  mkdirp(jsonDir);
  mkdirp(tempSchemaDir);

  // Always create minimal files expected by Context/Persistence
  const storageContextFilePath = path.join(localDir, "storagecontext.json");
  const secretFilePath = path.join(localDir, "secret.txt");
  if (!fs.existsSync(storageContextFilePath))
    fs.writeFileSync(storageContextFilePath, "{}", "utf-8");
  if (!fs.existsSync(secretFilePath))
    fs.writeFileSync(secretFilePath, "", "utf-8");

  const repoJsonDir = path.join(repoRoot, "json");
  const repoSchemasDir = path.join(repoRoot, "schemas");

  // Backward compatibility: map old options to patterns
  const jsonIncludePatterns =
    opts.jsonIncludePatterns ?? (opts.copyJson ? [".*"] : []);
  const schemaIncludePatterns =
    opts.schemaIncludePatterns ??
    (opts.schemaFiles && opts.schemaFiles.length > 0
      ? opts.schemaFiles.map(
          (f) => `^${f.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}$`,
        )
      : opts.copySchemas
        ? [".*"]
        : []);

  // json/: recursive copy of matching files
  if (!fs.existsSync(repoJsonDir)) {
    throw new Error(`Repo json/ directory not found at ${repoJsonDir}`);
  }
  copyMatchingFiles({
    sourceRoot: repoJsonDir,
    destRoot: jsonDir,
    patterns: compileRegexes(jsonIncludePatterns, "jsonIncludePatterns"),
  });

  // fixtures/: copy test fixtures into json directory
  const fixturesDir = path.join(repoRoot, "backend", "tests", "fixtures");
  if (opts.fixturesIncludePatterns && opts.fixturesIncludePatterns.length > 0) {
    if (fs.existsSync(fixturesDir)) {
      copyMatchingFiles({
        sourceRoot: fixturesDir,
        destRoot: jsonDir,
        patterns: compileRegexes(
          opts.fixturesIncludePatterns,
          "fixturesIncludePatterns",
        ),
      });
    }
  }

  // schemas/: by default use repo directly (schemas are stable and shared)
  if (!fs.existsSync(repoSchemasDir)) {
    throw new Error(`Repo schemas/ directory not found at ${repoSchemasDir}`);
  }
  const schemaSource = opts.schemaSource ?? "repo";
  const schemaDir = schemaSource === "repo" ? repoSchemasDir : tempSchemaDir;

  if (schemaSource === "temp") {
    // Flat directory (no subdirs), match against filenames
    const schemaRegexes = compileRegexes(
      schemaIncludePatterns,
      "schemaIncludePatterns",
    );
    if (schemaRegexes.length > 0) {
      const entries = fs.readdirSync(repoSchemasDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const name = ent.name;
        if (!schemaRegexes.some((r) => r.test(name))) continue;
        const src = path.join(repoSchemasDir, name);
        const dst = path.join(schemaDir, name);
        fs.copyFileSync(src, dst);
      }
    }
  }

  const closePersistence = () => {
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // ignore
    }
  };

  const initPersistence = (initOpts?: {
    enableCache?: boolean;
    resetSingleton?: boolean;
  }): { pm: PersistenceManager; ctx: ContextManager } => {
    const enableCache = initOpts?.enableCache ?? true;
    const resetSingleton = initOpts?.resetSingleton ?? true;
    if (resetSingleton) {
      closePersistence();
    }
    const pm = PersistenceManager.initialize(
      localDir,
      storageContextFilePath,
      secretFilePath,
      enableCache,
      jsonDir,
      schemaDir,
    );
    const ctx = pm.getContextManager();
    return { pm, ctx };
  };

  const cleanup = () => {
    closePersistence();
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    rootDir,
    localDir,
    jsonDir,
    schemaDir,
    storageContextFilePath,
    secretFilePath,
    repoRoot,
    repoJsonDir,
    repoSchemasDir,
    initPersistence,
    closePersistence,
    cleanup,
  };
}

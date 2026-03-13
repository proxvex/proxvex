import express from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { VEWebApp } from "@src/webapp/webapp.mjs";
import type { ContextManager } from "@src/context-manager.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { WebAppVE } from "@src/webapp/webapp-ve.mjs";
import { VeTestHelper } from "../ve-test-helper.mjs";
import {
  createTestEnvironment,
  type CreateTestEnvironmentOptions,
  type TestEnvironment,
} from "./test-environment.mjs";
export interface WebAppTestSetup {
  env: TestEnvironment;
  ctx: ContextManager;
  app: express.Application;
  cleanup: () => void;
}

export interface WebAppVETestSetup {
  helper: VeTestHelper;
  ctx: ContextManager;
  app: express.Application;
  webAppVE: WebAppVE;
  cleanup: () => Promise<void>;
}

export interface WebAppStaticTestSetup {
  app: express.Application;
  cleanup: () => void;
}

export async function createWebAppTestSetup(
  testFileUrl: string,
  opts: CreateTestEnvironmentOptions = {},
): Promise<WebAppTestSetup> {
  const env = createTestEnvironment(testFileUrl, opts);
  const { ctx } = env.initPersistence();
  const webApp = await VEWebApp.create(ctx as any);
  const app = webApp.app;
  const cleanup = () => {
    try {
      env.cleanup();
    } catch {
      // ignore
    }
  };
  return { env, ctx, app, cleanup };
}

export async function createWebAppVETestSetup(): Promise<WebAppVETestSetup> {
  const helper = new VeTestHelper();
  await helper.setup();

  const storageContextPath = path.join(helper.localDir, "storagecontext.json");
  const secretFilePath = path.join(helper.localDir, "secret.txt");
  fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

  try {
    PersistenceManager.getInstance().close();
  } catch {
    // Ignore if not initialized
  }

  PersistenceManager.initialize(
    helper.localDir,
    storageContextPath,
    secretFilePath,
  );

  const pm = PersistenceManager.getInstance();
  (pm as any).pathes = {
    localPath: helper.localDir,
    jsonPath: helper.jsonDir,
    schemaPath: helper.schemaDir,
  };

  const persistence = (pm as any).persistence;
  if (persistence) {
    (persistence as any).pathes = {
      localPath: helper.localDir,
      jsonPath: helper.jsonDir,
      schemaPath: helper.schemaDir,
    };
    if ((persistence as any).applicationHandler) {
      ((persistence as any).applicationHandler as any).pathes = {
        localPath: helper.localDir,
        jsonPath: helper.jsonDir,
        schemaPath: helper.schemaDir,
      };
    }
    if ((persistence as any).templateHandler) {
      ((persistence as any).templateHandler as any).pathes = {
        localPath: helper.localDir,
        jsonPath: helper.jsonDir,
        schemaPath: helper.schemaDir,
      };
    }
    if ((persistence as any).frameworkHandler) {
      ((persistence as any).frameworkHandler as any).pathes = {
        localPath: helper.localDir,
        jsonPath: helper.jsonDir,
        schemaPath: helper.schemaDir,
      };
    }
  }

  const ctx = pm.getContextManager();
  (ctx as any).pathes = {
    localPath: helper.localDir,
    jsonPath: helper.jsonDir,
    schemaPath: helper.schemaDir,
  };

  const app = express();
  const webAppVE = new WebAppVE(app);
  webAppVE.init();

  const cleanup = async () => {
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // ignore
    }
    await helper.cleanup();
  };

  return { helper, ctx, app, webAppVE, cleanup };
}

export async function createWebAppStaticTestSetup(
  testFileUrl: string,
): Promise<WebAppStaticTestSetup> {
  const prevEnv = process.env.LXC_MANAGER_FRONTEND_DIR;
  const env = createTestEnvironment(testFileUrl);

  const frontendDir = path.join(env.rootDir, "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(
    path.join(frontendDir, "index.html"),
    "<html><body>OK</body></html>",
  );
  process.env.LXC_MANAGER_FRONTEND_DIR = frontendDir;

  const { ctx } = env.initPersistence({ enableCache: false });
  const webApp = await VEWebApp.create(ctx as any);
  const app = webApp.app;

  const cleanup = () => {
    if (prevEnv === undefined) delete process.env.LXC_MANAGER_FRONTEND_DIR;
    else process.env.LXC_MANAGER_FRONTEND_DIR = prevEnv;
    env.cleanup();
  };

  return { app, cleanup };
}

export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function ensureDirs(root: string, ...dirs: string[]): void {
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
}

export function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

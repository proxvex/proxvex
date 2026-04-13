import https from "node:https";
import fs from "node:fs";
import { IStack } from "../types.mjs";
import { IStackProvider } from "./stack-provider.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("remote-stack-provider");

/**
 * Remote stack provider: delegates stack operations to the Hub deployer via HTTPS/mTLS.
 * Uses the local server cert as client cert for mTLS authentication.
 */
export class RemoteStackProvider implements IStackProvider {
  private hubUrl: string;
  private agent: https.Agent;

  constructor(
    hubUrl: string,
    certPath: string,
    keyPath: string,
    caPath: string,
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.agent = new https.Agent({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      ca: fs.readFileSync(caPath),
      rejectUnauthorized: true,
    });
    logger.info("Remote stack provider initialized", { hubUrl: this.hubUrl });
  }

  private fetchJsonSync<T>(path: string, method: string = "GET", body?: any): T {
    // Use synchronous approach via spawnSync to keep interface sync
    const { spawnSync } = require("node:child_process");
    const url = `${this.hubUrl}${path}`;
    const args = ["-s", "--max-time", "10"];

    // mTLS cert/key/ca
    args.push("--cert", this.getCertPath(), "--key", this.getKeyPath(), "--cacert", this.getCaPath());

    if (method !== "GET") {
      args.push("-X", method);
    }
    if (body) {
      args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
    }
    args.push(url);

    const result = spawnSync("curl", args, { encoding: "utf-8", timeout: 15000 });
    if (result.error) throw new Error(`Hub connection failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`curl failed: ${result.stderr}`);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`Invalid JSON from Hub: ${result.stdout}`);
    }
  }

  private certPath: string = "";
  private keyPath: string = "";
  private caPath: string = "";

  private getCertPath(): string { return this.certPath; }
  private getKeyPath(): string { return this.keyPath; }
  private getCaPath(): string { return this.caPath; }

  // Re-initialize with paths (called from constructor indirectly)
  static create(hubUrl: string, certPath: string, keyPath: string, caPath: string): RemoteStackProvider {
    const provider = new RemoteStackProvider(hubUrl, certPath, keyPath, caPath);
    provider.certPath = certPath;
    provider.keyPath = keyPath;
    provider.caPath = caPath;
    return provider;
  }

  listStacks(stacktype?: string): IStack[] {
    const query = stacktype ? `?stacktype=${encodeURIComponent(stacktype)}` : "";
    const response = this.fetchJsonSync<{ stacks: IStack[] }>(`/api/hub/stacks${query}`);
    return response.stacks;
  }

  getStack(id: string): IStack | null {
    try {
      const response = this.fetchJsonSync<{ stack: IStack }>(`/api/hub/stack/${encodeURIComponent(id)}`);
      return response.stack;
    } catch (err: any) {
      if (err.message?.includes("404")) return null;
      throw err;
    }
  }

  addStack(stack: IStack): string {
    const response = this.fetchJsonSync<{ key: string }>("/api/hub/stacks", "POST", stack);
    logger.info("Stack created on Hub", { key: response.key });
    return response.key;
  }

  deleteStack(id: string): boolean {
    const response = this.fetchJsonSync<{ deleted: boolean }>(`/api/hub/stack/${encodeURIComponent(id)}`, "DELETE");
    if (response.deleted) logger.info("Stack deleted on Hub", { id });
    return response.deleted;
  }
}

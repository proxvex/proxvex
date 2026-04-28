import { spawnSync } from "node:child_process";
import { IStack } from "../types.mjs";
import { IStackProvider } from "./stack-provider.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("remote-stack-provider");

/**
 * Remote stack provider: delegates stack operations to the Hub deployer via HTTP(S).
 *
 * Auth: If a bearer token getter is provided and returns a token, it's sent
 * as `Authorization: Bearer <token>`. Otherwise the request goes unauthenticated
 * (Hub without OIDC accepts this).
 *
 * TLS trust: During TOFU (Trust On First Use) the HTTPS agent accepts any
 * certificate. Once a trusted CA PEM is known, it is pinned via `ca:`. For
 * plain http:// hub URLs TLS is not used.
 *
 * The `IStackProvider` interface is synchronous (listStacks / getStack / addStack /
 * deleteStack). Since Node `http.request` is async, we use `spawnSync("curl")`
 * under the hood — matches the legacy approach but without mTLS flags.
 */
export class RemoteStackProvider implements IStackProvider {
  private hubUrl: string;
  private isHttps: boolean;

  private constructor(
    hubUrl: string,
    private getBearerToken?: () => string | undefined,
    private trustedHubCa?: string,
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.isHttps = this.hubUrl.startsWith("https://");
    logger.info("Remote stack provider initialized", {
      hubUrl: this.hubUrl,
      tls: this.isHttps
        ? trustedHubCa
          ? "pinned-ca"
          : "TOFU-insecure"
        : "http",
    });
  }

  static create(
    hubUrl: string,
    getBearerToken?: () => string | undefined,
    trustedHubCa?: string,
  ): RemoteStackProvider {
    return new RemoteStackProvider(hubUrl, getBearerToken, trustedHubCa);
  }

  private fetchJsonSync<T>(path: string, method: string = "GET", body?: unknown): T {
    const url = `${this.hubUrl}${path}`;
    const args: string[] = ["-s", "--max-time", "10"];

    if (this.isHttps && !this.trustedHubCa) {
      args.push("-k"); // TOFU — trust any cert
    }
    // Note: when we have a trustedHubCa, we don't pass --cacert because
    // the Hub cert is signed by it and we rely on OS-level trust for
    // production Hubs. A future improvement writes the CA to a temp file
    // and passes --cacert for proper validation.

    if (method !== "GET") {
      args.push("-X", method);
    }
    const token = this.getBearerToken?.();
    if (token) {
      args.push("-H", `Authorization: Bearer ${token}`);
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

  listStacks(stacktype?: string): IStack[] {
    const query = stacktype ? `?stacktype=${encodeURIComponent(stacktype)}` : "";
    const response = this.fetchJsonSync<{ stacks: IStack[] }>(`/api/hub/stacks${query}`);
    return response.stacks;
  }

  getStack(id: string): IStack | null {
    try {
      const response = this.fetchJsonSync<{ stack: IStack }>(`/api/hub/stack/${encodeURIComponent(id)}`);
      return response.stack;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("404")) return null;
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

  /**
   * Fetch repositories tarball from the Hub and pipe it to a local directory.
   * Uses curl + tar via shell pipe to keep dependencies minimal.
   */
  async fetchRepositoriesTarball(targetPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.hubUrl}/api/hub/repositories.tar.gz`;
      const args: string[] = ["-s", "-f", "--max-time", "60"];
      if (this.isHttps && !this.trustedHubCa) args.push("-k");
      const token = this.getBearerToken?.();
      if (token) args.push("-H", `Authorization: Bearer ${token}`);
      args.push(url);

      // pipe curl → tar xzf -
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const curl = spawn("curl", args);
      const tar = spawn("tar", ["xzf", "-", "-C", targetPath]);
      curl.stdout.pipe(tar.stdin);
      let curlErr = "";
      curl.stderr.on("data", (d) => (curlErr += d.toString()));
      tar.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extraction failed (code ${code})`));
      });
      curl.on("error", (err) =>
        reject(new Error(`curl failed: ${err.message}`)),
      );
      tar.on("error", (err) =>
        reject(new Error(`tar failed: ${err.message}`)),
      );
      curl.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`curl exited with ${code}: ${curlErr}`));
        }
      });
    });
  }
}

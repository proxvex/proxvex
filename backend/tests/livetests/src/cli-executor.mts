/**
 * CLI executor for the live-test runner.
 *
 * Spawns the OCI LXC CLI in --json mode, parses structured messages from
 * stdout, and extracts resolved version information from script results.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Minimal local interface compatible with IVeExecuteMessage from @src/types.mts.
// We define it locally so the test runner does not depend on the backend build.
export interface CliMessage {
  command: string;
  commandtext?: string;
  stderr: string;
  result: string | null;
  exitCode: number;
  execute_on?: string;
  error?: { message?: string } | undefined;
  index?: number;
  finished?: boolean;
  partial?: boolean;
  vmId?: number;
  redirectUrl?: string;
}

export interface CliJsonResult {
  messages: CliMessage[];
  exitCode: number;
  vmId?: number;
  output: string;                          // raw stdout for backward compat
  resolvedVersions: Map<string, string>;   // "POSTGRES" -> "16-alpine"
}

/**
 * Parse raw stdout (one JSON object per line) into CliMessage[].
 * Non-JSON lines are silently ignored.
 */
function parseMessages(raw: string): CliMessage[] {
  const messages: CliMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as CliMessage);
    } catch {
      // not a JSON line – skip
    }
  }
  return messages;
}

/**
 * Extract _VERSION values from result fields across all messages.
 */
function extractVersions(messages: CliMessage[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const msg of messages) {
    if (msg.result) {
      try {
        const outputs: unknown = JSON.parse(msg.result);
        if (Array.isArray(outputs)) {
          for (const o of outputs) {
            if (
              typeof o === "object" && o !== null &&
              typeof (o as Record<string, unknown>).id === "string" &&
              (o as Record<string, string>).id.endsWith("_VERSION")
            ) {
              versions.set(
                (o as Record<string, string>).id.replace(/_VERSION$/, ""),
                String((o as Record<string, unknown>).value),
              );
            }
          }
        }
      } catch {
        // result is not a JSON array – skip
      }
    }
  }
  return versions;
}

/**
 * Spawn the OCI LXC CLI in --json mode and return structured results.
 *
 * stderr from the child is streamed to the current process stderr so the
 * operator can follow progress in real-time.
 */
export function runCli(
  projectRoot: string,
  apiUrl: string,
  veHost: string,
  paramsFile: string,
  addons?: string[],
  cliTimeout = 600,
  fixturePath?: string,
  oidcCredentials?: { issuerUrl: string; clientId: string; clientSecret: string },
): Promise<CliJsonResult> {
  return new Promise((resolve) => {
    // Auto-detect dev mode: if TypeScript source exists, use tsx
    const tsSource = path.join(projectRoot, "cli/src/oci-lxc-cli.mts");
    const devMode = existsSync(tsSource);

    const cliArgs = [
      "remote",
      "--server", apiUrl,
      "--ve", veHost,
      "--insecure",
      "--timeout", String(cliTimeout),
      "--json",
    ];

    if (oidcCredentials) {
      cliArgs.push(
        "--oidc-issuer", oidcCredentials.issuerUrl,
        "--oidc-client-id", oidcCredentials.clientId,
        "--oidc-client-secret", oidcCredentials.clientSecret,
      );
    }

    if (addons && addons.length > 0) {
      cliArgs.push("--enable-addons", addons.join(","));
    }

    if (fixturePath) {
      cliArgs.push("--fixture-path", fixturePath);
    }

    cliArgs.push(paramsFile);

    let cmd: string;
    let args: string[];
    if (devMode) {
      cmd = "npx";
      args = ["tsx", tsSource, ...cliArgs];
    } else {
      cmd = "node";
      args = [path.join(projectRoot, "cli/dist/cli/src/oci-lxc-cli.mjs"), ...cliArgs];
    }

    let stdout = "";
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => {
      process.stderr.write(data.toString());
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      const messages = parseMessages(stdout);

      // Find vmId from the final "finished" message
      const finishedMsg = messages.find((m) => m.finished);
      const vmId = finishedMsg?.vmId;

      const resolvedVersions = extractVersions(messages);

      resolve({
        messages,
        exitCode,
        vmId,
        output: stdout,
        resolvedVersions,
      });
    });
  });
}

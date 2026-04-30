import os from "node:os";

export interface DeployerUrlResolverInputs {
  envOverride?: string | undefined;
  hubUrl?: string | undefined;
  requestOrigin?: string | undefined;
  deployerPort: string;
  hostname?: string | undefined;
}

/**
 * Resolves the base URL embedded into LXC container Notes for log viewer
 * links. Fallback chain:
 *   1. PROXVEX_URL env var (explicit operator override)
 *   2. Hub URL when in Spoke mode (so Notes point to the long-term-reachable
 *      Hub, not the ephemeral Spoke)
 *   3. Origin of the incoming HTTP request (works without any configuration:
 *      whatever URL the user is currently using to talk to the deployer is by
 *      definition reachable from their browser)
 *   4. ${os.hostname()}:${deployerPort} as a last resort for non-HTTP callers
 */
export function resolveDeployerBaseUrl(
  inputs: DeployerUrlResolverInputs,
): string {
  const trimmed = (s?: string): string => (s ?? "").trim();

  const env = trimmed(inputs.envOverride);
  if (env) return env.replace(/\/+$/, "");

  const hub = trimmed(inputs.hubUrl);
  if (hub) return hub.replace(/\/+$/, "");

  const origin = trimmed(inputs.requestOrigin);
  if (origin) return origin.replace(/\/+$/, "");

  const host = trimmed(inputs.hostname) || os.hostname();
  return `http://${host}:${inputs.deployerPort}`;
}

/**
 * Shared test fixtures for OIDC-protected applications.
 *
 * `getDeployerToken()` performs an OAuth2 client_credentials grant against
 * the Zitadel issuer using the machine-user credentials provided by the
 * test environment (set by the livetest runner from /bootstrap/test-deployer.json,
 * or manually via env when running standalone). The returned access token can
 * be posted to a proxvex backend's POST /api/auth/dev-session to bypass the
 * Zitadel UI login.
 *
 * The token request is dispatched via Playwright's APIRequestContext so it
 * runs on the **remote** Playwright server (inside the nested VM's
 * playwright-default LXC), not from the local Node process. That removes the
 * need to expose Zitadel via an outer port-forward — the remote browser
 * resolves `zitadel-default.local` against the nested VM's dnsmasq.
 *
 * Required env vars:
 *   - OIDC_ISSUER_URL                       (e.g. http://zitadel-default.local:8080)
 *   - DEPLOYER_OIDC_MACHINE_CLIENT_ID
 *   - DEPLOYER_OIDC_MACHINE_CLIENT_SECRET
 */
import type { APIRequestContext } from "@playwright/test";

export interface DeployerOidcCredentials {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export function readDeployerOidcCredentialsFromEnv(): DeployerOidcCredentials {
  const issuer = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.DEPLOYER_OIDC_MACHINE_CLIENT_ID;
  const clientSecret = process.env.DEPLOYER_OIDC_MACHINE_CLIENT_SECRET;
  const missing = [
    !issuer && "OIDC_ISSUER_URL",
    !clientId && "DEPLOYER_OIDC_MACHINE_CLIENT_ID",
    !clientSecret && "DEPLOYER_OIDC_MACHINE_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `OIDC test fixture: missing env vars: ${missing.join(", ")}`,
    );
  }
  return {
    issuer: issuer!.replace(/\/$/, ""),
    clientId: clientId!,
    clientSecret: clientSecret!,
  };
}

export async function getDeployerToken(
  request: APIRequestContext,
  creds: DeployerOidcCredentials = readDeployerOidcCredentialsFromEnv(),
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope:
      "openid urn:zitadel:iam:org:project:id:zitadel:aud urn:zitadel:iam:org:projects:roles",
  });
  const response = await request.post(`${creds.issuer}/oauth/v2/token`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: body.toString(),
    ignoreHTTPSErrors: true,
  });
  if (!response.ok()) {
    throw new Error(
      `client_credentials token request failed: HTTP ${response.status()} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("client_credentials response missing access_token");
  }
  return payload.access_token;
}

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
 * Required env vars:
 *   - OIDC_ISSUER_URL                       (e.g. http://zitadel:8080)
 *   - DEPLOYER_OIDC_MACHINE_CLIENT_ID
 *   - DEPLOYER_OIDC_MACHINE_CLIENT_SECRET
 */

export interface DeployerOidcCredentials {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Override the Host header sent to the issuer. Needed when reaching Zitadel
   *  via an outer port-forward (e.g. http://ubuntupve:2808) — Zitadel uses
   *  ExternalDomain for instance routing and rejects requests with the wrong
   *  Host header ("Instance not found"). */
  hostHeader?: string;
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
  const creds: DeployerOidcCredentials = {
    issuer: issuer!.replace(/\/$/, ""),
    clientId: clientId!,
    clientSecret: clientSecret!,
  };
  if (process.env.OIDC_ISSUER_HOST_HEADER) {
    creds.hostHeader = process.env.OIDC_ISSUER_HOST_HEADER;
  }
  return creds;
}

export async function getDeployerToken(
  creds: DeployerOidcCredentials = readDeployerOidcCredentialsFromEnv(),
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope:
      "openid urn:zitadel:iam:org:project:id:zitadel:aud urn:zitadel:iam:org:projects:roles",
  });
  // Node's fetch ignores a custom "host" header. When the issuer URL points
  // at a port-forward (e.g. http://ubuntupve:2808) but the server identifies
  // itself by ExternalDomain (Zitadel), we need a real host override. Drop
  // to the low-level http/https module which respects headers.host.
  const url = new URL(`${creds.issuer}/oauth/v2/token`);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body.toString())),
  };
  if (creds.hostHeader) headers["host"] = creds.hostHeader;
  const { request } = await import(url.protocol === "https:" ? "node:https" : "node:http");
  const { res, body: respBody } = await new Promise<{
    res: { statusCode?: number; statusMessage?: string };
    body: string;
  }>((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        headers,
        rejectUnauthorized: false,
      },
      (response: import("node:http").IncomingMessage) => {
        let data = "";
        response.setEncoding("utf-8");
        response.on("data", (c: string) => (data += c));
        response.on("end", () => resolve({ res: response, body: data }));
      },
    );
    req.on("error", reject);
    req.write(body.toString());
    req.end();
  });
  if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
    throw new Error(
      `client_credentials token request failed: HTTP ${res.statusCode} ${res.statusMessage} ${respBody}`,
    );
  }
  const payload = JSON.parse(respBody) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("client_credentials response missing access_token");
  }
  return payload.access_token;
}

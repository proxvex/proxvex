import { createLogger } from "../logger/index.mjs";

const logger = createLogger("zitadel-client");

/**
 * ZITADEL service account client.
 *
 * Authenticates via client_credentials grant using a service account
 * created during bootstrap. Provides short-lived access tokens for
 * ZITADEL Management API calls (e.g., creating OIDC apps for LXC operations).
 *
 * Environment variables:
 *   ZITADEL_SVC_CLIENT_ID     - Service account client ID
 *   ZITADEL_SVC_CLIENT_SECRET - Service account client secret
 *   ZITADEL_SVC_ISSUER_URL    - ZITADEL issuer URL (falls back to OIDC_ISSUER_URL)
 *   ZITADEL_SVC_PROJECT_ID    - ZITADEL project ID for audience scope
 */
export class ZitadelClient {
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  private readonly issuerUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly projectId: string | undefined;

  constructor() {
    this.clientId = process.env.ZITADEL_SVC_CLIENT_ID ?? "";
    this.clientSecret = process.env.ZITADEL_SVC_CLIENT_SECRET ?? "";
    this.issuerUrl =
      process.env.ZITADEL_SVC_ISSUER_URL ??
      process.env.OIDC_ISSUER_URL ??
      "";
    this.projectId = process.env.ZITADEL_SVC_PROJECT_ID;
  }

  /**
   * Whether the ZITADEL service account is configured.
   * When false, the system operates in legacy mode (file-based PAT).
   */
  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.issuerUrl);
  }

  /**
   * Get a valid access token, refreshing if needed.
   * Uses client_credentials grant against ZITADEL's token endpoint.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const tokenUrl = `${this.issuerUrl}/oauth/v2/token`;
    const scope = this.projectId
      ? `openid urn:zitadel:iam:org:project:id:${this.projectId}:aud`
      : "openid";

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope,
    });

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Token request failed (${response.status}): ${text}`,
          );
        }

        const data = (await response.json()) as {
          access_token: string;
          expires_in: number;
        };
        this.accessToken = data.access_token;
        // Refresh 60 seconds before actual expiry
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

        logger.info(
          `[zitadel-client] Obtained access token (expires in ${data.expires_in}s)`,
        );
        return this.accessToken;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          logger.warn(
            `[zitadel-client] Token request attempt ${attempt} failed, retrying in ${delay}ms`,
            { error: lastError.message },
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Failed to obtain ZITADEL access token after 3 attempts: ${lastError?.message}`,
    );
  }
}

/** Singleton instance */
let instance: ZitadelClient | null = null;

/**
 * Get the singleton ZitadelClient instance.
 * Returns null if service account is not configured (legacy mode).
 */
export function getZitadelClient(): ZitadelClient | null {
  if (!instance) {
    instance = new ZitadelClient();
    if (instance.isConfigured()) {
      logger.info(
        "[zitadel-client] Service account configured, zero-secret mode active",
      );
    } else {
      logger.info(
        "[zitadel-client] Service account not configured, operating in legacy mode",
      );
      return null;
    }
  }
  return instance.isConfigured() ? instance : null;
}

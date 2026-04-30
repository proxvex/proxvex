import type { Application, Request, Response } from "express";
import session from "express-session";
import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { createLogger } from "../logger/index.mjs";
import { setBearerToken } from "../services/bearer-token-store.mjs";
import { syncFromHub } from "../services/spoke-sync-service.mjs";

const logger = createLogger("oidc");

export interface OidcConfig {
  config: client.Configuration;
  issuerUrl: string;
  clientId: string;
  callbackUrl: string;
  requiredRole?: string;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const e = err as Error & { code?: string; cause?: unknown };
  const cause =
    e.cause instanceof Error
      ? { message: e.cause.message, code: (e.cause as { code?: string }).code, stack: e.cause.stack }
      : e.cause;
  return {
    name: e.name,
    message: e.message,
    code: e.code,
    cause,
    stack: e.stack,
  };
}

function logOidcFailure(
  message: string,
  err: unknown,
  oidcConfig?: OidcConfig,
  reqContext?: Record<string, unknown>,
): void {
  if (oidcConfig) {
    logger.info("[oidc] Active config (on failure)", {
      issuer: oidcConfig.issuerUrl,
      client_id: oidcConfig.clientId,
      callback: oidcConfig.callbackUrl,
      required_role: oidcConfig.requiredRole ?? null,
    });
  }
  if (reqContext) {
    logger.info("[oidc] Request context (on failure)", reqContext);
  }
  logger.error(message, serializeError(err));
}

/**
 * Initialize OIDC if environment variables are set.
 * Returns null if OIDC is not enabled.
 */
export async function initOidc(): Promise<OidcConfig | null> {
  if (process.env.OIDC_ENABLED !== "true") {
    logger.info("[oidc] OIDC authentication: DISABLED (OIDC_ENABLED != true)");
    return null;
  }

  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const callbackUrl = process.env.OIDC_CALLBACK_URL;

  if (!issuerUrl || !clientId || !clientSecret || !callbackUrl) {
    logger.error(
      "[oidc] OIDC authentication: DISABLED — OIDC_ENABLED=true but required env vars missing (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_CALLBACK_URL)",
    );
    return null;
  }

  try {
    // Allow HTTP for internal/LAN issuer URLs (e.g. http://zitadel:8080)
    const discoveryOptions: Parameters<typeof client.discovery>[4] =
      new URL(issuerUrl).protocol === "http:"
        ? { execute: [client.allowInsecureRequests] }
        : undefined;
    const config = await client.discovery(
      new URL(issuerUrl),
      clientId,
      { client_secret: clientSecret },
      undefined,
      discoveryOptions,
    );
    const requiredRole = process.env.OIDC_REQUIRED_ROLE;
    logger.info(
      `[oidc] OIDC authentication: ENABLED — issuer=${issuerUrl} client_id=${clientId} callback=${callbackUrl}${requiredRole ? ` required_role=${requiredRole}` : ""}`,
    );
    const result: OidcConfig = { config, issuerUrl, clientId, callbackUrl };
    if (requiredRole) {
      result.requiredRole = requiredRole;
    }
    return result;
  } catch (err) {
    logger.error(
      `[oidc] OIDC authentication: FAILED — could not reach issuer ${issuerUrl}`,
      serializeError(err),
    );
    return null;
  }
}

/**
 * Set up express-session middleware.
 */
export function setupSession(app: Application): void {
  app.use(
    session({
      secret: process.env.OIDC_SESSION_SECRET || randomBytes(32).toString("hex"),
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Set to true if behind HTTPS proxy
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      },
    }),
  );
}

// Zitadel role claim key prefix (project-specific: urn:zitadel:iam:org:project:{id}:roles)
const ZITADEL_ROLES_CLAIM_PREFIX = "urn:zitadel:iam:org:project:";

/**
 * Check if a roles claim contains the required role.
 * Zitadel uses project-specific claim keys:
 *   urn:zitadel:iam:org:project:roles (authorization_code flow)
 *   urn:zitadel:iam:org:project:{projectId}:roles (client_credentials flow)
 */
function hasRole(
  claims: Record<string, unknown>,
  requiredRole: string,
): boolean {
  for (const [key, value] of Object.entries(claims)) {
    if (
      key.startsWith(ZITADEL_ROLES_CLAIM_PREFIX) &&
      key.endsWith(":roles") &&
      value &&
      typeof value === "object" &&
      requiredRole in (value as Record<string, unknown>)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Register OIDC auth routes.
 */
export function registerOidcRoutes(
  app: Application,
  oidcConfig: OidcConfig,
): void {
  // GET /api/auth/config - public endpoint
  app.get("/api/auth/config", (req: Request, res: Response) => {
    const authenticated = !!(req.session as AuthSession)?.authenticated;
    const result: {
      oidcEnabled: boolean;
      authenticated: boolean;
      user?: { name?: string; email?: string };
      roles?: Record<string, Record<string, unknown>>;
      issuerUrl?: string;
    } = {
      oidcEnabled: true,
      authenticated,
    };
    if (authenticated) {
      const sess = req.session as AuthSession;
      const user: { name?: string; email?: string } = {};
      if (sess.userName) user.name = sess.userName;
      if (sess.userEmail) user.email = sess.userEmail;
      result.user = user;
      if (sess.roles) result.roles = sess.roles;
      result.issuerUrl = oidcConfig.issuerUrl;
    }
    res.json(result);
  });

  // GET /api/auth/token - returns access token for direct ZITADEL API calls
  app.get("/api/auth/token", (req: Request, res: Response) => {
    const sess = req.session as AuthSession;
    if (!sess?.authenticated || !sess.accessToken) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    res.json({ accessToken: sess.accessToken });
  });

  // GET /api/auth/login - redirect to Zitadel
  app.get("/api/auth/login", (req: Request, res: Response) => {
    const state = client.randomState();
    const nonce = client.randomNonce();

    const sess = req.session as AuthSession;
    sess.oidcState = state;
    sess.oidcNonce = nonce;

    const authUrl = client.buildAuthorizationUrl(oidcConfig.config, {
      redirect_uri: oidcConfig.callbackUrl,
      scope: "openid email profile urn:zitadel:iam:org:project:roles urn:zitadel:iam:org:project:id:zitadel:aud",
      state,
      nonce,
      response_type: "code",
    });

    res.redirect(authUrl.href);
  });

  // GET /api/auth/callback - handle OIDC callback
  app.get(
    "/api/auth/callback",
    async (req: Request, res: Response): Promise<void> => {
      const sess = req.session as AuthSession;
      const expectedState = sess.oidcState;
      const expectedNonce = sess.oidcNonce;

      if (!expectedState || !expectedNonce) {
        res.status(400).send("Invalid session state. Please try logging in again.");
        return;
      }

      try {
        // Build the full callback URL from request
        const currentUrl = new URL(
          `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        );

        const tokenResponse = await client.authorizationCodeGrant(
          oidcConfig.config,
          currentUrl,
          {
            expectedState,
            expectedNonce,
          },
        );

        const claims = tokenResponse.claims();
        if (!claims) {
          res.status(403).send("No ID token received from identity provider.");
          return;
        }

        // Role check
        if (oidcConfig.requiredRole) {
          const allClaims = claims as unknown as Record<string, unknown>;
          if (!hasRole(allClaims, oidcConfig.requiredRole)) {
            logger.warn(
              `[oidc] User ${claims.sub} denied: missing role '${oidcConfig.requiredRole}'`,
            );
            res
              .status(403)
              .send(
                `Access denied. Required role: '${oidcConfig.requiredRole}'. Please contact your administrator.`,
              );
            return;
          }
        }

        // Create session
        sess.authenticated = true;
        const claimsRecord = claims as Record<string, unknown>;

        // ZITADEL often returns only `sub` in the ID token and moves name/email
        // to the UserInfo endpoint. Fetch it to fill in the display fields.
        try {
          const userinfoEndpoint =
            oidcConfig.config.serverMetadata().userinfo_endpoint;
          if (userinfoEndpoint) {
            const userinfoResp = await fetch(userinfoEndpoint, {
              headers: {
                Authorization: `Bearer ${tokenResponse.access_token}`,
              },
            });
            if (userinfoResp.ok) {
              const userinfo = (await userinfoResp.json()) as Record<
                string,
                unknown
              >;
              for (const [k, v] of Object.entries(userinfo)) {
                if (claimsRecord[k] == null) claimsRecord[k] = v;
              }
            } else {
              logger.warn(
                `[oidc] UserInfo fetch returned HTTP ${userinfoResp.status}`,
              );
            }
          }
        } catch (err) {
          logger.warn("[oidc] UserInfo fetch error", serializeError(err));
        }

        // Try name → preferred_username → given+family → email (in that order)
        const nameCandidate =
          (typeof claimsRecord.name === "string" && claimsRecord.name) ||
          (typeof claimsRecord.preferred_username === "string" &&
            claimsRecord.preferred_username) ||
          [
            typeof claimsRecord.given_name === "string"
              ? claimsRecord.given_name
              : "",
            typeof claimsRecord.family_name === "string"
              ? claimsRecord.family_name
              : "",
          ]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          (typeof claimsRecord.email === "string" && claimsRecord.email) ||
          "";
        if (nameCandidate) sess.userName = nameCandidate;
        if (typeof claimsRecord.email === "string") {
          sess.userEmail = claimsRecord.email;
        }
        sess.sub = claims.sub;

        // Extract all ZITADEL roles from project-specific claims
        const roles: Record<string, Record<string, unknown>> = {};
        for (const [key, value] of Object.entries(claimsRecord)) {
          if (
            key.startsWith(ZITADEL_ROLES_CLAIM_PREFIX) &&
            key.endsWith(":roles") &&
            value &&
            typeof value === "object"
          ) {
            Object.assign(roles, value as Record<string, Record<string, unknown>>);
          }
        }
        // Additionally fetch ZITADEL Manager roles (ORG_OWNER, IAM_OWNER,
        // PROJECT_OWNER, ...) via the AuthService. These are not carried in
        // the OIDC `urn:zitadel:iam:org:project:roles` scope — they live in
        // the user's memberships on instance/org/project level and are
        // required for the frontend's `isOrgOwner` / `isProjectOwner` checks.
        try {
          const membershipResp = await fetch(
            `${oidcConfig.issuerUrl.replace(/\/$/, "")}/auth/v1/memberships/me/_search`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${tokenResponse.access_token}`,
                "Content-Type": "application/json",
              },
              body: "{}",
            },
          );
          if (membershipResp.ok) {
            const data = (await membershipResp.json()) as {
              result?: Array<{
                roles?: string[];
                projectGrantId?: string;
                projectId?: string;
                orgId?: string;
                iam?: boolean;
              }>;
            };
            for (const m of data.result ?? []) {
              for (const role of m.roles ?? []) {
                // Preserve existing metadata (project-role claims) if present
                if (!roles[role]) roles[role] = {};
                const meta = roles[role] as Record<string, unknown>;
                if (m.projectId) meta.projectId = m.projectId;
                if (m.orgId) meta.orgId = m.orgId;
                if (m.iam) meta.iam = true;
              }
            }
          } else {
            logger.warn(
              `[oidc] Failed to fetch memberships: HTTP ${membershipResp.status}`,
            );
          }
        } catch (err) {
          logger.warn("[oidc] Membership fetch error", serializeError(err));
        }
        sess.roles = roles;

        // Store access token for frontend-to-ZITADEL direct API calls
        sess.accessToken = tokenResponse.access_token;

        // Expose the access token to the Spoke-mode remote providers so
        // they can authenticate against the Hub's OIDC-protected endpoints.
        setBearerToken(tokenResponse.access_token);

        // Clean up OIDC state
        delete sess.oidcState;
        delete sess.oidcNonce;

        logger.info(`[oidc] User logged in: ${sess.userName || claims.sub}`);

        // Trigger Spoke-Sync if the current SSH entry points at a Hub
        // (isHub=true + hubApiUrl set). Runs asynchronously — the user lands
        // on the redirect immediately; the sync continues in the background
        // and writes into <local>/.hubs/<hub-id>/.
        const { PersistenceManager } = await import(
          "../persistence/persistence-manager.mjs"
        );
        const pmInstance = PersistenceManager.getInstance();
        const hubUrl = pmInstance.getActiveHubUrl();
        if (hubUrl) {
          const localPath = pmInstance.getPathes().localPath;
          syncFromHub(hubUrl, localPath)
            .then((r) =>
              logger.info(
                `[oidc] Spoke-sync done: ${r.workspacePath} (hub=${r.hubUrl})`,
              ),
            )
            .catch((err) =>
              logger.warn("[oidc] Spoke-sync failed", { error: err.message }),
            );
        }
        res.redirect("/");
      } catch (err) {
        logOidcFailure("[oidc] Callback error", err, oidcConfig, {
          protocol: req.protocol,
          host: req.get("host"),
          original_url: req.originalUrl,
          has_state_param: req.query.state != null,
          has_code_param: req.query.code != null,
        });
        res.status(500).send("Authentication failed. Please try again.");
      }
    },
  );

  // POST /api/auth/logout - destroy session
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    // Clear the Spoke bearer token so no further Hub requests use it.
    setBearerToken(undefined);
    req.session.destroy((err) => {
      if (err) {
        logger.error("[oidc] Logout error", serializeError(err));
      }
      // Redirect to Zitadel end session if available
      const endSessionEndpoint =
        oidcConfig.config.serverMetadata().end_session_endpoint;
      if (endSessionEndpoint) {
        const url = new URL(endSessionEndpoint);
        url.searchParams.set("post_logout_redirect_uri", oidcConfig.callbackUrl.replace("/api/auth/callback", "/"));
        res.json({ redirectUrl: url.href });
      } else {
        res.json({ redirectUrl: "/" });
      }
    });
  });
}

// Session type augmentation
interface AuthSession {
  authenticated?: boolean;
  userName?: string;
  userEmail?: string;
  sub?: string;
  oidcState?: string;
  oidcNonce?: string;
  roles?: Record<string, Record<string, unknown>>;
  accessToken?: string;
}

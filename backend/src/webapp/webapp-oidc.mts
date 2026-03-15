import type { Application, Request, Response } from "express";
import session from "express-session";
import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("oidc");

export interface OidcConfig {
  config: client.Configuration;
  issuerUrl: string;
  clientId: string;
  callbackUrl: string;
  requiredRole?: string;
}

/**
 * Initialize OIDC if environment variables are set.
 * Returns null if OIDC is not enabled.
 */
export async function initOidc(): Promise<OidcConfig | null> {
  if (process.env.OIDC_ENABLED !== "true") {
    return null;
  }

  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const callbackUrl = process.env.OIDC_CALLBACK_URL;

  if (!issuerUrl || !clientId || !clientSecret || !callbackUrl) {
    logger.error(
      "[oidc] OIDC_ENABLED=true but missing required env vars: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_CALLBACK_URL",
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
    logger.info(`[oidc] OIDC initialized with issuer: ${issuerUrl}`);
    const result: OidcConfig = { config, issuerUrl, clientId, callbackUrl };
    if (process.env.OIDC_REQUIRED_ROLE) {
      result.requiredRole = process.env.OIDC_REQUIRED_ROLE;
    }
    return result;
  } catch (err) {
    logger.error("[oidc] Failed to discover OIDC issuer", { error: err });
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
    }
    res.json(result);
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
      scope: "openid email profile",
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
        if (typeof claimsRecord.name === "string") {
          sess.userName = claimsRecord.name;
        }
        if (typeof claimsRecord.email === "string") {
          sess.userEmail = claimsRecord.email;
        }
        sess.sub = claims.sub;

        // Clean up OIDC state
        delete sess.oidcState;
        delete sess.oidcNonce;

        logger.info(`[oidc] User logged in: ${sess.userName || claims.sub}`);
        res.redirect("/");
      } catch (err) {
        logger.error("[oidc] Callback error", { error: err });
        res.status(500).send("Authentication failed. Please try again.");
      }
    },
  );

  // POST /api/auth/logout - destroy session
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        logger.error("[oidc] Logout error", { error: err });
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
}

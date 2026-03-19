import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcConfig } from "./webapp-oidc.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("auth");

// Zitadel role claim key prefix (project-specific: urn:zitadel:iam:org:project:{id}:roles)
const ZITADEL_ROLES_CLAIM_PREFIX = "urn:zitadel:iam:org:project:";

// Paths that are always public (no auth required)
const PUBLIC_PATHS = [
  "/api/auth/config",
  "/api/auth/login",
  "/api/auth/callback",
  "/api/validate",
];

interface AuthSession {
  authenticated?: boolean;
}

/**
 * Create auth middleware.
 * - If OIDC is configured: checks session cookie or JWT Bearer token
 * - If OIDC is not configured: returns null (no auth)
 */
export function createAuthMiddleware(
  oidcConfig?: OidcConfig | null,
): ((req: Request, res: Response, next: NextFunction) => void) | null {
  if (!oidcConfig) {
    return null;
  }

  // Create JWKS fetcher for JWT validation (cached)
  const jwksUri = oidcConfig.config.serverMetadata().jwks_uri;
  const jwksUrl = new URL(jwksUri ?? `${oidcConfig.issuerUrl}/oauth/v2/keys`);
  const jwks = createRemoteJWKSet(jwksUrl);

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // Skip auth for public paths
    if (PUBLIC_PATHS.some((p) => req.path === p)) {
      next();
      return;
    }

    // 1. Check session cookie (browser login)
    const sess = req.session as AuthSession | undefined;
    if (sess?.authenticated) {
      next();
      return;
    }

    // 2. Check JWT Bearer token (CLI / Machine User)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: oidcConfig.issuerUrl,
        });

        // Role check — Zitadel uses project-specific claim keys:
        // urn:zitadel:iam:org:project:roles (authorization_code flow)
        // urn:zitadel:iam:org:project:{projectId}:roles (client_credentials flow)
        if (oidcConfig.requiredRole) {
          let hasRole = false;
          for (const [key, value] of Object.entries(payload)) {
            if (
              key.startsWith(ZITADEL_ROLES_CLAIM_PREFIX) &&
              key.endsWith(":roles") &&
              value &&
              typeof value === "object" &&
              oidcConfig.requiredRole in (value as Record<string, unknown>)
            ) {
              hasRole = true;
              break;
            }
          }
          if (!hasRole) {
            logger.warn(
              `[auth] JWT denied: missing role '${oidcConfig.requiredRole}' for sub=${payload.sub}`,
            );
            res
              .status(403)
              .json({ error: `Required role: '${oidcConfig.requiredRole}'` });
            return;
          }
        }

        next();
        return;
      } catch (err) {
        logger.warn("[auth] JWT validation failed", {
          error: err instanceof Error ? err.message : err,
        });
        res.status(401).json({ error: "Invalid token" });
        return;
      }
    }

    // No valid auth found
    res.status(401).json({ error: "Authentication required" });
  };
}

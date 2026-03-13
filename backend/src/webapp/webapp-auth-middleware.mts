import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcConfig } from "./webapp-oidc.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("auth");

// Zitadel role claim key
const ZITADEL_ROLES_CLAIM = "urn:zitadel:iam:org:project:roles";

// Paths that are always public (no auth required)
const PUBLIC_PATHS = ["/api/auth/config", "/api/auth/login", "/api/auth/callback"];

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
  const jwksUrl = new URL(
    `${oidcConfig.issuerUrl}/.well-known/jwks.json`,
  );
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

        // Role check
        if (oidcConfig.requiredRole) {
          const roles = payload[ZITADEL_ROLES_CLAIM];
          if (
            !roles ||
            typeof roles !== "object" ||
            !(oidcConfig.requiredRole in (roles as Record<string, unknown>))
          ) {
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

import type { Request, Response, NextFunction } from "express";

/**
 * Bearer token auth middleware.
 * Enable by setting OCI_DEPLOYER_API_TOKEN env var.
 * If not set, auth is disabled (backward compatible).
 */
export function createAuthMiddleware(): ((req: Request, res: Response, next: NextFunction) => void) | null {
  const expectedToken = process.env.OCI_DEPLOYER_API_TOKEN;
  if (!expectedToken) {
    return null;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== expectedToken) {
      res.status(403).json({ error: "Invalid token" });
      return;
    }

    next();
  };
}

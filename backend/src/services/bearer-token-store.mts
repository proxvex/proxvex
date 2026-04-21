/**
 * Global bearer token store for Spoke-mode Hub authentication.
 *
 * In OIDC mode, the OIDC callback writes the authenticated user's access
 * token here. Remote providers (RemoteCaProvider, RemoteStackProvider) read
 * it on every Hub request.
 *
 * In Non-OIDC mode the store stays empty — Hub endpoints are then open.
 *
 * Design note: single-token global. Multi-user spokes (each user with a
 * distinct token) are out of scope for v1 — a dev/admin spoke is expected
 * to be used by one operator at a time.
 */
let currentToken: string | undefined;

export function setBearerToken(token: string | undefined): void {
  currentToken = token;
}

export function getBearerToken(): string | undefined {
  return currentToken;
}

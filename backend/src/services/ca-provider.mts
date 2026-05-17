import { ICaInfoResponse } from "../types.mjs";

/**
 * Certificate Authority provider interface.
 * Hub mode: local operations (CertificateAuthorityService).
 * Spoke mode: delegates to Hub API (RemoteCaProvider, Phase 5).
 */
export interface ICaProvider {
  // CA lifecycle
  ensureCA(veContextKey: string): { key: string; cert: string };
  getCA(veContextKey: string): { key: string; cert: string } | null;
  hasCA(veContextKey: string): boolean;
  generateCA(veContextKey: string): { key: string; cert: string };
  setCA(veContextKey: string, key: string, cert: string): void;
  getCaInfo(veContextKey: string): ICaInfoResponse;
  validateCaPem(key: string, cert: string): { valid: boolean; subject?: string; error?: string };

  // Domain suffix (per VE context)
  getDomainSuffix(veContextKey: string): string;
  setDomainSuffix(veContextKey: string, suffix: string): void;

  // Shared volume path (per VE context)
  getSharedVolpath(veContextKey: string): string | null;
  setSharedVolpath(veContextKey: string, path: string): void;

  // Server certificates
  //
  // Server certs are NOT persisted by the provider. The container-side
  // `conf-generate-certificates.sh` keeps the on-disk cert when its identity
  // (CN+SAN) matches the freshly-signed candidate, so the disk is the source
  // of truth. The Hub provider always signs fresh; the Spoke provider uses
  // an in-process cache to coalesce redundant Hub round-trips within one
  // Reconfigure flow, but does not persist anything across restarts.
  generateSelfSignedCert(veContextKey: string, hostname?: string, extraSans?: string[]): { key: string; cert: string };
  ensureServerCert(veContextKey: string, hostname?: string, extraSans?: string[]): { key: string; cert: string };

  // Client certificates (mTLS user identities)
  //
  // Issues a CA-signed client certificate for a single Common Name. CN-only
  // (no SAN), `basicConstraints=CA:FALSE`, `extendedKeyUsage=clientAuth`.
  // Like server certs, nothing is persisted by the provider — the
  // container-side `conf-generate-mtls-certs.sh` keeps the on-disk cert when
  // its identity matches. Hub signs locally; Spoke delegates to the Hub API.
  signClientCert(veContextKey: string, cn: string): { key: string; cert: string };
}

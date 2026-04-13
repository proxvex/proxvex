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
  generateSelfSignedCert(veContextKey: string, hostname?: string): { key: string; cert: string };
  ensureServerCert(veContextKey: string, hostname?: string): { key: string; cert: string };
  getServerCert(hostname: string): { key: string; cert: string } | null;
  hasServerCert(hostname: string): boolean;
  setServerCert(hostname: string, key: string, cert: string): void;
  getServerCertInfo(hostname: string): ICaInfoResponse;
}

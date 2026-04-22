import { ContextManager } from "../context-manager.mjs";
import { CertificateAuthorityService } from "./certificate-authority-service.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { IAutoRenewalStatus, ICertificateStatus, ICommand } from "../types.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("cert-auto-renewal");

export const CA_ISSUER_MARKER = "OCI-LXC-Deployer CA";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STATE_KEY = "auto_renewal";

interface StoredAutoRenewalState {
  enabled: boolean;
  last_check?: string | undefined;
  last_renewed?: string[] | undefined;
  last_renewed_date?: string | undefined;
  last_error?: string | undefined;
}

/**
 * Filter certificates that are eligible for auto-renewal:
 * - certtype must be "server"
 * - issuer must contain the CA marker (self-signed by our CA)
 * - status must be "warning" (≤30 days) or "expired"
 */
export function filterRenewableCerts(certificates: ICertificateStatus[]): {
  selfSigned: ICertificateStatus[];
  toRenew: ICertificateStatus[];
} {
  const selfSigned = certificates.filter(
    (cert) => cert.certtype === "server" && cert.issuer?.includes(CA_ISSUER_MARKER),
  );
  const toRenew = selfSigned.filter(
    (cert) => cert.status === "warning" || cert.status === "expired",
  );
  return { selfSigned, toRenew };
}

export class CertificateAutoRenewalService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private contextManager: ContextManager) {}

  private getState(): StoredAutoRenewalState {
    return this.contextManager.get<StoredAutoRenewalState>(STATE_KEY) || { enabled: false };
  }

  private setState(state: StoredAutoRenewalState): void {
    this.contextManager.set(STATE_KEY, state);
  }

  private getVeContextKeys(): string[] {
    return this.contextManager.keys().filter((k) => k.startsWith("ve_"));
  }

  isEnabled(): boolean {
    return this.getState().enabled;
  }

  setEnabled(enabled: boolean): void {
    const state = this.getState();
    state.enabled = enabled;
    this.setState(state);
    logger.info("Auto-renewal state changed", { enabled });

    if (enabled && !this.timer) {
      this.startTimer();
    } else if (!enabled && this.timer) {
      this.stop();
    }
  }

  getStatus(): IAutoRenewalStatus {
    const state = this.getState();
    const lastCheck = state.last_check ? new Date(state.last_check) : undefined;
    const nextCheck = lastCheck
      ? new Date(lastCheck.getTime() + CHECK_INTERVAL_MS).toISOString()
      : undefined;

    return {
      enabled: state.enabled,
      last_check: state.last_check,
      next_check: state.enabled ? nextCheck : undefined,
      last_renewed: state.last_renewed,
      last_renewed_date: state.last_renewed_date,
      last_error: state.last_error,
    };
  }

  /**
   * List certificates across all VE contexts.
   * Each certificate gets a `host` field indicating which VE context it belongs to.
   */
  async listAllCertificates(): Promise<ICertificateStatus[]> {
    const veKeys = this.getVeContextKeys();
    const allCerts: ICertificateStatus[] = [];

    for (const veKey of veKeys) {
      try {
        const certs = await this.listCertificatesForContext(veKey);
        const veContext = this.contextManager.getVEContextByKey(veKey);
        const hostName = veContext?.host || veKey.replace(/^ve_/, "");
        const port = (veContext as any)?.port as number | undefined;
        const host = port && port !== 22 ? `${hostName}:${port}` : hostName;
        for (const cert of certs) {
          (cert as any).host = host;
        }
        allCerts.push(...certs);
      } catch (err: any) {
        logger.warn(`Failed to list certificates for ${veKey}`, { error: err?.message });
      }
    }

    return allCerts;
  }

  /**
   * Start the periodic timer. Called on server startup if enabled.
   */
  startTimer(): void {
    if (this.timer) return;

    logger.info("Starting auto-renewal timer", { intervalMs: CHECK_INTERVAL_MS });
    this.timer = setInterval(() => {
      this.checkAndRenew().catch((err) => {
        logger.error("Auto-renewal check failed", { error: err?.message || String(err) });
      });
    }, CHECK_INTERVAL_MS);

    // Run an initial check shortly after startup (30 seconds)
    setTimeout(() => {
      if (this.isEnabled()) {
        this.checkAndRenew().catch((err) => {
          logger.error("Initial auto-renewal check failed", { error: err?.message || String(err) });
        });
      }
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Auto-renewal timer stopped");
    }
  }

  /**
   * Force-renew every self-signed server certificate across all VE contexts,
   * regardless of remaining validity. Intended for manual use after the root CA
   * has been rotated, so outstanding leaf certs get re-signed immediately.
   */
  async renewAllSelfSigned(): Promise<IAutoRenewalStatus> {
    return this.runRenewal({ forceAll: true });
  }

  /**
   * Check all certificates across all VE contexts and renew those that are
   * self-signed and expiring soon.
   */
  async checkAndRenew(): Promise<IAutoRenewalStatus> {
    return this.runRenewal({ forceAll: false });
  }

  private async runRenewal({ forceAll }: { forceAll: boolean }): Promise<IAutoRenewalStatus> {
    if (this.running) {
      logger.info("Auto-renewal check already in progress, skipping");
      return this.getStatus();
    }

    this.running = true;
    const state = this.getState();

    try {
      const veKeys = this.getVeContextKeys();
      if (veKeys.length === 0) {
        logger.info("No VE contexts configured, skipping auto-renewal");
        state.last_check = new Date().toISOString();
        state.last_error = undefined;
        state.last_renewed = [];
        this.setState(state);
        return this.getStatus();
      }

      const caService = new CertificateAuthorityService(this.contextManager);
      const allRenewed: string[] = [];
      let totalSelfSigned = 0;

      for (const veKey of veKeys) {
        if (!caService.hasCA(veKey)) continue;

        const veContext = this.contextManager.getVEContextByKey(veKey);
        const host = veContext?.host || veKey.replace(/^ve_/, "");

        try {
          const certificates = await this.listCertificatesForContext(veKey);
          const { selfSigned: selfSignedCerts, toRenew } = filterRenewableCerts(certificates);
          totalSelfSigned += selfSignedCerts.length;

          const targets = forceAll ? selfSignedCerts : toRenew;
          if (targets.length > 0) {
            const hostnames = Array.from(new Set(targets.map((c) => c.hostname)));
            await this.renewCertificatesForContext(veKey, caService, hostnames);
            allRenewed.push(...hostnames.map((h) => `${h}@${host}`));
          }
        } catch (err: any) {
          logger.warn(`Auto-renewal failed for ${host}`, { error: err?.message });
        }
      }

      const now = new Date().toISOString();
      state.last_check = now;
      state.last_error = undefined;
      state.last_renewed = allRenewed;
      if (allRenewed.length > 0) {
        state.last_renewed_date = now;
      }
      this.setState(state);

      const upToDate = totalSelfSigned - allRenewed.length;
      if (allRenewed.length > 0) {
        logger.info(`Auto certificate renewal: ${upToDate} up-to-date, ${allRenewed.length} renewed: ${allRenewed.join(", ")}`);
      } else {
        logger.info(`Auto certificate renewal: ${totalSelfSigned} up-to-date`);
      }

      return this.getStatus();
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      logger.error("Auto-renewal check failed", { error: errorMsg });
      state.last_check = new Date().toISOString();
      state.last_error = errorMsg;
      this.setState(state);
      return this.getStatus();
    } finally {
      this.running = false;
    }
  }

  private async listCertificatesForContext(
    veContextKey: string,
  ): Promise<ICertificateStatus[]> {
    const veContext = this.contextManager.getVEContextByKey(veContextKey);
    if (!veContext) throw new Error(`VE context not found: ${veContextKey}`);

    const pm = PersistenceManager.getInstance();
    const repositories = pm.getRepositories();
    const scriptContent = repositories.getScript({
      name: "list-certificate-status.sh",
      scope: "shared",
      category: "list",
    });
    if (!scriptContent) throw new Error("list-certificate-status.sh not found");

    const caService = new CertificateAuthorityService(this.contextManager);
    const sharedVolpath = caService.getSharedVolpath(veContextKey);

    const cmd: ICommand = {
      name: "List Certificate Status",
      execute_on: "ve",
      script: "list-certificate-status.sh",
      scriptContent,
      outputs: ["certificates"],
    };

    const inputs = sharedVolpath
      ? [{ id: "shared_volpath", value: sharedVolpath }]
      : [];

    const ve = new VeExecution(
      [cmd],
      inputs,
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );
    await ve.run(null);

    const certsRaw = ve.outputs.get("certificates");
    if (!certsRaw) return [];

    const parsed = typeof certsRaw === "string" && certsRaw.trim().length > 0
      ? JSON.parse(certsRaw)
      : certsRaw;

    return Array.isArray(parsed) ? parsed : [];
  }

  private async renewCertificatesForContext(
    veContextKey: string,
    caService: CertificateAuthorityService,
    hostnames: string[],
  ): Promise<void> {
    const veContext = this.contextManager.getVEContextByKey(veContextKey);
    if (!veContext) throw new Error(`VE context not found: ${veContextKey}`);

    const ca = caService.getCA(veContextKey)!;
    const sharedVolpath = caService.getSharedVolpath(veContextKey);

    const pm = PersistenceManager.getInstance();
    const repositories = pm.getRepositories();
    const scriptContent = repositories.getScript({
      name: "conf-renew-certificates.sh",
      scope: "shared",
      category: "pre_start",
    });
    const libraryContent = repositories.getScript({
      name: "cert-common.sh",
      scope: "shared",
      category: "library",
    });

    if (!scriptContent || !libraryContent) {
      throw new Error("Renewal scripts not found");
    }

    const cmd: ICommand = {
      name: "Renew Certificates",
      execute_on: "ve",
      script: "conf-renew-certificates.sh",
      scriptContent,
      libraryContent,
      outputs: ["certs_renewed"],
    };

    const inputs = [
      { id: "cert_renew_requests", value: hostnames.join("\n") },
      { id: "ca_key_b64", value: ca.key },
      { id: "ca_cert_b64", value: ca.cert },
      { id: "domain_suffix", value: caService.getDomainSuffix(veContextKey) },
      ...(sharedVolpath ? [{ id: "shared_volpath", value: sharedVolpath }] : []),
    ];

    const ve = new VeExecution(
      [cmd],
      inputs,
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );
    await ve.run(null);
  }
}

import { IParameter } from "@src/types.mjs";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";
import type { ContextManager } from "@src/context-manager.mjs";

/**
 * Injects auto-generated certificate requests into processed parameters
 * when certtype parameters exist and the user didn't upload their own certs.
 */
export class WebAppVeCertificateInjector {
  /**
   * Injects cert_requests, ca_key_b64, ca_cert_b64 into processedParams
   * when certtype parameters exist and user didn't upload their own certs.
   */
  injectCertificateRequests(
    processedParams: Array<{ id: string; value: string | number | boolean }>,
    loadedParameters: IParameter[],
    contextManager: ContextManager,
    veContextKey: string,
  ): void {
    // SSL is enabled whenever certtype parameters are present (from SSL addon)
    const certParams = loadedParameters.filter((p) => p.certtype && p.upload);
    if (certParams.length === 0) return;

    const inputMap = new Map(processedParams.map((p) => [p.id, p.value]));
    const certLines: string[] = [];

    for (const param of certParams) {
      const userValue = inputMap.get(param.id);
      const hasValue = userValue && userValue !== "" && String(userValue) !== "NOT_DEFINED";
      if (hasValue) continue; // User uploaded own cert

      const volumeKey = this.resolveVolumeKeyForCert(param, processedParams);
      certLines.push(`${param.id}|${param.certtype}|${volumeKey}`);
    }

    if (certLines.length > 0) {
      const caService = new CertificateAuthorityService(contextManager);
      const ca = caService.ensureCA(veContextKey);
      processedParams.push({ id: "cert_requests", value: certLines.join("\n") });
      processedParams.push({ id: "ca_key_b64", value: ca.key });
      processedParams.push({ id: "ca_cert_b64", value: ca.cert });
      processedParams.push({ id: "domain_suffix", value: caService.getDomainSuffix(veContextKey) });
    }
  }

  /**
   * Resolves the volume key for a cert parameter.
   * Looks at parameter ID pattern for volume hints, defaults to "secret".
   */
  private resolveVolumeKeyForCert(
    param: IParameter,
    processedParams: Array<{ id: string; value: string | number | boolean }>,
  ): string {
    // Use ssl.certs_dir if available (format: "volume_key[:subdirectory]")
    const certsDir = processedParams.find((p) => p.id === "ssl.certs_dir")?.value;
    if (certsDir && String(certsDir) !== "" && String(certsDir) !== "NOT_DEFINED") {
      return String(certsDir).split(":")[0] ?? "certs"; // Volume key part
    }
    // Fallback: heuristic based on parameter ID
    const id = param.id || "";
    if (id.includes("certs")) return "certs";
    if (id.includes("secret")) return "secret";
    if (id.includes("ssl") || id.includes("tls")) return "certs";
    return "secret";
  }
}

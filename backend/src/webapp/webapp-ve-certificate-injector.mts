import { IParameter } from "@src/types.mjs";
import { ICaProvider } from "@src/services/ca-provider.mjs";

/**
 * Injects CA key+cert into processed parameters when the SSL addon is active.
 * Template 156 uses these to generate certificates.
 */
export class WebAppVeCertificateInjector {
  /**
   * Injects ca_key_b64, ca_cert_b64, and domain_suffix into processedParams
   * when ssl.mode has certtype="server" marker and a value is set.
   */
  injectCertificateRequests(
    processedParams: Array<{ id: string; value: string | number | boolean }>,
    loadedParameters: IParameter[],
    caProvider: ICaProvider,
    veContextKey: string,
  ): void {
    // Detect SSL addon via certtype marker on ssl.mode parameter
    const sslParam = loadedParameters.find((p) => p.certtype === "server");
    if (!sslParam) return;

    // Check if ssl.mode value is set (from params or addon parameter default)
    const sslMode = processedParams.find((p) => p.id === sslParam.id)?.value
      ?? sslParam.default;
    if (!sslMode || sslMode === "" || String(sslMode) === "NOT_DEFINED") return;

    const ca = caProvider.ensureCA(veContextKey);

    processedParams.push({ id: "ca_key_b64", value: ca.key });
    processedParams.push({ id: "ca_cert_b64", value: ca.cert });
    processedParams.push({ id: "domain_suffix", value: caProvider.getDomainSuffix(veContextKey) });
  }
}

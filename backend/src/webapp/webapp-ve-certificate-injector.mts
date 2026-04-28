import { IParameter } from "@src/types.mjs";
import { ICaProvider } from "@src/services/ca-provider.mjs";

/**
 * Injects ready-to-use server certificate + public CA cert into processed
 * parameters when the SSL addon is active. Template 156 only writes these
 * to the managed certs volume — it does not sign anything (the CA private
 * key is never exposed to scripts).
 *
 * In Spoke mode the server cert is signed via the Hub's CA. In Hub mode it
 * is signed locally. Both flows go through `caProvider.ensureServerCert()`.
 */
export class WebAppVeCertificateInjector {
  /**
   * Injects server_key_b64, server_cert_b64, ca_cert_b64, domain_suffix into
   * processedParams when ssl.mode has certtype="server" marker and a value is
   * set. The hostname for the server cert comes from the existing `hostname`
   * parameter (added by the runner / cli before validation).
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

    // Determine hostname for the server cert (FQDN includes the domain suffix).
    const hostnameRaw = processedParams.find((p) => p.id === "hostname")?.value;
    const hostname = typeof hostnameRaw === "string" && hostnameRaw.length > 0
      ? hostnameRaw : "localhost";
    const domainSuffix = caProvider.getDomainSuffix(veContextKey) || ".local";
    const fqdn = hostname.includes(".") ? hostname : `${hostname}${domainSuffix}`;

    // Public CA cert — for trust store inside the container.
    const ca = caProvider.getCA(veContextKey);
    if (!ca) {
      // No CA available (e.g. Hub unreachable). Don't inject anything; template
      // 156 will skip via skip_if_all_missing on server_cert_b64.
      return;
    }

    // Server cert + key — signed by the CA (locally in Hub mode, via Hub API
    // in Spoke mode — both implemented inside ICaProvider.ensureServerCert).
    const server = caProvider.ensureServerCert(veContextKey, fqdn);

    processedParams.push({ id: "server_key_b64", value: server.key });
    processedParams.push({ id: "server_cert_b64", value: server.cert });
    processedParams.push({ id: "ca_cert_b64", value: ca.cert });
    processedParams.push({ id: "domain_suffix", value: domainSuffix });
  }
}

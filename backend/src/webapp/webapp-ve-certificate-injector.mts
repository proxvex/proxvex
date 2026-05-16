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
   * Injects server_key_b64, server_cert_b64, ca_cert_b64, project_domain_suffix into
   * processedParams when ssl.mode has certtype="server" marker and a value is
   * set. The hostname for the server cert comes from the existing `hostname`
   * parameter (added by the runner / cli before validation).
   */
  injectCertificateRequests(
    processedParams: Array<{ id: string; value: string | number | boolean }>,
    loadedParameters: IParameter[],
    caProvider: ICaProvider,
    veContextKey: string,
    applicationProperties?: Array<{ id: string; value?: unknown; default?: unknown }>,
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
    const projectDomainSuffix = caProvider.getDomainSuffix(veContextKey) || ".local";
    const fqdn = hostname.includes(".") ? hostname : `${hostname}${projectDomainSuffix}`;

    // Public CA cert — for trust store inside the container.
    const ca = caProvider.getCA(veContextKey);
    if (!ca) {
      // No CA available (e.g. Hub unreachable). Don't inject anything; template
      // 156 will skip via skip_if_all_missing on server_cert_b64.
      return;
    }

    // Extra SANs declared by the app (e.g. docker-registry-mirror sets
    // `DNS:registry-1.docker.io,DNS:index.docker.io` so the cert validates
    // when clients reach the mirror via /etc/hosts redirect). Application
    // properties hold the canonical value; processedParams (user input) wins
    // if explicitly overridden. Accepts the OpenSSL-style `DNS:` prefix or
    // bare names; the cert service normalizes.
    const sanFromParams = processedParams.find((p) => p.id === "ssl_additional_san")?.value;
    const sanFromProps = applicationProperties?.find((p) => p.id === "ssl_additional_san");
    const sanRaw = (typeof sanFromParams === "string" && sanFromParams.length > 0)
      ? sanFromParams
      : (typeof sanFromProps?.value === "string" && sanFromProps.value.length > 0
          ? (sanFromProps.value as string)
          : (typeof sanFromProps?.default === "string" && (sanFromProps.default as string).length > 0
              ? (sanFromProps.default as string)
              : ""));
    const extraSans = sanRaw.length > 0 ? sanRaw.split(",") : undefined;

    // Server cert + key — signed by the CA (locally in Hub mode, via Hub API
    // in Spoke mode — both implemented inside ICaProvider.ensureServerCert).
    const server = caProvider.ensureServerCert(veContextKey, fqdn, extraSans);

    processedParams.push({ id: "server_key_b64", value: server.key });
    processedParams.push({ id: "server_cert_b64", value: server.cert });
    processedParams.push({ id: "ca_cert_b64", value: ca.cert });
    processedParams.push({ id: "project_domain_suffix", value: projectDomainSuffix });
  }

  /**
   * Injects `mtls_client_certs_b64` (and `ca_cert_b64` if not already set) when
   * the mTLS addon is active. Activation gate: a parameter with
   * `certtype="client"` is only present in `loadedParameters` when `addon-mtls`
   * is in `selectedAddons` (merged by the route handler) — exactly mirroring
   * how `certtype="server"` gates the SSL path. No base application declares
   * `mtls_cns`, so without the addon this is a no-op.
   *
   * The bundle is base64(JSON) of `{ "<cn>": { key, cert }, ... }` where
   * key/cert are already base64 PEM. The CA private key is never exposed —
   * signing happens here (Hub) or via the Hub API (Spoke). Template 161 only
   * writes the decoded files to the managed `mtls` volume.
   *
   * Kept separate from injectCertificateRequests because that method early-
   * returns when SSL is absent; mTLS must work independently of SSL.
   */
  injectClientCertificateRequests(
    processedParams: Array<{ id: string; value: string | number | boolean }>,
    loadedParameters: IParameter[],
    caProvider: ICaProvider,
    veContextKey: string,
  ): void {
    const mtlsParam = loadedParameters.find((p) => p.certtype === "client");
    if (!mtlsParam) return;

    // mtlsParam.default is the literal "{{ hostname }}" — NOT resolved here.
    // When the CN list is empty, fall back to the resolved hostname param.
    const raw = processedParams.find((p) => p.id === mtlsParam.id)?.value;
    let cnsStr = typeof raw === "string" && raw.length > 0 ? raw : "";
    if (!cnsStr) {
      const hn = processedParams.find((p) => p.id === "hostname")?.value;
      cnsStr = typeof hn === "string" ? hn : "";
    }
    const cns = [
      ...new Set(cnsStr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)),
    ];
    if (cns.length === 0) return;

    const ca = caProvider.getCA(veContextKey);
    if (!ca) {
      // No CA available (e.g. Hub unreachable). Inject nothing; template 161
      // skips via skip_if_all_missing on mtls_client_certs_b64.
      return;
    }

    const bundle: Record<string, { key: string; cert: string }> = {};
    for (const cn of cns) {
      const signed = caProvider.signClientCert(veContextKey, cn);
      bundle[cn] = { key: signed.key, cert: signed.cert };
    }

    processedParams.push({
      id: "mtls_client_certs_b64",
      value: Buffer.from(JSON.stringify(bundle)).toString("base64"),
    });
    if (!processedParams.find((p) => p.id === "ca_cert_b64")) {
      processedParams.push({ id: "ca_cert_b64", value: ca.cert });
    }
  }
}

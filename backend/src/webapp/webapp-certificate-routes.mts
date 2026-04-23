import express from "express";
import {
  ApiUri,
  ICaInfoResponse,
  ICertificateStatusResponse,
  IPostCertRenewBody,
  IPostCertRenewResponse,
  IPostCaImportBody,
  IPostGenerateCertBody,
  IGenerateCertResponse,
  ICommand,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { CertificateAuthorityService } from "../services/certificate-authority-service.mjs";
import { CertificateAutoRenewalService } from "../services/certificate-auto-renewal-service.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

let autoRenewalService: CertificateAutoRenewalService | null = null;

export function getAutoRenewalService(): CertificateAutoRenewalService | null {
  return autoRenewalService;
}

export function registerCertificateRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  autoRenewalService = new CertificateAutoRenewalService(storageContext);
  const pm = PersistenceManager.getInstance();

  // GET /api/ve/certificates/ca/:veContext - CA info (no private key)
  app.get(ApiUri.CertificateCa, (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      const info: ICaInfoResponse = caService.getCaInfo(veContextKey);
      info.domain_suffix = caService.getDomainSuffix(veContextKey);
      res.status(200).json(info);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/ve/certificates/ca/:veContext - Import CA (upload key+cert)
  app.post(ApiUri.CertificateCa, express.json(), (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const body = req.body as IPostCaImportBody;
      if (!body.key || !body.cert) {
        res.status(400).json({ error: "Missing key or cert" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      const validation = caService.validateCaPem(body.key, body.cert);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      caService.setCA(veContextKey, body.key, body.cert);
      const info: ICaInfoResponse = caService.getCaInfo(veContextKey);
      res.status(200).json(info);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/ve/certificates/ca/generate/:veContext - Generate new CA
  app.post(ApiUri.CertificateCaGenerate, express.json(), (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      caService.generateCA(veContextKey);
      const info: ICaInfoResponse = caService.getCaInfo(veContextKey);
      res.status(200).json(info);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/ve/certificates/:veContext - List certs + CA info
  app.get(ApiUri.CertificateStatus, async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      const repositories = pm.getRepositories();
      const scriptContent = repositories.getScript({
        name: "list-certificate-status.sh",
        scope: "shared",
        category: "list",
      });
      if (!scriptContent) {
        res.status(500).json({ error: "list-certificate-status.sh not found" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
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
      const certificates = Array.isArray(certsRaw)
        ? certsRaw
        : typeof certsRaw === "string" && certsRaw.trim().length > 0
          ? JSON.parse(certsRaw)
          : [];

      const caInfo = caService.getCaInfo(veContextKey);
      const caStatus = caInfo.exists
        ? {
            subject: caInfo.subject!,
            expiry_date: caInfo.expiry_date!,
            days_remaining: caInfo.days_remaining!,
            status: caInfo.days_remaining! <= 30 ? "warning" : "ok",
          }
        : undefined;

      const payload = {
        certificates: Array.isArray(certificates) ? certificates : [],
        ...(caStatus ? { ca: caStatus } : {}),
      } as ICertificateStatusResponse;
      res.status(200).json(payload);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/ve/certificates/renew/:veContext - Renew selected
  app.post(ApiUri.CertificateRenew, express.json(), async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      const body = req.body as IPostCertRenewBody;
      if (!body.hostnames || body.hostnames.length === 0) {
        res.status(400).json({ error: "No hostnames specified" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      if (!caService.hasCA(veContextKey)) {
        res.status(400).json({ error: "No CA configured. Generate or import a CA first." });
        return;
      }

      const ca = caService.getCA(veContextKey)!;
      const sharedVolpath = caService.getSharedVolpath(veContextKey);

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
        res.status(500).json({ error: "Renewal scripts not found" });
        return;
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
        { id: "cert_renew_requests", value: body.hostnames.join("\n") },
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

      const payload: IPostCertRenewResponse = {
        success: true,
        renewed: body.hostnames.length,
      };
      res.status(200).json(payload);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/ve/certificates/pve/:veContext - PVE host cert status
  app.get(ApiUri.CertificatePveStatus, async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      // Read PVE cert via SSH
      const scriptContent = [
        "#!/bin/sh",
        '# Read PVE host certificate status',
        'CERT_PATH="/etc/pve/local/pve-ssl.pem"',
        'if [ ! -f "$CERT_PATH" ]; then',
        '  echo \'[{"id":"pve_cert","value":""}]\'',
        '  exit 0',
        'fi',
        'SUBJECT=$(openssl x509 -in "$CERT_PATH" -noout -subject 2>/dev/null | sed \'s/^subject= *//\')',
        'END_DATE=$(openssl x509 -in "$CERT_PATH" -noout -enddate 2>/dev/null | sed \'s/^notAfter=//\')',
        'echo "[{\\"id\\":\\"pve_cert\\",\\"value\\":\\"${SUBJECT}|${END_DATE}\\"}]"',
      ].join("\n");

      const cmd: ICommand = {
        name: "PVE Cert Status",
        execute_on: "ve",
        script: "pve-cert-status.sh",
        scriptContent,
        outputs: ["pve_cert"],
      };

      const ve = new VeExecution(
        [cmd],
        [],
        veContext,
        new Map(),
        undefined,
        determineExecutionMode(),
      );
      await ve.run(null);

      const pveCertRaw = ve.outputs.get("pve_cert");
      if (!pveCertRaw || typeof pveCertRaw !== "string" || !pveCertRaw.includes("|")) {
        res.status(200).json({ hostname: veContext.host, file: "/etc/pve/local/pve-ssl.pem", certtype: "pve", subject: "", expiry_date: "", days_remaining: 0, status: "expired" });
        return;
      }

      const [subject, endDateStr] = String(pveCertRaw).split("|");
      const endDate = new Date(endDateStr || "");
      const daysRemaining = Math.floor((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const status = daysRemaining <= 0 ? "expired" : daysRemaining <= 30 ? "warning" : "ok";

      res.status(200).json({
        hostname: veContext.host,
        file: "/etc/pve/local/pve-ssl.pem",
        certtype: "pve",
        subject: subject || "",
        expiry_date: endDate.toISOString(),
        days_remaining: daysRemaining,
        status,
      });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/ve/certificates/domain-suffix/:veContext - Save domain suffix
  app.post(ApiUri.CertificateDomainSuffix, express.json(), (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const suffix = (req.body as any)?.domain_suffix;
      if (typeof suffix !== "string" || suffix.length === 0) {
        res.status(400).json({ error: "Missing or invalid domain_suffix" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      caService.setDomainSuffix(veContextKey, suffix);
      res.status(200).json({ success: true, domain_suffix: suffix });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/ve/certificates/ca/download/:veContext - Download CA cert as PEM
  app.get(ApiUri.CertificateCaDownload, (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      if (!caService.hasCA(veContextKey)) {
        res.status(404).json({ error: "No CA configured" });
        return;
      }

      const ca = caService.getCA(veContextKey)!;
      const pemBytes = Buffer.from(ca.cert, "base64");

      res.setHeader("Content-Type", "application/x-pem-file");
      res.setHeader("Content-Disposition", "attachment; filename=\"ca.pem\"");
      res.status(200).send(pemBytes);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/ve/certificates/generate/:veContext - Generate cert for arbitrary hostname
  app.post(ApiUri.CertificateGenerate, express.json(), (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const body = req.body as IPostGenerateCertBody;
      if (!body.hostname || typeof body.hostname !== "string" || body.hostname.trim().length === 0) {
        res.status(400).json({ error: "Missing or invalid hostname" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      if (!caService.hasCA(veContextKey)) {
        res.status(400).json({ error: "No CA configured. Generate or import a CA first." });
        return;
      }

      const hostname = body.hostname.trim();
      const domainSuffix = caService.getDomainSuffix(veContextKey);
      const fqdn = `${hostname}${domainSuffix}`;

      const generated = caService.generateSelfSignedCert(veContextKey, hostname);
      const ca = caService.getCA(veContextKey)!;

      const fullchain = Buffer.from(
        Buffer.from(generated.cert, "base64").toString("utf-8") +
        Buffer.from(ca.cert, "base64").toString("utf-8"),
      ).toString("base64");

      const payload: IGenerateCertResponse = {
        hostname,
        fqdn,
        key: generated.key,
        fullchain,
      };
      res.status(200).json(payload);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/ve/certificates/pve/:veContext - Provision PVE host cert
  app.post(ApiUri.CertificatePveProvision, express.json(), async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }

      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      const caService = new CertificateAuthorityService(storageContext);
      if (!caService.hasCA(veContextKey)) {
        res.status(400).json({ error: "No CA configured. Generate or import a CA first." });
        return;
      }

      const ca = caService.getCA(veContextKey)!;
      const domainSuffix = caService.getDomainSuffix(veContextKey);
      const fqdn = `${veContext.host}${domainSuffix}`;

      const repositories = pm.getRepositories();
      const scriptContent = repositories.getScript({
        name: "host-provision-pve-certificate.sh",
        scope: "shared",
        category: "root",
      });
      const libraryContent = repositories.getScript({
        name: "cert-common.sh",
        scope: "shared",
        category: "library",
      });

      if (!scriptContent || !libraryContent) {
        res.status(500).json({ error: "PVE provisioning scripts not found" });
        return;
      }

      const cmd: ICommand = {
        name: "Provision PVE Certificate",
        execute_on: "ve",
        script: "host-provision-pve-certificate.sh",
        scriptContent,
        libraryContent,
        outputs: ["pve_cert_provisioned"],
      };

      const inputs = [
        { id: "ca_key_b64", value: ca.key },
        { id: "ca_cert_b64", value: ca.cert },
        { id: "fqdn", value: fqdn },
        { id: "hostname", value: veContext.host },
        { id: "domain_suffix", value: domainSuffix },
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

      res.status(200).json({ success: true });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/certificates - List all certificates across all VE contexts
  app.get(ApiUri.CertificatesAll, async (_req, res) => {
    try {
      const certificates = await autoRenewalService!.listAllCertificates();

      // Add CA certificate to the list if it exists
      const caService = new CertificateAuthorityService(storageContext);
      const caInfo = caService.getCaInfo("");
      if (caInfo.exists) {
        certificates.unshift({
          hostname: "CA",
          host: "",
          file: "",
          certtype: "ca",
          subject: caInfo.subject!,
          issuer: caInfo.subject!,
          expiry_date: caInfo.expiry_date!,
          days_remaining: caInfo.days_remaining!,
          status: caInfo.days_remaining! <= 0 ? "expired" : caInfo.days_remaining! <= 30 ? "warning" : "ok",
        });
      }

      res.status(200).json({ certificates });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/certificates/auto-renewal - Auto-renewal status (global)
  app.get(ApiUri.CertificateAutoRenewal, (_req, res) => {
    try {
      res.status(200).json(autoRenewalService!.getStatus());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/certificates/auto-renewal - Enable/disable auto-renewal (global)
  app.post(ApiUri.CertificateAutoRenewal, express.json(), (req, res) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "Missing or invalid 'enabled' (boolean)" });
        return;
      }

      autoRenewalService!.setEnabled(enabled);
      res.status(200).json(autoRenewalService!.getStatus());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/certificates/auto-renewal/check - Trigger manual check (global)
  app.post(ApiUri.CertificateAutoRenewalCheck, express.json(), async (_req, res) => {
    try {
      const result = await autoRenewalService!.checkAndRenew();
      res.status(200).json(result);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/certificates/renew-all - Force-renew self-signed leaf certificates.
  // Body: { hostnames?: string[] } — optional allow-list to scope the renewal
  // to specific hostnames (used by per-row renew actions in the UI). When
  // omitted/empty, every self-signed cert gets renewed.
  app.post(ApiUri.CertificateRenewAll, express.json(), async (req, res) => {
    try {
      const body = (req.body ?? {}) as { hostnames?: string[] };
      const filter = Array.isArray(body.hostnames) && body.hostnames.length > 0
        ? body.hostnames.map(String).filter((s) => s.length > 0)
        : undefined;
      const result = await autoRenewalService!.renewAllSelfSigned(filter);
      res.status(200).json(result);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}

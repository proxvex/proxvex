# Self-Signed Certificate Auto-Generation

## Context

Applications deployed via proxvex often need TLS certificates (MQTT brokers, web servers, etc.). Currently, certificates must be manually created and uploaded. Since the hostname is known during deployment and FQDN is simple (hostname + suffix), proxvex can auto-generate self-signed certificates.

**Goal:** Add `certtype` property to parameters and uploadfiles. When set, the system auto-generates certificates if the user doesn't upload their own. Provide Web UI for CA management and bulk certificate renewal.

**Decisions:**
- CA: Shared per PVE host, stored **encrypted** in `storagecontext.json`
- CA provisioning: Auto-generate OR upload via Certificate Management Dialog (Web UI)
- CA private key never stored unencrypted on disk
- FQDN suffix: `domain_suffix` parameter with default `.local`
- Scope: Both parameter definitions AND uploadfiles (FrameworkLoader)
- Validity check: Certs expiring within 30 days are regenerated
- Bulk renewal via Web UI from installed-list

---

## Step 1: Schema Changes

### 1a. `schemas/base-deployable.schema.json` (line 25, after `upload`)

```json
"certtype": {
  "type": "string",
  "enum": ["ca", "ca_pub", "server", "fullchain"],
  "description": "Certificate type. Enables auto-generation when upload has no value."
}
```

### 1b. `schemas/template.schema.json` (line 43, after `upload`)

Same `certtype` property in template parameter items.

### 1c. `schemas/appconf.schema.json` - uploadfiles items

Add `certtype` to uploadfiles item properties (same enum).

---

## Step 2: Type Changes

### `backend/src/types.mts`

```typescript
// New type (~line 117)
export type CertType = "ca" | "ca_pub" | "server" | "fullchain";

// Add to IParameter (after upload, line 129)
certtype?: CertType;

// Add to IUploadFile (after advanced, line 19)
certtype?: CertType;
```

New API types (append):
```typescript
export interface ICertificateStatus {
  hostname: string;
  file: string;
  certtype: string;
  subject: string;
  expiry_date: string;
  days_remaining: number;
  status: "ok" | "warning" | "expired";
}

export interface ICertificateStatusResponse {
  certificates: ICertificateStatus[];
  ca?: { subject: string; expiry_date: string; days_remaining: number; status: string };
}

export interface IPostCertRenewBody {
  hostnames: string[];
}

export interface IPostCertRenewResponse {
  success: boolean;
  renewed: number;
  errors?: string[];
}

export interface IPostCaImportBody {
  key: string;   // Base64 PEM
  cert: string;  // Base64 PEM
}

export interface ICaInfoResponse {
  exists: boolean;
  subject?: string;
  expiry_date?: string;
  days_remaining?: number;
}

// ApiUri additions:
CertificateStatus = "/api/ve/certificates/:veContext",
CertificateRenew = "/api/ve/certificates/renew/:veContext",
CertificateCa = "/api/ve/certificates/ca/:veContext",
CertificateCaGenerate = "/api/ve/certificates/ca/generate/:veContext",
CertificatePveStatus = "/api/ve/certificates/pve/:veContext",
CertificatePveProvision = "/api/ve/certificates/pve/:veContext",
```

---

## Step 3: CA Management in Backend

### 3a. NEW: `backend/src/services/certificate-authority-service.mts`

Manages CA lifecycle in encrypted storagecontext:

```typescript
export class CertificateAuthorityService {
  constructor(private contextManager: ContextManager) {}

  // Context key: "ca_<veContextKey>"
  // Value: { key: string (base64 PEM), cert: string (base64 PEM), created: string }

  getCA(veContextKey: string): { key: string; cert: string } | null
  hasCA(veContextKey: string): boolean
  setCA(veContextKey: string, key: string, cert: string): void
  getCaInfo(veContextKey: string): ICaInfoResponse  // no private key exposed

  // Generate new CA locally (openssl via child_process on backend, NOT on PVE host)
  generateCA(veContextKey: string): { key: string; cert: string }

  // Ensure CA exists: return existing or generate
  ensureCA(veContextKey: string): { key: string; cert: string }

  // Validate PEM format and extract info
  validateCaPem(key: string, cert: string): { valid: boolean; subject?: string; error?: string }
}
```

CA generation runs on the **backend** (not PVE host). Private key never touches PVE filesystem unencrypted. Uses `child_process.execSync("openssl ...")`.

CA stored encrypted in storagecontext.json under key `ca_<veContextKey>`. CA validity: 3650 days (~10 years), RSA 2048-bit.

**CA provisioning** (3 ways):
1. **Auto-generate**: If no CA in context, generate on first cert deployment
2. **Upload via Web UI**: Certificate Management Dialog (Step 8e) has "Import CA" section with file pickers for ca.key + ca.crt
3. **API**: `POST /api/ve/certificates/ca/:veContext` with base64 key+cert body

### 3b. NEW: `json/shared/scripts/library/cert-common.sh`

Shell library for cert operations on PVE host. CA key+cert arrive as base64 parameters (not from filesystem):

```
cert_generate_server(ca_key_b64, ca_cert_b64, fqdn, target_dir, san_list)
cert_generate_fullchain(ca_key_b64, ca_cert_b64, fqdn, target_dir)
cert_write_ca_pub(ca_cert_b64, target_dir)
cert_write_ca(ca_key_b64, ca_cert_b64, target_dir)
cert_check_validity(cert_path, min_days)  # 0 = valid, 1 = expiring/missing
cert_output_result(output_id, files_written)
```

- Script writes CA to temp dir, uses openssl to sign, cleans up CA key from temp
- Server SAN: `DNS:${fqdn}, DNS:${hostname}, DNS:localhost, IP:127.0.0.1`
- Server cert validity: 825 days
- `cert_check_validity` uses `openssl x509 -checkend $((min_days * 86400))`

---

## Step 4: New Shared Template + Script

### 4a. NEW: `json/shared/templates/pre_start/156-conf-generate-certificates.json`

```json
{
  "execute_on": "ve",
  "name": "Generate Certificates",
  "skip_if_all_missing": ["cert_requests"],
  "parameters": [
    { "id": "cert_requests", "name": "Cert Requests", "type": "string", "internal": true, "multiline": true },
    { "id": "ca_key_b64", "name": "CA Key", "type": "string", "internal": true, "secure": true },
    { "id": "ca_cert_b64", "name": "CA Cert", "type": "string", "internal": true },
    { "id": "shared_volpath", "name": "Shared Volume Path", "type": "string", "required": true },
    { "id": "hostname", "name": "Hostname", "type": "string", "required": true },
    { "id": "domain_suffix", "name": "Domain Suffix", "type": "string", "default": ".local", "advanced": true, "description": "FQDN = hostname + domain_suffix" },
    { "id": "uid", "name": "UID", "type": "string", "default": "0", "advanced": true },
    { "id": "gid", "name": "GID", "type": "string", "default": "0", "advanced": true },
    { "id": "mapped_uid", "name": "Mapped UID", "type": "string", "advanced": true },
    { "id": "mapped_gid", "name": "Mapped GID", "type": "string", "advanced": true }
  ],
  "commands": [{
    "name": "Generate Certificates",
    "script": "conf-generate-certificates.sh",
    "library": "cert-common.sh",
    "outputs": ["certs_generated"]
  }]
}
```

### 4b. NEW: `json/shared/scripts/pre_start/conf-generate-certificates.sh`

1. Parse `cert_requests` line by line (format: `paramId|certtype|volumeKey`)
2. Compute FQDN: `hostname + domain_suffix`
3. For each request:
   - Target dir: `${shared_volpath}/volumes/${hostname}/${volumeKey}/`
   - Check validity via `cert_check_validity` (skip if valid for >30 days)
   - Generate cert based on certtype
   - Set ownership (uid/gid)
4. Output `certs_generated` result

### Certtype → files

| certtype | Files in target dir |
|----------|---------------------|
| `ca` | `ca.key`, `ca.crt` |
| `ca_pub` | `ca.crt` |
| `server` | `server.key`, `server.crt` |
| `fullchain` | `server.key`, `fullchain.crt` (server + ca) |

---

## Step 5: Backend - cert_requests Assembly

### `backend/src/webapp/webapp-ve-route-handlers.mts` (~line 256)

After `processedParams`, inject cert parameters:

```typescript
const certParams = loaded.parameters.filter(p => p.certtype && p.upload);
if (certParams.length > 0) {
  const inputMap = new Map(processedParams.map(p => [p.id, p.value]));
  const certLines: string[] = [];

  for (const param of certParams) {
    const userValue = inputMap.get(param.id);
    const hasValue = userValue && userValue !== "" && String(userValue) !== "NOT_DEFINED";
    if (hasValue) continue; // User uploaded own cert

    const volumeKey = this.resolveVolumeKeyForCert(param, loaded);
    certLines.push(`${param.id}|${param.certtype}|${volumeKey}`);
  }

  if (certLines.length > 0) {
    const caService = new CertificateAuthorityService(storageContext);
    const ca = caService.ensureCA(veContextKey);
    processedParams.push({ id: "cert_requests", value: certLines.join("\n") });
    processedParams.push({ id: "ca_key_b64", value: ca.key });
    processedParams.push({ id: "ca_cert_b64", value: ca.cert });
  }
}
```

Helper `resolveVolumeKeyForCert()`: looks for `secret` or `certs` volume key in loaded parameters, defaults to `secret`.

---

## Step 6: FrameworkLoader certtype for uploadfiles

### `backend/src/frameworkloader.mts` (~line 461)

Pass `certtype` through to generated upload parameter:

```typescript
{
  id: contentParamId,
  upload: true,
  certtype: uploadFile.certtype,  // NEW
  // ... rest unchanged
}
```

---

## Step 7: Frontend Changes (minimal)

### `frontend/src/app/ve-configuration-dialog/parameter-group.component.html`

Hint for certtype parameters without uploaded file:

```html
@if (param.upload && param.certtype && !getParamValue(param.id)) {
  <span class="cert-auto-hint">Auto-generated if not uploaded</span>
}
```

---

## Step 8: Certificate Management Dialog & Bulk Renewal

### 8a. NEW: `json/shared/scripts/list/list-certificate-status.sh`

Runs on PVE host via SSH:
1. Scan `${shared_volpath}/volumes/*/` for `*.crt` files
2. For each: `openssl x509 -enddate -subject -noout`
3. Output JSON: `[{hostname, file, certtype, subject, expiry_date, days_remaining, status}]`

### 8b. NEW: `json/shared/scripts/pre_start/conf-renew-certificates.sh`

Runs on PVE host, force-renews:
1. Input: `cert_renew_requests` (multiline: `hostname|certtype|volumeKey`), `ca_key_b64`, `ca_cert_b64`
2. For each: regenerate using provided CA (ignores existing cert check)
3. Backend injects CA from encrypted storagecontext (same as Step 5)

### 8c. NEW: `backend/src/webapp/webapp-certificate-routes.mts`

Endpoints:
- `GET /api/ve/certificates/:veContext` - List certs + CA info
- `POST /api/ve/certificates/renew/:veContext` - Renew selected
- `GET /api/ve/certificates/ca/:veContext` - CA info (no private key)
- `POST /api/ve/certificates/ca/:veContext` - Import CA (upload key+cert)
- `POST /api/ve/certificates/ca/generate/:veContext` - Generate new CA
- `GET /api/ve/certificates/pve/:veContext` - PVE host cert status
- `POST /api/ve/certificates/pve/:veContext` - Provision PVE host cert

### 8d. Frontend Service Methods in `ve-configuration.service.ts`

```typescript
getCertificateStatus(): Observable<ICertificateStatusResponse>
postCertificateRenew(body: IPostCertRenewBody): Observable<IPostCertRenewResponse>
getCaInfo(): Observable<ICaInfoResponse>
postCaImport(body: IPostCaImportBody): Observable<ICaInfoResponse>
postCaGenerate(): Observable<ICaInfoResponse>
getPveStatus(): Observable<ICertificateStatus>
postPveProvision(): Observable<{ success: boolean }>
```

### 8e. NEW: `frontend/src/app/certificate-management/certificate-management-dialog.ts`

Opened from installed-list (new "Certificates" button).

**Section 1: CA Management**
- CA status: Subject, Expiry, Status chip (or "No CA configured")
- "Import CA" button: File pickers for ca.key + ca.crt → upload to backend
- "Generate CA" button: Generate self-signed CA on backend
- "Download CA cert" link: For distributing ca.crt to clients

**Section 2: PVE Host Certificate (optional)**
- Current PVE cert status (subject, expiry) read via SSH from `/etc/pve/local/pve-ssl.pem`
- "Provision PVE Certificate" button: Generates server cert for PVE host FQDN, deploys via SSH:
  - Write cert → `/etc/pve/local/pve-ssl.pem`
  - Write key → `/etc/pve/local/pve-ssl.key`
  - Write CA cert → `/etc/pve/pve-root-ca.pem`
  - `systemctl restart pveproxy`
- PVE host FQDN derived from VE context hostname + `domain_suffix`
- Confirmation dialog before overwriting (warns about pveproxy restart)

### 8f. NEW: `json/shared/scripts/host-provision-pve-certificate.sh`

Runs on PVE host via SSH. Receives `ca_key_b64`, `ca_cert_b64`, `fqdn`, `domain_suffix` as parameters.
1. Generate server cert for PVE FQDN using CA (via `cert-common.sh` library)
2. Backup existing certs: `cp /etc/pve/local/pve-ssl.pem /etc/pve/local/pve-ssl.pem.bak`
3. Write new cert + key to `/etc/pve/local/`
4. Write CA cert to `/etc/pve/pve-root-ca.pem`
5. `systemctl restart pveproxy`
6. Output JSON result

**Section 3: Certificate Status & Renewal**
- Table: Hostname, Type, Subject, Expiry, Status, Checkbox
- Status chips: green "OK", yellow "Warning" (<=30d), red "Expired"
- "Renew Selected" button
- "Renew All Expiring" quick action

---

## Step 9: Tests

### 9a. Template Validation Test

Existing test at `backend/tests/validation/validate-all-json.test.mts` will automatically validate the new template `156-conf-generate-certificates.json` against `template.schema.json`. No changes needed.

### 9b. Schema Validation Test

Existing test validates all application JSON against schemas. After adding `certtype` to schemas, create a test fixture application that uses `certtype` to verify schema validation accepts it.

**NEW fixture:** `backend/tests/fixtures/applications/test-certtype/application.json`

```json
{
  "name": "Test Certtype",
  "installation": { "pre_start": [] },
  "parameters": [
    { "id": "server_cert", "name": "Server Cert", "type": "string", "upload": true, "certtype": "server" },
    { "id": "ca_cert", "name": "CA Cert", "type": "string", "upload": true, "certtype": "ca_pub" }
  ]
}
```

### 9c. NEW: `backend/tests/services/certificate-authority-service.test.mts`

Unit tests for CertificateAuthorityService:

```
describe("CertificateAuthorityService")
  describe("generateCA()")
    - should generate valid CA key and cert
    - should store CA encrypted in context
    - CA cert should have correct validity (3650 days)
    - CA cert should be self-signed

  describe("ensureCA()")
    - should generate CA if not exists
    - should return existing CA if already exists
    - should return same CA on repeated calls

  describe("setCA() / getCA()")
    - should store and retrieve CA
    - should return null for non-existent VE key

  describe("validateCaPem()")
    - should accept valid PEM key+cert
    - should reject invalid PEM format
    - should reject mismatched key+cert pair

  describe("getCaInfo()")
    - should return exists=false when no CA
    - should return subject and expiry when CA exists
    - should NOT expose private key
```

Pattern: Use `createTestEnvironment()` + `initPersistence()` from test helpers.

### 9d. NEW: `backend/tests/webapp/webapp-certificate-routes.test.mts`

API endpoint tests using `supertest` + `createWebAppTestSetup()`:

```
describe("Certificate API routes")
  describe("GET /api/ve/certificates/ca/:veContext")
    - should return exists=false when no CA configured
    - should return CA info after generation

  describe("POST /api/ve/certificates/ca/:veContext")
    - should import valid CA key+cert
    - should reject invalid PEM format
    - should reject mismatched key+cert

  describe("POST /api/ve/certificates/ca/generate/:veContext")
    - should generate and store new CA
    - should overwrite existing CA

  describe("POST /api/ve/certificates/renew/:veContext")
    - should return error when no CA exists
```

### 9e. NEW: `backend/tests/framework/frameworkloader.certtype.test.mts`

Tests that certtype propagates through FrameworkLoader:

```
describe("FrameworkLoader certtype")
  - should pass certtype to generated upload template parameter
  - should generate upload template without certtype when not set
  - certtype parameter should be visible in unresolved parameters
```

Pattern: Follow `frameworkloader.uploadfiles.test.mts`.

### 9f. NEW: `backend/tests/templateprocessor/templateprocessor.certtype.test.mts`

Tests that template 156 is correctly loaded and conditional:

```
describe("Certificate template (156)")
  - should be skipped when cert_requests is missing
  - should be included when cert_requests is provided
  - should resolve all cert parameters correctly
```

Pattern: Use fixture application with certtype parameters, load via TemplateProcessor.

---

## File Summary

| Action | File | Step |
|--------|------|------|
| MODIFY | `schemas/base-deployable.schema.json` | 1a |
| MODIFY | `schemas/template.schema.json` | 1b |
| MODIFY | `schemas/appconf.schema.json` | 1c |
| MODIFY | `backend/src/types.mts` | 2 |
| CREATE | `backend/src/services/certificate-authority-service.mts` | 3a |
| CREATE | `json/shared/scripts/library/cert-common.sh` | 3b |
| CREATE | `json/shared/templates/pre_start/156-conf-generate-certificates.json` | 4a |
| CREATE | `json/shared/scripts/pre_start/conf-generate-certificates.sh` | 4b |
| MODIFY | `backend/src/webapp/webapp-ve-route-handlers.mts` | 5 |
| MODIFY | `backend/src/frameworkloader.mts` | 6 |
| MODIFY | `frontend/src/app/ve-configuration-dialog/parameter-group.component.html` | 7 |
| CREATE | `json/shared/scripts/list/list-certificate-status.sh` | 8a |
| CREATE | `json/shared/scripts/pre_start/conf-renew-certificates.sh` | 8b |
| CREATE | `backend/src/webapp/webapp-certificate-routes.mts` | 8c |
| MODIFY | `frontend/src/app/ve-configuration.service.ts` | 8d |
| CREATE | `frontend/src/app/certificate-management/certificate-management-dialog.ts` | 8e |
| MODIFY | `frontend/src/app/installed-list/installed-list.ts` | 8e |
| CREATE | `json/shared/scripts/host-provision-pve-certificate.sh` | 8f |
| CREATE | `backend/tests/fixtures/applications/test-certtype/application.json` | 9b |
| CREATE | `backend/tests/services/certificate-authority-service.test.mts` | 9c |
| CREATE | `backend/tests/webapp/webapp-certificate-routes.test.mts` | 9d |
| CREATE | `backend/tests/framework/frameworkloader.certtype.test.mts` | 9e |
| CREATE | `backend/tests/templateprocessor/templateprocessor.certtype.test.mts` | 9f |

---

## Verification

1. **Build**: `cd backend && pnpm run lint:fix && pnpm run build && pnpm test` then `cd frontend && pnpm run lint:fix && pnpm run build && pnpm test`
2. **Template tests**: `cd backend && pnpm test:templates` (validates new template 156)
3. **Auto-generation**: Deploy app with certtype params (no upload), verify certs generated
4. **Upload override**: Upload own cert, verify auto-generation skipped
5. **Validity check**: Cert expiring <30 days → regenerated on redeploy
6. **CA management UI**: Import/Generate CA in dialog, verify encrypted storage
7. **Bulk renewal**: Select certs, renew, verify new expiry
8. **PVE provisioning**: Provision PVE host cert, verify pveproxy restart
9. **Live test**: `./backend/tests/livetests/run-live-test.sh pve1.cluster`

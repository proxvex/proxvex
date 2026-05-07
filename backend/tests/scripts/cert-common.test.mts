import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// json/shared/scripts/library/cert-common.sh
const LIB_PATH = path.resolve(
  __dirname,
  "../../../json/shared/scripts/library/cert-common.sh",
);

/**
 * Source the cert-common library in /bin/sh, call the named function with the
 * given args, and return stdout / stderr / exit code. The library is the
 * production file under json/shared/scripts/library/, so any change there is
 * exercised by these tests directly without copying or stubbing.
 */
function callLibFn(
  fnName: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const script = `. '${LIB_PATH}' && ${fnName} ${quoted}`;
  const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf-8" });
  return {
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    exitCode: result.status ?? -1,
  };
}

/** Generate a self-signed CA (key + cert PEM). Returns paths to both. */
function makeCa(opts: {
  dir: string;
  cn?: string;
  filename?: string;
}): { keyPath: string; certPath: string } {
  const { dir, cn = "Proxvex CA Test", filename = "ca" } = opts;
  const keyPath = path.join(dir, `${filename}.key`);
  const certPath = path.join(dir, `${filename}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "3650",
      "-subj", `/CN=${cn}/O=proxvex`,
    ],
    { stdio: "pipe" },
  );
  return { keyPath, certPath };
}

/**
 * Generate a server certificate. Self-signed by default; pass `ca` to sign
 * with a specific CA (the production code path). Returns the path to the
 * resulting cert.pem.
 */
function makeCert(opts: {
  dir: string;
  cn: string;
  sans?: string[];
  days?: number;
  filename?: string;
  ca?: { keyPath: string; certPath: string };
}): string {
  const { dir, cn, sans = [], days = 365, filename = "cert.pem", ca } = opts;
  const keyPath = path.join(dir, `${filename}.key`);
  const csrPath = path.join(dir, `${filename}.csr`);
  const extPath = path.join(dir, `${filename}.ext`);
  const certPath = path.join(dir, filename);

  const dnsLines: string[] = [];
  const ipLines: string[] = [];
  for (const s of sans) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) ipLines.push(s);
    else dnsLines.push(s);
  }
  const altNames = [
    ...dnsLines.map((d, i) => `DNS.${i + 1} = ${d}`),
    ...ipLines.map((ip, i) => `IP.${i + 1} = ${ip}`),
  ].join("\n");
  writeFileSync(
    extPath,
    [
      "[v3_req]",
      "subjectAltName = @alt_names",
      "basicConstraints = CA:FALSE",
      "[alt_names]",
      altNames || "DNS.1 = " + cn,
    ].join("\n"),
  );

  execFileSync(
    "openssl",
    [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", csrPath,
      "-subj", `/CN=${cn}/O=proxvex`,
    ],
    { stdio: "pipe" },
  );

  if (ca) {
    execFileSync(
      "openssl",
      [
        "x509", "-req", "-in", csrPath,
        "-CA", ca.certPath, "-CAkey", ca.keyPath,
        "-CAcreateserial",
        "-out", certPath,
        "-days", String(days),
        "-extensions", "v3_req",
        "-extfile", extPath,
      ],
      { stdio: "pipe" },
    );
  } else {
    execFileSync(
      "openssl",
      [
        "x509", "-req", "-in", csrPath,
        "-signkey", keyPath,
        "-out", certPath,
        "-days", String(days),
        "-extensions", "v3_req",
        "-extfile", extPath,
      ],
      { stdio: "pipe" },
    );
  }
  return certPath;
}

describe("cert-common.sh: cert_identity_of()", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cert-common-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns CN+sorted SANs for a valid cert", () => {
    const cert = makeCert({
      dir,
      cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
    });
    const { stdout, exitCode } = callLibFn("cert_identity_of", [cert]);
    expect(exitCode).toBe(0);
    const line = stdout.trim();
    expect(line).toMatch(/^CN=zitadel\.ohnewarum\.de\|/);
    // SANs are sorted alphabetically (DNS:* and IP:*)
    expect(line).toContain("DNS:localhost");
    expect(line).toContain("DNS:zitadel");
    expect(line).toContain("DNS:zitadel.ohnewarum.de");
    expect(line).toContain("IP:127.0.0.1");
  });

  it("produces identical output for two certs with same identity (different serials)", () => {
    const certA = makeCert({
      dir, cn: "node-red.ohnewarum.de",
      sans: ["node-red.ohnewarum.de", "node-red", "localhost", "127.0.0.1"],
      filename: "a.pem",
    });
    const certB = makeCert({
      dir, cn: "node-red.ohnewarum.de",
      sans: ["node-red.ohnewarum.de", "node-red", "localhost", "127.0.0.1"],
      filename: "b.pem",
    });
    const a = callLibFn("cert_identity_of", [certA]).stdout.trim();
    const b = callLibFn("cert_identity_of", [certB]).stdout.trim();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("differs when CN differs", () => {
    const certA = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["localhost"], filename: "a.pem",
    });
    const certB = makeCert({
      dir, cn: "localhost.ohnewarum.de",
      sans: ["localhost"], filename: "b.pem",
    });
    const a = callLibFn("cert_identity_of", [certA]).stdout.trim();
    const b = callLibFn("cert_identity_of", [certB]).stdout.trim();
    expect(a).not.toBe(b);
  });

  it("differs when SAN list differs", () => {
    const certA = makeCert({
      dir, cn: "app.example.com",
      sans: ["app.example.com", "localhost"], filename: "a.pem",
    });
    const certB = makeCert({
      dir, cn: "app.example.com",
      sans: ["app.example.com", "localhost", "127.0.0.1"], filename: "b.pem",
    });
    const a = callLibFn("cert_identity_of", [certA]).stdout.trim();
    const b = callLibFn("cert_identity_of", [certB]).stdout.trim();
    expect(a).not.toBe(b);
  });

  it("is order-independent for SANs (sorted output)", () => {
    const certA = makeCert({
      dir, cn: "app.example.com",
      sans: ["a.example.com", "b.example.com", "c.example.com"], filename: "a.pem",
    });
    const certB = makeCert({
      dir, cn: "app.example.com",
      sans: ["c.example.com", "a.example.com", "b.example.com"], filename: "b.pem",
    });
    const a = callLibFn("cert_identity_of", [certA]).stdout.trim();
    const b = callLibFn("cert_identity_of", [certB]).stdout.trim();
    expect(a).toBe(b);
  });

  it("returns non-zero exit code for missing cert", () => {
    const { exitCode } = callLibFn("cert_identity_of", [
      path.join(dir, "does-not-exist.pem"),
    ]);
    expect(exitCode).not.toBe(0);
  });
});

describe("cert-common.sh: cert_should_skip_write()", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cert-common-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 (skip) when identity matches and validity is sufficient", () => {
    const existing = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      days: 365, filename: "existing.pem",
    });
    const candidate = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      days: 365, filename: "candidate.pem",
    });
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30",
    ]);
    expect(exitCode).toBe(0);
  });

  it("returns 1 (write) when CN differs (e.g. localhost-bug fix)", () => {
    const existing = makeCert({
      dir, cn: "localhost.ohnewarum.de",
      sans: ["localhost.ohnewarum.de", "localhost", "127.0.0.1"],
      filename: "existing.pem",
    });
    const candidate = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      filename: "candidate.pem",
    });
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30",
    ]);
    expect(exitCode).toBe(1);
  });

  it("returns 1 (write) when SAN list differs (extraSans added)", () => {
    const existing = makeCert({
      dir, cn: "registry.host",
      sans: ["registry.host", "localhost", "127.0.0.1"],
      filename: "existing.pem",
    });
    const candidate = makeCert({
      dir, cn: "registry.host",
      sans: ["registry.host", "registry-1.docker.io", "localhost", "127.0.0.1"],
      filename: "candidate.pem",
    });
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30",
    ]);
    expect(exitCode).toBe(1);
  });

  it("returns 1 (write) when existing cert is missing", () => {
    const candidate = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "localhost"],
      filename: "candidate.pem",
    });
    const missing = path.join(dir, "no-such-cert.pem");
    expect(existsSync(missing)).toBe(false);
    const { exitCode } = callLibFn("cert_should_skip_write", [
      missing, candidate, "30",
    ]);
    expect(exitCode).toBe(1);
  });

  it("returns 1 (write) when existing cert expires within min_days", () => {
    // Cert valid for 5 days, threshold 30 → must rotate
    const existing = makeCert({
      dir, cn: "stable.host",
      sans: ["stable.host", "localhost"],
      days: 5, filename: "existing.pem",
    });
    const candidate = makeCert({
      dir, cn: "stable.host",
      sans: ["stable.host", "localhost"],
      days: 365, filename: "candidate.pem",
    });
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30",
    ]);
    expect(exitCode).toBe(1);
  });

  it("uses default min_days=30 when not specified", () => {
    const existing = makeCert({
      dir, cn: "stable.host",
      sans: ["stable.host", "localhost"],
      days: 5, filename: "existing.pem",
    });
    const candidate = makeCert({
      dir, cn: "stable.host",
      sans: ["stable.host", "localhost"],
      days: 365, filename: "candidate.pem",
    });
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate,
    ]);
    expect(exitCode).toBe(1);
  });
});

describe("cert-common.sh: cert_should_skip_write() with CA verification", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cert-common-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 (skip) when identity matches AND existing verifies against current CA", () => {
    const ca = makeCa({ dir, filename: "ca" });
    const existing = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      filename: "existing.pem", ca,
    });
    const candidate = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      filename: "candidate.pem", ca,
    });
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30", ca.certPath,
    ]);
    expect(exitCode).toBe(0);
  });

  it("returns 1 (write) when CA has rotated even though identity matches", () => {
    const oldCa = makeCa({ dir, filename: "old-ca", cn: "Proxvex CA Old" });
    const newCa = makeCa({ dir, filename: "new-ca", cn: "Proxvex CA New" });

    const existing = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      filename: "existing.pem", ca: oldCa,
    });
    const candidate = makeCert({
      dir, cn: "zitadel.ohnewarum.de",
      sans: ["zitadel.ohnewarum.de", "zitadel", "localhost", "127.0.0.1"],
      filename: "candidate.pem", ca: newCa,
    });

    // Pass the CURRENT (new) CA — existing was signed by the old one
    // and must therefore not verify, forcing a rewrite.
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30", newCa.certPath,
    ]);
    expect(exitCode).toBe(1);
  });

  it("returns 1 (write) when CA was regenerated with same DN but different key", () => {
    // Same DN ("Proxvex CA Test") but two independent key pairs — like a
    // CA reset that keeps the visual identity but breaks signature trust.
    const ca1 = makeCa({ dir, filename: "ca1", cn: "Proxvex CA Test" });
    const ca2 = makeCa({ dir, filename: "ca2", cn: "Proxvex CA Test" });

    const existing = makeCert({
      dir, cn: "host.example",
      sans: ["host.example", "localhost"],
      filename: "existing.pem", ca: ca1,
    });
    const candidate = makeCert({
      dir, cn: "host.example",
      sans: ["host.example", "localhost"],
      filename: "candidate.pem", ca: ca2,
    });

    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30", ca2.certPath,
    ]);
    expect(exitCode).toBe(1);
  });

  it("skips CA verification when ca_cert path is empty (backward compat)", () => {
    const ca1 = makeCa({ dir, filename: "ca1" });
    const ca2 = makeCa({ dir, filename: "ca2" });
    const existing = makeCert({
      dir, cn: "host.example",
      sans: ["host.example", "localhost"],
      filename: "existing.pem", ca: ca1,
    });
    const candidate = makeCert({
      dir, cn: "host.example",
      sans: ["host.example", "localhost"],
      filename: "candidate.pem", ca: ca2,
    });
    // Empty 4th arg → no CA verify; identity still matches → skip
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30", "",
    ]);
    expect(exitCode).toBe(0);
  });

  it("skips CA verification when ca_cert path does not exist (silent skip)", () => {
    const ca1 = makeCa({ dir, filename: "ca1" });
    const existing = makeCert({
      dir, cn: "host.example",
      sans: ["host.example", "localhost"],
      filename: "existing.pem", ca: ca1,
    });
    const candidate = makeCert({
      dir, cn: "host.example",
      sans: ["host.example", "localhost"],
      filename: "candidate.pem", ca: ca1,
    });
    const missingCa = path.join(dir, "no-ca-here.crt");
    const { exitCode } = callLibFn("cert_should_skip_write", [
      existing, candidate, "30", missingCa,
    ]);
    // Note: contract is "verify only when path exists" — non-existent path
    // is treated as "not provided" so other checks decide. Identity match +
    // valid → skip.
    expect(exitCode).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { filterRenewableCerts, CA_ISSUER_MARKER } from "@src/services/certificate-auto-renewal-service.mjs";
import type { ICertificateStatus } from "@src/types.mjs";

function cert(overrides: Partial<ICertificateStatus>): ICertificateStatus {
  return {
    hostname: "test",
    file: "certs/cert.pem",
    certtype: "server",
    subject: "CN=test.local",
    issuer: `CN=${CA_ISSUER_MARKER}/O=proxvex`,
    expiry_date: "2026-06-01",
    days_remaining: 200,
    status: "ok",
    ...overrides,
  };
}

describe("filterRenewableCerts", () => {
  it("should return self-signed server certs needing renewal", () => {
    const certs: ICertificateStatus[] = [
      cert({ hostname: "postgres", status: "warning", days_remaining: 25 }),
      cert({ hostname: "mqtt", status: "expired", days_remaining: -5 }),
      cert({ hostname: "zitadel", status: "ok", days_remaining: 400 }),
    ];

    const { selfSigned, toRenew } = filterRenewableCerts(certs);

    expect(selfSigned).toHaveLength(3);
    expect(toRenew).toHaveLength(2);
    expect(toRenew.map((c) => c.hostname)).toEqual(["postgres", "mqtt"]);
  });

  it("should skip ACME certificates (different issuer)", () => {
    const certs: ICertificateStatus[] = [
      cert({ hostname: "nginx", status: "warning", issuer: "CN=R10, O=Let's Encrypt" }),
      cert({ hostname: "gitea", status: "expired", issuer: "CN=R3, O=Let's Encrypt" }),
      cert({ hostname: "postgres", status: "warning" }),
    ];

    const { selfSigned, toRenew } = filterRenewableCerts(certs);

    expect(selfSigned).toHaveLength(1);
    expect(toRenew).toHaveLength(1);
    expect(toRenew[0].hostname).toBe("postgres");
  });

  it("should skip non-server certtypes", () => {
    const certs: ICertificateStatus[] = [
      cert({ hostname: "postgres", certtype: "ca_pub", status: "warning" }),
      cert({ hostname: "postgres", certtype: "fullchain", status: "warning" }),
      cert({ hostname: "postgres", certtype: "key", status: "warning" }),
      cert({ hostname: "postgres", certtype: "server", status: "warning" }),
    ];

    const { selfSigned, toRenew } = filterRenewableCerts(certs);

    expect(selfSigned).toHaveLength(1);
    expect(toRenew).toHaveLength(1);
  });

  it("should return empty arrays when no certificates match", () => {
    const certs: ICertificateStatus[] = [
      cert({ hostname: "nginx", certtype: "server", status: "ok", issuer: "CN=R10" }),
      cert({ hostname: "postgres", certtype: "ca_pub", status: "expired" }),
    ];

    const { selfSigned, toRenew } = filterRenewableCerts(certs);

    expect(selfSigned).toHaveLength(0);
    expect(toRenew).toHaveLength(0);
  });

  it("should handle empty input", () => {
    const { selfSigned, toRenew } = filterRenewableCerts([]);

    expect(selfSigned).toHaveLength(0);
    expect(toRenew).toHaveLength(0);
  });

  it("should handle missing issuer field gracefully", () => {
    const certs: ICertificateStatus[] = [
      cert({ hostname: "old-cert", status: "warning", issuer: "" }),
      cert({ hostname: "postgres", status: "warning" }),
    ];

    const { selfSigned, toRenew } = filterRenewableCerts(certs);

    expect(selfSigned).toHaveLength(1);
    expect(toRenew[0].hostname).toBe("postgres");
  });
});

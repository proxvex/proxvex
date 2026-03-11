import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CliApiClient } from "../src/cli-api-client.mjs";
import {
  ConnectionError,
  AuthenticationError,
  NotFoundError,
  ApiError,
} from "../src/cli-types.mjs";

describe("CliApiClient", () => {
  const originalFetch = globalThis.fetch;

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
  }

  describe("constructor", () => {
    it("should strip trailing slashes from baseUrl", async () => {
      const client = new CliApiClient("http://localhost:3080///");
      mockFetch.mockResolvedValueOnce(jsonResponse({ sshs: [] }));
      await client.getSshConfigs();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3080/api/sshconfigs",
        expect.any(Object),
      );
    });
  });

  describe("authorization header", () => {
    it("should not send auth header when no token", async () => {
      const client = new CliApiClient("http://localhost:3080");
      mockFetch.mockResolvedValueOnce(jsonResponse({ sshs: [] }));
      await client.getSshConfigs();
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("should send Bearer token when provided", async () => {
      const client = new CliApiClient(
        "http://localhost:3080",
        "my-secret-token",
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ sshs: [] }));
      await client.getSshConfigs();
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBe("Bearer my-secret-token");
    });
  });

  describe("error handling", () => {
    let client: CliApiClient;

    beforeEach(() => {
      client = new CliApiClient("http://localhost:3080");
    });

    it("should throw ConnectionError when fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(client.getSshConfigs()).rejects.toThrow(ConnectionError);
    });

    it("should throw AuthenticationError on 401", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      await expect(client.getSshConfigs()).rejects.toThrow(
        AuthenticationError,
      );
    });

    it("should throw AuthenticationError on 403", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403));
      await expect(client.getSshConfigs()).rejects.toThrow(
        AuthenticationError,
      );
    });

    it("should throw NotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
      await expect(client.getSshConfigs()).rejects.toThrow(NotFoundError);
    });

    it("should throw ApiError on 500", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "internal error" }, 500),
      );
      await expect(client.getSshConfigs()).rejects.toThrow(ApiError);
    });
  });

  describe("API methods", () => {
    let client: CliApiClient;

    beforeEach(() => {
      client = new CliApiClient("http://localhost:3080", "tok");
    });

    it("getSshConfigKey should call correct URL", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ key: "ve_pve1" }),
      );
      const result = await client.getSshConfigKey("pve1.cluster");
      expect(result.key).toBe("ve_pve1");
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/api/ssh/config/pve1.cluster",
      );
    });

    it("getUnresolvedParameters should call correct URL", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ unresolvedParameters: [] }),
      );
      await client.getUnresolvedParameters("ve_pve1", "zitadel", "installation");
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/api/ve_pve1/unresolved-parameters/zitadel?task=installation",
      );
    });

    it("postEnumValues should send POST with body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ enumValues: [] }),
      );
      await client.postEnumValues("ve_pve1", "zitadel", "installation");
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/ve_pve1/enum-values/zitadel");
      expect(url).not.toContain("installation");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(options.body);
      expect(body.task).toBe("installation");
    });

    it("getStacks should include stacktype query", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ stacks: [] }),
      );
      await client.getStacks("postgres");
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/api/stacks?stacktype=postgres",
      );
    });

    it("getStacks without stacktype should not have query", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ stacks: [] }),
      );
      await client.getStacks();
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:3080/api/stacks",
      );
    });

    it("postVeConfiguration should POST to correct URL", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true }),
      );
      await client.postVeConfiguration("ve_pve1", "zitadel", "installation", {
        params: [{ name: "hostname", value: "test" }],
      });
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/ve_pve1/ve-configuration/zitadel");
      expect(url).not.toContain("installation");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body);
      expect(body.task).toBe("installation");
    });
  });
});

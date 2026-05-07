import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebAppVeRouteHandlers } from "@src/webapp/webapp-ve-route-handlers.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import * as containerListService from "@src/services/container-list-service.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mts";

vi.mock("@src/services/container-list-service.mjs", () => ({
  listManagedContainers: vi.fn(),
}));

const mockListManagedContainers = vi.mocked(
  containerListService.listManagedContainers,
);

/**
 * Direct unit tests for the private hostname resolver. Tested through a thin
 * `as any` cast rather than standing up the full handler stack — the method
 * is intentionally side-effect-light (mutates the passed-in array, logs, and
 * delegates to listManagedContainers) and that contract is what we want to
 * pin down so the cert-injection consumer can rely on it.
 */
describe("WebAppVeRouteHandlers.resolveHostnameFromPreviousVmId", () => {
  let env: TestEnvironment;
  let handler: WebAppVeRouteHandlers;
  const mockVeContext: IVEContext = { host: "pve1.cluster", port: 22 } as IVEContext;

  beforeEach(() => {
    vi.resetAllMocks();
    env = createTestEnvironment(import.meta.url, { jsonIncludePatterns: [] });
    env.initPersistence({ enableCache: false });
    // Construct with no-op stubs — the method only uses `this.pm` (forwarded
    // to listManagedContainers, which we mock) and `this.logger`.
    handler = new WebAppVeRouteHandlers(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterEach(() => {
    env.cleanup();
  });

  function callResolver(
    params: Array<{ id: string; value: string | number | boolean }>,
  ): Promise<void> {
    return (handler as unknown as {
      resolveHostnameFromPreviousVmId: (
        p: typeof params,
        v: IVEContext,
      ) => Promise<void>;
    }).resolveHostnameFromPreviousVmId(params, mockVeContext);
  }

  it("does nothing when hostname is already in processedParams", async () => {
    const params = [
      { id: "hostname", value: "explicit-host" },
      { id: "previous_vm_id", value: 510 },
    ];
    await callResolver(params);
    expect(mockListManagedContainers).not.toHaveBeenCalled();
    expect(params).toEqual([
      { id: "hostname", value: "explicit-host" },
      { id: "previous_vm_id", value: 510 },
    ]);
  });

  it("does nothing when neither hostname nor previous_vm_id is present (fresh install)", async () => {
    const params = [{ id: "static_ip", value: "192.168.4.42/24" }];
    await callResolver(params);
    expect(mockListManagedContainers).not.toHaveBeenCalled();
    expect(params).toHaveLength(1);
  });

  it("does nothing when previous_vm_id is empty / NOT_DEFINED", async () => {
    const params = [{ id: "previous_vm_id", value: "" }];
    await callResolver(params);
    expect(mockListManagedContainers).not.toHaveBeenCalled();
    expect(params.find((p) => p.id === "hostname")).toBeUndefined();
  });

  it("resolves hostname from the matching managed container", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 509, hostname: "proxvex" },
      { vm_id: 510, hostname: "zitadel" },
      { vm_id: 506, hostname: "nginx" },
    ] as never);

    const params = [{ id: "previous_vm_id", value: 510 }];
    await callResolver(params);

    expect(mockListManagedContainers).toHaveBeenCalledTimes(1);
    expect(params).toContainEqual({ id: "hostname", value: "zitadel" });
  });

  it("matches previous_vm_id loosely (string vs number)", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 510, hostname: "zitadel" },
    ] as never);

    const params = [{ id: "previous_vm_id", value: "510" }];
    await callResolver(params);

    expect(params).toContainEqual({ id: "hostname", value: "zitadel" });
  });

  it("does not inject hostname when no container matches previous_vm_id", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 1, hostname: "other" },
    ] as never);

    const params = [{ id: "previous_vm_id", value: 510 }];
    await callResolver(params);

    expect(params.find((p) => p.id === "hostname")).toBeUndefined();
  });

  it("does not inject when matched container has no hostname", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 510, hostname: undefined },
    ] as never);

    const params = [{ id: "previous_vm_id", value: 510 }];
    await callResolver(params);

    expect(params.find((p) => p.id === "hostname")).toBeUndefined();
  });

  it("swallows listManagedContainers errors and leaves params untouched", async () => {
    mockListManagedContainers.mockRejectedValueOnce(
      new Error("ssh: connection refused"),
    );

    const params = [{ id: "previous_vm_id", value: 510 }];
    await expect(callResolver(params)).resolves.toBeUndefined();

    expect(params.find((p) => p.id === "hostname")).toBeUndefined();
  });

  it("does not overwrite an explicitly empty hostname with the resolved one", async () => {
    // An empty-string hostname means "user actively cleared the field". Treat
    // it as missing so the resolver fills it in. Documents the contract.
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 510, hostname: "zitadel" },
    ] as never);

    const params = [
      { id: "hostname", value: "" },
      { id: "previous_vm_id", value: 510 },
    ];
    await callResolver(params);

    expect(params).toContainEqual({ id: "hostname", value: "zitadel" });
  });
});

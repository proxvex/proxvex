import {
  TaskType,
  IPostVeConfigurationBody,
  IVeExecuteMessagesResponse,
  IJsonError,
  IParameter,
} from "@src/types.mjs";
import { resolveDeployerBaseUrl } from "./deployer-url-resolver.mjs";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import type { WebAppDebugCollector, DebugLevel } from "./webapp-debug-collector.mjs";
import type { AppLogMonitor } from "../ve-execution/app-log-monitor.mjs";
import { WebAppVeAddonCommandBuilder } from "./webapp-ve-addon-command-builder.mjs";
import { parseVersionsLib, getOciImageTag } from "@src/versions-parser.mjs";
import { WebAppVeCertificateInjector } from "./webapp-ve-certificate-injector.mjs";
import {
  IVEContext,
  IVMInstallContext,
} from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { getErrorStatusCode, serializeError } from "./webapp-error-utils.mjs";
import { VMInstallContext, type ContextManager } from "@src/context-manager.mjs";
import { createLogger } from "@src/logger/index.mjs";
import type { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import {
  determineExecutionMode,
  ExecutionMode,
  getNextMessageIndex,
} from "@src/ve-execution/ve-execution-constants.mjs";
import { listManagedContainers } from "@src/services/container-list-service.mjs";
import { getContainerConfig } from "@src/services/container-config-service.mjs";

/**
 * Route handler logic for VE configuration endpoints.
 * Separated from Express binding for better testability.
 */
export class WebAppVeRouteHandlers {
  // pm is exposed as a getter, NOT a captured field, so each access reads the
  // current PersistenceManager singleton. PersistenceManager.reload() (POST
  // /api/reload) constructs a new instance and swaps the singleton slot;
  // capturing the reference once at construction time would leave handlers
  // permanently bound to the pre-reload caches, making script edits invisible
  // until a full deployer restart.
  private get pm(): PersistenceManager {
    return PersistenceManager.getInstance();
  }
  private addonCommandBuilder: WebAppVeAddonCommandBuilder;
  private certificateInjector: WebAppVeCertificateInjector;
  private logger = createLogger("ve-route-handlers");

  /**
   * In-flight task guard keyed by `${veContextKey}::${hostname}`. A
   * configuration task (install/upgrade/reconfigure) mutates the identity of a
   * single hostname — its static IP, mountpoints, OIDC client, certificates.
   * Two tasks touching the same hostname concurrently race: the incident that
   * motivated this guard was two proxvex self-upgrades dispatched ~50s apart,
   * both for hostname "proxvex", each cloning the deployer — the two clones
   * then fought over the same static IP and the deployer came up only
   * intermittently. While one task holds the lock, a second task for the same
   * (veContext, hostname) is rejected with 409 instead of interleaving.
   *
   * In-memory only and intentionally so: a deployer restart clears it, which is
   * correct because no task survives a restart. Release happens when the task
   * settles — the self-upgrade orchestration returns (method-level finally), or
   * the background VeExecution promise settles (onSettled, regular path).
   */
  private readonly activeHostnameTasks = new Map<
    string,
    { application: string; task: string; startedAt: number }
  >();

  constructor(
    private messageManager: WebAppVeMessageManager,
    private restartManager: WebAppVeRestartManager,
    private parameterProcessor: WebAppVeParameterProcessor,
    private executionSetup: WebAppVeExecutionSetup,
    private debugCollector?: WebAppDebugCollector,
    private appLogMonitor?: AppLogMonitor,
  ) {
    this.addonCommandBuilder = new WebAppVeAddonCommandBuilder();
    this.certificateInjector = new WebAppVeCertificateInjector();
  }

  /**
   * Builds a standardized error result object for handler methods.
   */
  /**
   * Collect provides_* outputs from a completed execution and store them in the stack.
   */
  private async collectAndStoreProvides(
    exec: VeExecution,
    stackIds: string[],
    applicationId: string,
    _storageContext: ContextManager,
  ): Promise<void> {
    const provides: Array<{ name: string; value: string }> = [];
    for (const [key, value] of exec.outputs) {
      if (key.startsWith("provides_") && value !== undefined && value !== null && String(value) !== "NOT_DEFINED") {
        provides.push({
          name: key.replace(/^provides_/, "").toUpperCase(),
          value: String(value),
        });
      }
    }
    if (provides.length === 0 || stackIds.length === 0) return;

    // Use the StackProvider so Spoke deployers (HUB_URL set) read/write the
    // stack on the Hub. Reading via storageContext directly would only see
    // the local in-memory map and miss everything Hub-resident.
    const stackProvider = this.pm.getStackProvider();

    // Route each provide to the semantically right stack.
    //
    // Default: firstStackId — keeps the historical behaviour for app-specific
    //   provides like PROXVEX_DEFAULT_URL.
    // Override: DEPLOYER_OIDC_* — these credentials are consumed by every app
    //   that activates addon-oidc (via conf-setup-oidc-client.sh Tier 2). The
    //   producing application (zitadel) has stacktype=["cloudflare","postgres"]
    //   so firstStackId is postgres_default — but consumer apps (proxvex et
    //   al.) join the oidc_* stack via their own stacktype, NOT postgres_*.
    //   Routing OIDC-specific provides to the oidc stack lets template-var
    //   resolution find them. Without this, Tier 2 silently sees NOT_DEFINED
    //   and falls through to (now-defunct) Tier 3 (admin-client.pat).
    const firstStackId = stackIds[0]!;
    let oidcStackId: string | undefined;
    for (const id of stackIds) {
      const s = await stackProvider.getStack(id);
      if (s?.stacktype === "oidc") {
        oidcStackId = id;
        break;
      }
    }

    const routeFor = (name: string): string =>
      (name.startsWith("DEPLOYER_OIDC_") || name.startsWith("TEST_DEPLOYER_OIDC_"))
        && oidcStackId
        ? oidcStackId
        : firstStackId;

    // Group provides by target stack so we touch each stack at most once.
    const grouped = new Map<string, Array<{ name: string; value: string }>>();
    for (const p of provides) {
      const target = routeFor(p.name);
      if (!grouped.has(target)) grouped.set(target, []);
      grouped.get(target)!.push(p);
    }

    for (const [stackId, group] of grouped) {
      const stack = await stackProvider.getStack(stackId);
      if (!stack) continue;

      // Remove stale provides from this application — but only for keys we're
      // updating in THIS stack, so a key that moved between stacks doesn't
      // get dropped from its new home.
      const newNames = new Set(group.map((p) => p.name));
      let existingProvides = (stack.provides ?? []).filter(
        (e) => e.application !== applicationId || newNames.has(e.name),
      );
      let changed = existingProvides.length !== (stack.provides ?? []).length;

      for (const p of group) {
        const existing = existingProvides.find((e) => e.name === p.name);
        if (existing) {
          if (existing.value !== p.value) {
            this.logger.warn(`Stack provides changed: ${p.name} (${existing.value} → ${p.value})`, { application: applicationId, stack: stackId });
            existing.value = p.value;
            existing.application = applicationId;
            changed = true;
          }
        } else {
          existingProvides.push({ name: p.name, value: p.value, application: applicationId });
          changed = true;
        }
      }

      if (changed) {
        stack.provides = existingProvides;
        // Persist via StackProvider so Spoke pushes the update to the Hub.
        await stackProvider.addStack(stack);
        this.logger.info("Stack provides updated", { stack: stackId, provides: group.map((p) => p.name) });
      }
    }
  }

  /**
   * Reconfigure tasks send `previous_vm_id` instead of `hostname` because the
   * hostname is owned by the existing container (and the user has no reason
   * to retype it). The certificate injector needs the hostname *before* the
   * pipeline runs (templates produce the hostname output later), so resolve
   * it here from the existing managed container and inject it into
   * `processedParams` so downstream consumers see a consistent name.
   *
   * No-op when hostname is already present, or when previous_vm_id is missing,
   * or when the container list cannot be fetched. The cert injector falls back
   * to "localhost" only if both routes fail; that fallback is then a real
   * misconfiguration signal rather than a silent reconfigure regression.
   */
  private async resolveHostnameFromPreviousVmId(
    processedParams: Array<{ id: string; value: string | number | boolean }>,
    veContext: IVEContext,
  ): Promise<void> {
    if (processedParams.some((p) => p.id === "hostname" && p.value !== "" && p.value !== null && p.value !== undefined)) {
      return;
    }
    const prevVmIdParam = processedParams.find((p) => p.id === "previous_vm_id");
    if (!prevVmIdParam || prevVmIdParam.value === "" || prevVmIdParam.value === undefined || prevVmIdParam.value === null) {
      return;
    }
    const previousVmId = String(prevVmIdParam.value);
    try {
      const containers = await listManagedContainers(this.pm, veContext);
      const match = containers.find((c) => String(c.vm_id) === previousVmId);
      if (match?.hostname) {
        processedParams.push({ id: "hostname", value: match.hostname });
        this.logger.info("Resolved hostname from previous_vm_id", {
          previousVmId,
          hostname: match.hostname,
        });
      }
    } catch (err) {
      this.logger.warn("Failed to resolve hostname from previous_vm_id", {
        previousVmId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Best-effort hostname for the per-hostname concurrency guard, resolved as
   * early as possible — before any clone/orchestration work — so the guard
   * covers both the self-upgrade and the regular pipeline. `install` carries
   * `hostname` directly; `upgrade`/`reconfigure` carry `previous_vm_id`, so we
   * look the source container's hostname up from the managed list.
   *
   * Returns undefined when neither route yields a name; the caller then skips
   * locking (fail-open) rather than blocking every unkeyable task. A list
   * fetch failure is likewise non-fatal — the worst case is the pre-existing
   * behavior (no guard), never a wrongly-rejected task.
   */
  private async resolveTaskHostname(
    body: IPostVeConfigurationBody,
    veContext: IVEContext,
  ): Promise<string | undefined> {
    const direct = body.params?.find((p) => p.name === "hostname")?.value;
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") {
      return String(direct).trim();
    }
    const prevVal = body.params?.find((p) => p.name === "previous_vm_id")?.value;
    if (prevVal === undefined || prevVal === null || String(prevVal).trim() === "") {
      return undefined;
    }
    const previousVmId = String(prevVal);
    try {
      const containers = await listManagedContainers(this.pm, veContext);
      return containers.find((c) => String(c.vm_id) === previousVmId)?.hostname || undefined;
    } catch (err) {
      this.logger.warn(
        "Concurrency guard: could not resolve hostname from previous_vm_id; proceeding without lock",
        { previousVmId, error: err instanceof Error ? err.message : String(err) },
      );
      return undefined;
    }
  }

  private buildErrorResult(err: unknown): {
    success: false;
    error: string;
    errorDetails?: IJsonError;
    statusCode: number;
  } {
    const serialized = serializeError(err);
    const result: {
      success: false;
      error: string;
      errorDetails?: IJsonError;
      statusCode: number;
    } = {
      success: false,
      error:
        typeof serialized === "string"
          ? serialized
          : serialized.message || "Unknown error",
      statusCode: getErrorStatusCode(err),
    };
    if (typeof serialized === "object") {
      result.errorDetails = serialized;
    }
    return result;
  }

  /**
   * Validates request body for VeConfiguration endpoint.
   */
  validateVeConfigurationBody(body: IPostVeConfigurationBody): {
    valid: boolean;
    error?: string;
  } {
    if (!Array.isArray(body.params)) {
      return { valid: false, error: "Invalid parameters" };
    }
    if (body.outputs !== undefined && !Array.isArray(body.outputs)) {
      return { valid: false, error: "Invalid outputs" };
    }
    if (
      body.changedParams !== undefined &&
      !Array.isArray(body.changedParams)
    ) {
      return { valid: false, error: "Invalid changedParams" };
    }
    if (
      body.selectedAddons !== undefined &&
      !Array.isArray(body.selectedAddons)
    ) {
      return { valid: false, error: "Invalid selectedAddons" };
    }
    if (
      body.disabledAddons !== undefined &&
      !Array.isArray(body.disabledAddons)
    ) {
      return { valid: false, error: "Invalid disabledAddons" };
    }
    return { valid: true };
  }

  /**
   * Augment `allStackIds` (mutated in place) with the stack ids of the
   * selected addons' stacktypes, so dependency resolution can find containers
   * living in addon stacks. Only fills in stacktypes not already covered — and
   * prefers the stack whose name suffix matches an existing stack id (e.g. for
   * gitea/ssl with body stacks ["postgres_ssl", "gitea_ssl"], pick "oidc_ssl"
   * rather than every oidc_*). Pulling in unrelated variants (oidc_default,
   * oidc_upgrade) would make 185-host-resolve-dependency-hosts match the wrong
   * container. Reads the live stack registry, so it must run on a deployer that
   * actually owns the addon stacks (the Hub) — the self-upgrade clone forwards
   * the result rather than re-deriving against its empty copy.
   */
  private async augmentStackIdsWithAddons(
    allStackIds: string[],
    selectedAddons: string[],
  ): Promise<void> {
    if (selectedAddons.length === 0) return;
    try {
      const addonSvc = this.pm.getAddonService();
      // Stacktypes already represented in allStackIds.
      const coveredStacktypes = new Set<string>();
      // The "stack name" component is the part after the first underscore;
      // e.g. "postgres_ssl" → "ssl". Use it to pick same-variant addon
      // stacks instead of any existing one.
      const preferredStackNames = new Set<string>();
      const stackProviderForLookup = this.pm.getStackProvider();
      for (const sid of allStackIds) {
        const stack = await stackProviderForLookup.getStack(sid);
        if (stack?.stacktype) {
          const stTypes = Array.isArray(stack.stacktype)
            ? stack.stacktype
            : [stack.stacktype];
          for (const st of stTypes) coveredStacktypes.add(st);
        }
        if (stack?.name) preferredStackNames.add(stack.name);
        else {
          const idx = sid.indexOf("_");
          if (idx > 0) preferredStackNames.add(sid.slice(idx + 1));
        }
      }
      for (const addonId of selectedAddons) {
        try {
          const addon = addonSvc.getAddon(addonId);
          if (addon?.stacktype) {
            const addonTypes = Array.isArray(addon.stacktype) ? addon.stacktype : [addon.stacktype];
            for (const st of addonTypes) {
              if (coveredStacktypes.has(st)) continue;
              const stacks = await stackProviderForLookup.listStacks(st);
              // Prefer same-variant; fall back to any if no match.
              const matching = stacks.filter((s) =>
                preferredStackNames.has(s.name),
              );
              const toAdd = matching.length > 0 ? matching : stacks;
              for (const stack of toAdd) {
                if (!allStackIds.includes(stack.id)) {
                  allStackIds.push(stack.id);
                }
              }
              coveredStacktypes.add(st);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /**
   * Collect the addon-stack values a clone-side reconfigure needs but cannot
   * resolve from its own (isolated) stack store, so they can be forwarded as
   * params to the clone. The self-upgrade clone is a `pct clone` of the source
   * deployer: it knows the oidc_* stack id (forwarded via body.stackIds) but
   * not the stack's entries/provides — e.g. DEPLOYER_OIDC_MACHINE_CLIENT_ID/
   * SECRET, DEPLOYER_OIDC_ISSUER_URL, DEPLOYER_OIDC_PROJECT_ID, which the
   * Setup OIDC Client template needs to mint a Zitadel client. The Hub holds
   * those (zitadel/default registered them), so resolve them here and forward.
   * Only OIDC-prefixed keys are forwarded — the clone resolves everything else
   * (e.g. ZITADEL_HOST via 185-host-resolve-dependency-hosts) on its own.
   */
  private async collectCloneStackParams(
    stackIds: string[],
  ): Promise<Array<{ name: string; value: string }>> {
    const FORWARD_PREFIXES = ["DEPLOYER_OIDC_", "TEST_DEPLOYER_OIDC_"];
    const out: Array<{ name: string; value: string }> = [];
    const seen = new Set<string>();
    try {
      const sp = this.pm.getStackProvider();
      for (const sid of stackIds) {
        const stack = await sp.getStack(sid);
        if (!stack) continue;
        const all = [...(stack.entries ?? []), ...(stack.provides ?? [])];
        for (const kv of all) {
          const name = kv.name;
          if (seen.has(name)) continue;
          if (!FORWARD_PREFIXES.some((p) => name.startsWith(p))) continue;
          if (kv.value === undefined || kv.value === null || kv.value === "") continue;
          out.push({ name, value: String(kv.value) });
          seen.add(name);
        }
      }
    } catch { /* best-effort — clone falls back to its own resolution */ }
    return out;
  }

  /**
   * Handles POST /api/ve-configuration/:application/:veContext (task in body)
   */
  async handleVeConfiguration(
    application: string,
    task: string,
    veContextKey: string,
    body: IPostVeConfigurationBody,
    userAccessToken?: string,
    requestOrigin?: string,
  ): Promise<{
    success: boolean;
    restartKey?: string;
    vmInstallKey?: string;
    error?: string;
    errorDetails?: IJsonError;
    statusCode?: number;
  }> {
    // Validate request body
    const validation = this.validateVeConfigurationBody(body);
    if (!validation.valid) {
      return {
        success: false,
        ...(validation.error && { error: validation.error }),
        statusCode: 400,
      };
    }

    // Per-hostname concurrency guard state. Declared out here (not inside the
    // try) so the method-level `finally` can release the lock on every exit.
    // `lockReleaseDeferred` flips to true once the background VeExecution takes
    // over release (regular path); until then every early return / throw must
    // release so a failed dispatch never leaves a hostname permanently blocked.
    let lockKey: string | undefined;
    let lockReleaseDeferred = false;

    try {
      // Load application (provides commands)
      const storageContext =
        this.pm.getContextManager();
      const ctx: IVEContext | null =
        storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return {
          success: false,
          error: "VE context not found",
          statusCode: 404,
        };
      }
      const veCtxToUse: IVEContext = ctx as IVEContext;

      // ── Per-hostname concurrency guard ─────────────────────────────────
      // Resolve the target hostname and reject the request if another task is
      // already mutating it. Placed before the self-upgrade branch so it
      // protects the clone-orchestration path too (that path was the source of
      // the dual-clone IP collision). The get → check → set below runs without
      // an intervening await, so it is atomic against the event loop: two
      // concurrent requests for the same hostname cannot both acquire.
      const taskHostname = await this.resolveTaskHostname(body, veCtxToUse);
      if (taskHostname) {
        lockKey = `${veContextKey}::${taskHostname}`;
        const active = this.activeHostnameTasks.get(lockKey);
        if (active) {
          // Do not release the foreign lock on the way out — it belongs to the
          // in-flight task, not this rejected one.
          lockReleaseDeferred = true;
          this.logger.warn("Rejected concurrent task on busy hostname", {
            hostname: taskHostname,
            veContextKey,
            incoming: `${task} ${application}`,
            active: `${active.task} ${active.application}`,
            activeForMs: Date.now() - active.startedAt,
          });
          return {
            success: false,
            error: `A "${active.task}" task for hostname "${taskHostname}" is already running. Wait for it to finish before starting another task on the same hostname.`,
            statusCode: 409,
          };
        }
        this.activeHostnameTasks.set(lockKey, {
          application,
          task,
          startedAt: Date.now(),
        });
      }

      // ── Self-upgrade-via-clone orchestration ──────────────────────────
      // For proxvex upgrade/reconfigure where the previous_vm_id is the
      // running deployer-instance itself, delegate to the orchestrator:
      // it clones the deployer, hands the real upgrade off to the clone,
      // and returns the clone's restart key. The clone runs the regular
      // pipeline against the original CT (no recursion thanks to the
      // _orchestrated_via_clone flag on the request body).
      try {
        const prevParam = body.params?.find((p) => p.name === "previous_vm_id");
        const previousVmidFromBody = prevParam?.value !== undefined ? String(prevParam.value) : undefined;
        const { shouldOrchestrateSelfUpgrade, cloneSelfAsTempDeployer, startClone, waitForCloneApi, triggerUpgradeViaClone, writeCleanupMarker, mirrorCloneTaskMessages, discoverCloneIp } =
          await import("../services/self-upgrade-orchestrator.mjs");
        const detect = await shouldOrchestrateSelfUpgrade(application, task as TaskType, previousVmidFromBody, body, veContextKey);
        if (detect.orchestrate) {
          // Autodetect may have filled this in when the caller didn't pass
          // previous_vm_id (e.g. CLI POST without explicit vmid → cgroup-based
          // self-detection). Use the resolved value throughout the branch.
          const previousVmid = detect.resolvedPreviousVmid ?? previousVmidFromBody!;
          // Ensure body.params carries the resolved vmid so the clone-side
          // pipeline (when triggerUpgradeViaClone forwards body.params) finds
          // it. Replace any leftover entry to keep it canonical.
          const paramsWithPrev = (body.params ?? []).filter((p) => p.name !== "previous_vm_id");
          paramsWithPrev.push({ name: "previous_vm_id", value: previousVmid });
          body.params = paramsWithPrev;
          this.logger.info("Self-upgrade detected — delegating to clone orchestrator", {
            application,
            task,
            previousVmid,
            veContextKey,
          });
          // Resolve the URL the original Hub answers on (same fallback chain
          // as the regular template-defaults path below). Passed into the
          // clone via lxc.environment PROXVEX_URL so the clone's own template
          // engine writes the ORIGINAL Hub URL into the new CT's Notes
          // (proxvex:log-url marker) — otherwise Notes would point at the
          // ephemeral clone IP and break log-viewer links after cleanup.
          const deployerPort = process.env.DEPLOYER_PORT || process.env.PORT || "3080";
          const deployerUrl = resolveDeployerBaseUrl({
            envOverride: process.env.PROXVEX_URL,
            hubUrl: this.pm.getActiveHubUrl(),
            requestOrigin,
            deployerPort,
          });
          // Generate the outer restartKey BEFORE any orchestrator VeExecution.
          // Every Hub-side ICommand gets stamped with this key (E.4) so the
          // Hub-Phasen ("Clone self...", "Start clone", "Discover clone IP",
          // "Authorize clone pubkey") appear under one outer-task bundle.
          // The clone runs a separate reconfigure under its own clone-side
          // restartKey; we adopt that under `${outerKey}__clone` later in
          // clone-cleanup-service (E.6).
          const outerRestartKey = this.executionSetup.generateRestartKey();
          // Open a debug-collector entry for the outer task so the Hub-side
          // VeExecutions (stamped with outerRestartKey) get bucketed here
          // instead of dropped. debug_level from body.params controls
          // verbosity; default `extLog` keeps the bundle non-trivial even
          // without --debug script.
          const debugLevelParam = body.params?.find((p) => p.name === "debug_level");
          const outerDebugLevel = (debugLevelParam?.value as DebugLevel) ?? "extLog";
          if (this.debugCollector) {
            this.debugCollector.start(outerRestartKey, application, task, outerDebugLevel);
          }
          // Self-upgrade stages emit Hub-side progress markers into the
          // outer task stream so the operator (CLI / Frontend SSE) sees
          // what is happening during the ~1-2 min clone-bring-up phase
          // BEFORE the mirror starts pulling Clone-side script messages.
          // Without these emissions there is dead silence from POST-time
          // to triggerUpgradeViaClone-return (see "first few minutes
          // no messages" observation).
          const emitStage = (stage: number, stderr: string): void => {
            try {
              this.messageManager.handleExecutionMessage(
                {
                  command: `Self-upgrade [${stage}/5]`,
                  exitCode: 0,
                  stderr,
                  result: null,
                  partial: false,
                  finished: false,
                  index: getNextMessageIndex(),
                  restartKey: outerRestartKey,
                },
                application,
                task,
                outerRestartKey,
              );
            } catch (err: any) {
              this.logger.warn(`Failed to emit self-upgrade stage ${stage} marker — non-fatal`, { error: err?.message });
            }
          };

          const clone = await cloneSelfAsTempDeployer(previousVmid, veContextKey, deployerUrl, outerRestartKey);
          emitStage(1, `Clone CT ${clone.cloneVmid} created from source ${clone.sourceVmid} (hostname=${clone.cloneHostname})`);
          await startClone(clone.cloneVmid, clone.veContextKey, outerRestartKey);
          emitStage(2, `Clone CT ${clone.cloneVmid} booted`);
          // DHCP-mode clones return an empty cloneIp from the create
          // script — the IP is leased when the CT comes up. Discover it
          // by reading /proc/net/fib_trie from inside the running clone.
          if (!clone.cloneIp) {
            clone.cloneIp = await discoverCloneIp(clone.cloneVmid, clone.veContextKey, 30_000, outerRestartKey);
          }
          emitStage(3, `Clone IP discovered: ${clone.cloneIp}`);
          await waitForCloneApi(clone.cloneIp);
          emitStage(4, `Clone API ready at http://${clone.cloneIp}:3080`);
          // Derive the addon stack ids HERE, on the Hub, where the stack
          // registry is populated (e.g. zitadel/default registered the
          // oidc_default stack). The clone is a `pct clone` of the pre-OIDC
          // source and would resolve no oidc_* stack on its own, so its
          // 185-host-resolve-dependency-hosts would fail ("require a stack_name
          // but none is set"). Forwarding the resolved ids lets the clone seed
          // allStackIds from body.stackIds instead of re-deriving.
          const cloneStackIds = [...(body.stackIds ?? [])];
          if (body.stackId && !cloneStackIds.includes(body.stackId)) {
            cloneStackIds.unshift(body.stackId);
          }
          await this.augmentStackIdsWithAddons(cloneStackIds, body.selectedAddons ?? []);
          // Forward the addon-stack values (e.g. DEPLOYER_OIDC_MACHINE_*) the
          // clone cannot resolve from its isolated stack store. Params already
          // carry secrets to the clone (deploy-params baseline), so this is
          // consistent. Don't clobber values the caller passed explicitly.
          const cloneParams = [...(body.params ?? [])];
          for (const inj of await this.collectCloneStackParams(cloneStackIds)) {
            if (!cloneParams.some((p) => p.name === inj.name)) {
              cloneParams.push(inj);
            }
          }
          const result = await triggerUpgradeViaClone(
            clone.cloneIp,
            veContextKey,
            application,
            task as TaskType,
            cloneParams,
            previousVmid,
            body.selectedAddons ?? [],
            3080,
            30_000,
            outerRestartKey,
            cloneStackIds,
            body.disabledAddons,
          );
          emitStage(5, `Upgrade task dispatched to clone (clone-side restartKey=${result.restartKey}); mirroring clone messages from now on`);
          // E.8: outer key IS the unified key. The Hub forwarded it to
          // the Clone in the body.outer_restart_key; the Clone's route
          // handler used it as restartKeyOverride; therefore
          // result.restartKey === outerRestartKey and we use it for
          // marker, mirror, and adoption.

          // Write the cleanup marker into the source CT's /config volume.
          // When the clone reconfigures the source, the volume is cloned
          // into the new CT — the marker rides along. The new CT's
          // clone-cleanup-service reads it on first boot, pulls the
          // bundle/messages from the Clone under outerRestartKey, adopts
          // them under outerRestartKey on the new CT, then destroys the
          // Clone.
          try {
            const localPath = this.pm.getPathes().localPath;
            writeCleanupMarker(localPath, {
              cloneVmid: clone.cloneVmid,
              cloneIp: clone.cloneIp,
              restartKey: outerRestartKey,
              veContextKey,
            });
          } catch (markerErr: any) {
            this.logger.warn("Failed to write clone-cleanup marker — orchestration continues, manual cleanup required", {
              error: markerErr?.message,
            });
          }
          this.logger.info("Clone-side upgrade dispatched", {
            cloneVmid: clone.cloneVmid,
            outerRestartKey,
            cloneAcceptedKey: result.restartKey,
          });

          // E.7: explicit handoff marker into the outer task stream.
          // The CLI / livetest runner polls /api/<ve>/ve/execute under
          // outerRestartKey — this message tells the operator that the
          // Hub is about to be replaced and diagnostics continue on the
          // new CT under the SAME key. Written BEFORE the actual
          // switchover so it lands in the local stream even if the Hub
          // gets killed mid-replace.
          try {
            this.messageManager.handleExecutionMessage(
              {
                command: "Self-upgrade handoff",
                exitCode: 0,
                stderr:
                  `Hub will be replaced by clone-driven upgrade. ` +
                  `Polling continues on the new CT (same hostname/IP) under restartKey=${outerRestartKey}. ` +
                  `All clone-side diagnostics will be adopted under the same key.`,
                result: null,
                partial: false,
                finished: false,
                restartKey: outerRestartKey,
              },
              application,
              task,
              outerRestartKey,
            );
          } catch (handoffErr: any) {
            this.logger.warn("Failed to write self-upgrade handoff marker — non-fatal", {
              error: handoffErr?.message,
            });
          }

          // Mirror the clone's task messages into the Hub's local message
          // manager under outerRestartKey so live UI/CLI see continuous
          // progress while the Hub is alive. The Hub will die mid-replace;
          // the mirror exits cleanly when the source CT stops.
          void mirrorCloneTaskMessages({
            cloneIp: clone.cloneIp,
            veContextKey,
            application,
            task,
            restartKey: outerRestartKey,
            messageManager: this.messageManager,
          }).catch((err) => {
            this.logger.warn("Clone message mirror crashed", { error: err?.message });
          });

          return {
            success: true,
            restartKey: outerRestartKey,
          };
        }
      } catch (err: any) {
        // NEVER fall back to the in-place flow on orchestration failure:
        // that would risk creating a spurious in-place reconfigure on the
        // running deployer with the wrong assumptions. Surface the error
        // to the caller; manual cleanup of any half-created clone CT may
        // be necessary (see host-stop-and-destroy-clone-deployer.sh).
        this.logger.error("Self-upgrade orchestration failed", {
          error: err?.message,
          stack: err?.stack,
        });
        return {
          success: false,
          error: `Self-upgrade orchestration failed: ${err?.message ?? String(err)}`,
          statusCode: 500,
        };
      }

      const templateProcessor = veCtxToUse
        .getStorageContext()
        .getTemplateProcessor();

      // Determine execution mode: TEST executes locally, PRODUCTION executes via SSH to VE host.
      const executionMode = determineExecutionMode();
      const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";

      // ── Reconfigure deploy-params baseline ─────────────────────────────
      // On reconfigure, seed a parameter baseline from the snapshot persisted
      // in the previous container's notes (proxvex:deploy-params marker), so
      // install-time customizations the request does not re-send keep their
      // value instead of resetting to application/parameter-definition defaults.
      // Request params override the baseline; any read/decode failure or an
      // older container without the marker leaves today's behavior unchanged.
      if (task === "reconfigure") {
        const prevVmIdParam = body.params?.find(
          (p) => p.name === "previous_vm_id",
        );
        const prevVmId = prevVmIdParam ? Number(prevVmIdParam.value) : NaN;
        if (!Number.isNaN(prevVmId)) {
          try {
            const prevCfg = await getContainerConfig(
              this.pm,
              veCtxToUse,
              prevVmId,
            );
            const baseline = this.parameterProcessor.decodeDeployParams(
              prevCfg?.deploy_params_b64,
            );
            if (baseline) {
              body.params = this.parameterProcessor.mergeDeployBaseline(
                body.params,
                baseline,
              );
              this.logger.info(
                "Applied deploy-params baseline from previous container",
                { previous_vm_id: prevVmId, baselineParams: baseline.params.length },
              );
            }
          } catch (err: any) {
            this.logger.warn(
              "Could not read deploy-params baseline; continuing without it",
              { previous_vm_id: prevVmId, error: err?.message ?? String(err) },
            );
          }
        }
      }

      // Always use all params for execution — changedParams is only relevant for
      // the restart flow (separate code path). Using changedParams here would lose
      // unchanged preset values (e.g. previous_vm_id) that templates still need.
      const paramsToUse = body.params;

      // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
      // Must use body.params (all parameters), not paramsToUse (changedParams only),
      // because skip_if_all_missing needs to see all provided parameters, not just changed ones.
      const initialInputs: Array<{ id: string; value: string | number | boolean }> = body.params
        .filter(
          (p) => p.value !== null && p.value !== undefined && p.value !== "",
        )
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      // Pre-inject backend-generated values so skip_if_all_missing can see them
      // during template loading (before defaults are set post-load).
      // Collect all stack IDs (new array format + legacy single format)
      const allStackIds = [...(body.stackIds ?? [])];
      if (body.stackId && !allStackIds.includes(body.stackId)) {
        allStackIds.unshift(body.stackId);
      }

      // Add addon stacktypes to allStackIds so dependency resolution can find
      // containers in addon stacks. Extracted into augmentStackIdsWithAddons so
      // the self-upgrade clone-dispatch path can derive the SAME stack ids on
      // the Hub (which holds the populated stack registry) and forward them to
      // the clone (whose registry is a copy of the pre-OIDC source and would
      // otherwise resolve no oidc_* stack).
      await this.augmentStackIdsWithAddons(allStackIds, body.selectedAddons ?? []);

      const firstStackId = allStackIds[0];
      if (firstStackId) {
        initialInputs.push({ id: "stack_id", value: firstStackId });
      }
      if (allStackIds.length > 0) {
        initialInputs.push({ id: "all_stack_ids", value: JSON.stringify(allStackIds) });
      }

      // Pre-inject addon property values (with prefix-stripping aliases) into
      // initialInputs so `skip_if_all_missing` can see them during loadApplication.
      // Without this, templates like 150-conf-create-storage-volumes-for-lxc
      // skip when an app has no own `volumes` default — even though the selected
      // addon will inject `addon_volumes` later via a properties command.
      // Mirrors the aliasing in webapp-ve-addon-command-builder (ssl.X → X).
      const selectedAddonsForInitial = body.selectedAddons ?? [];
      if (selectedAddonsForInitial.length > 0) {
        try {
          const addonSvc = this.pm.getAddonService();
          for (const addonId of selectedAddonsForInitial) {
            const addon = addonSvc.getAddon(addonId);
            for (const prop of addon?.properties ?? []) {
              const propVal = (prop as { value?: unknown }).value;
              if (propVal === undefined || propVal === null || propVal === "") continue;
              const propStrVal = String(propVal);
              const propId = String((prop as { id: string }).id);
              if (!initialInputs.some((p) => p.id === propId)) {
                initialInputs.push({ id: propId, value: propStrVal });
              }
              const dotIdx = propId.indexOf(".");
              if (dotIdx > 0) {
                const unprefixed = propId.slice(dotIdx + 1);
                if (!initialInputs.some((p) => p.id === unprefixed)) {
                  initialInputs.push({ id: unprefixed, value: propStrVal });
                }
              }
            }
          }
        } catch { /* best-effort */ }
      }

      // Read application + addon dependencies for dependency-host-discovery.
      // Single source of truth: ApplicationDependencyResolver. The same
      // resolver is used by webapp-dependency-check-routes (UI pre-check)
      // and the execution path below, so all three converge on identical
      // results for the same inputs.
      let appConfig: any = null;
      try {
        appConfig = this.pm.getRepositories().getApplication(application);
      } catch { /* getApplication may fail for some apps */ }
      const allDeps = (
        await this.pm.getApplicationDependencyResolverForStacks(allStackIds)
      )
        .resolve(
          application,
          body.selectedAddons ?? [],
          allStackIds,
        )
        .map((d) => ({ application: d.application }));
      if (allDeps.length > 0) {
        initialInputs.push({ id: "app_dependencies", value: JSON.stringify(allDeps) });
      }

      // Pre-inject ca_key_b64 marker so skip_if_all_missing in template 156
      // does not skip cert generation when addon-ssl is selected.
      // The actual CA key is injected later by certificateInjector.
      // Merge required_addons (always active, cannot be deselected by user)
      const appRequiredAddons = ((appConfig as any)?.required_addons ?? []) as string[];
      const allRequestedAddons = [...new Set([...(body.selectedAddons ?? []), ...appRequiredAddons])];
      if (allRequestedAddons.some((a: string) => a === "addon-ssl" || a === "addon-acme")) {
        if (!initialInputs.some(p => p.id === "ca_key_b64")) {
          initialInputs.push({ id: "ca_key_b64", value: "pending" });
        }
      }

      // For in-place upgrade/reconfigure without create_ct: vm_id = previous_vm_id
      if (!initialInputs.some(p => p.id === "vm_id") && initialInputs.some(p => p.id === "previous_vm_id")) {
        const prev = initialInputs.find(p => p.id === "previous_vm_id");
        if (prev) {
          initialInputs.push({ id: "vm_id", value: prev.value });
        }
      }

      const loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        executionMode,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
      );
      let commands = loaded.commands;

      // Insert addon templates at correct positions for each phase
      // For reconfigure with installedAddons: only inject changed addons (delta)
      const installedAddons = body.installedAddons ?? [];
      let selectedAddons = [...new Set([...(body.selectedAddons ?? []), ...appRequiredAddons])];
      let disabledAddons = body.disabledAddons ?? [];

      if (installedAddons.length > 0 && task === "reconfigure") {
        // Delta injection: separate addons into new, kept, and removed
        const installedSet = new Set(installedAddons);
        const selectedSet = new Set(selectedAddons);

        // New addons = selected but not installed
        const newAddons = selectedAddons.filter(a => !installedSet.has(a));
        // Kept addons = both installed and selected (reconfigure with full flow)
        const keptAddons = selectedAddons.filter(a => installedSet.has(a));
        // Removed addons = installed but not selected (merge with explicitly disabled)
        const removedAddons = installedAddons.filter(a => !selectedSet.has(a));
        disabledAddons = [...new Set([...disabledAddons, ...removedAddons])]
          .filter(a => !appRequiredAddons.includes(a)); // required_addons cannot be disabled
        // Inject templates for both new and kept addons
        selectedAddons = [...new Set([...newAddons, ...keptAddons, ...appRequiredAddons])];
      }

      if (selectedAddons.length > 0) {
        commands = await this.addonCommandBuilder.insertAddonCommands(
          commands,
          selectedAddons,
          task as TaskType,
          loaded.application,
        );
      }
      if (disabledAddons.length > 0) {
        commands = await this.addonCommandBuilder.insertAddonDisableCommands(
          commands,
          disabledAddons,
          loaded.application,
        );
      }

      // Defer the "no commands" check until after addons are merged. Apps
      // with an empty pre_start (e.g. the hidden proxmox host app) rely on
      // selected addons to contribute the actual reconfigure work.
      if (!commands || commands.length === 0) {
        return {
          success: false,
          error: "No commands to execute for this task",
          statusCode: 422,
        };
      }

      const defaults = this.parameterProcessor.buildDefaults(
      loaded.parameters,
      loaded.propertyDefaults,
    );

      // Make stack_id and all_stack_ids visible to the runtime variable
      // resolver (initialInputs only feeds skip_if_all_missing). Scripts like
      // 185-host-resolve-dependency-hosts and 191-write-docker-compose-notes
      // read these via {{ stack_id }} / {{ all_stack_ids }} — without them
      // here they resolve to NOT_DEFINED and the resolver falls back to the
      // unfiltered scan, picking the wrong dependency container.
      if (firstStackId && !defaults.has("stack_id")) {
        defaults.set("stack_id", firstStackId);
      }
      if (allStackIds.length > 0 && !defaults.has("all_stack_ids")) {
        defaults.set("all_stack_ids", JSON.stringify(allStackIds));
      }

      // Load entries from all stacks (app + addon stacktypes).
      // Use the StackProvider so Spoke deployers (HUB_URL set) read stacks
      // from the Hub. Without this, `{{ POSTGRES_PASSWORD }}` and similar
      // stack variables resolve to NOT_DEFINED in Spoke mode because the
      // local in-memory storageContext is empty.
      const stackProviderForEntries = this.pm.getStackProvider();
      for (const sid of allStackIds) {
        const stack = await stackProviderForEntries.getStack(sid);
        if (stack) {
          if (stack.entries) {
            for (const entry of stack.entries) {
              defaults.set(entry.name, entry.value);
            }
          }
          // Load provides as defaults (connection info from providers)
          if (stack.provides) {
            for (const p of stack.provides) {
              if (!defaults.has(p.name)) {
                defaults.set(p.name, p.value);
              }
            }
          }
        }
      }

      // Build stack_secret_names for compose template sanitization
      // Format: NAME=VALUE,NAME=VALUE (allows upload script to replace resolved values with {{ NAME }})
      {
        const secretPairs: string[] = [];
        for (const sid of allStackIds) {
          const stack = await stackProviderForEntries.getStack(sid);
          if (stack?.entries) {
            for (const entry of stack.entries) {
              if (entry.value !== undefined && entry.value !== "") {
                secretPairs.push(`${entry.name}=${entry.value}`);
              }
            }
          }
        }
        if (secretPairs.length > 0) {
          defaults.set("stack_secret_names", secretPairs.join(","));
        }
      }

      // Inject application + addon dependencies for dependency-host-discovery
      // script. Same source-of-truth as the preview-task path above and the
      // /api/dependency-check route — see ApplicationDependencyResolver.
      {
        const allDeps = (
          await this.pm.getApplicationDependencyResolverForStacks(allStackIds)
        )
          .resolve(application, selectedAddons, allStackIds)
          .map((d) => ({ application: d.application }));
        if (allDeps.length > 0) {
          defaults.set("app_dependencies", JSON.stringify(allDeps));
        }
      }

      // Built-in context variables (available to scripts as {{ application_id }}, etc.)
      // Do not require any template parameters.
      defaults.set("application", application);
      defaults.set("application_id", application);
      defaults.set(
        "application_name",
        loaded.application &&
          typeof (loaded.application as any).name === "string"
          ? String((loaded.application as any).name)
          : application,
      );
      defaults.set("task", task);
      defaults.set("task_type", task);

      // For in-place upgrade/reconfigure: vm_id = previous_vm_id if not explicitly set
      this.parameterProcessor.applyPreviousVmIdFallback(defaults, paramsToUse);

      // Log viewer URL embedded into LXC Notes. See deployer-url-resolver.mts
      // for the fallback chain: PROXVEX_URL > Hub URL (Spoke mode) > request
      // origin > os.hostname():port.
      const deployerPort = process.env.DEPLOYER_PORT || process.env.PORT || "3080";
      const deployerUrl = resolveDeployerBaseUrl({
        envOverride: process.env.PROXVEX_URL,
        hubUrl: this.pm.getActiveHubUrl(),
        requestOrigin,
        deployerPort,
      });
      defaults.set("deployer_base_url", deployerUrl);
      defaults.set("ve_context_key", veContextKey);

      // Browser-facing base URL of the application (scheme://host[:port]).
      // OIDC redirect/logout (and any app needing its own external URL) are
      // built as {{app_external_url}}<app-specific-path>, so this single
      // computed value fixes both the protocol (https only when addon-ssl is
      // active) and the port, which a static application.json default cannot
      // express. Injected as a concrete string — not a templated default —
      // because chained defaults do not re-resolve on the CLI/production path
      // (only the frontend re-runs the chain). User params still override it
      // for reverse-proxy / public-domain setups.
      {
        const appProperties = (loaded.application?.properties ?? []) as Array<{
          id: string;
          value?: unknown;
          default?: unknown;
        }>;
        const lookupEffective = (name: string): string | undefined => {
          const fromParam = body.params?.find(p => p.name === name);
          if (
            fromParam &&
            fromParam.value !== undefined &&
            String(fromParam.value) !== ""
          ) {
            return String(fromParam.value);
          }
          // Application property VALUE wins over the parameter-definition
          // default in the `defaults` map. Property values (e.g. modbus2mqtt's
          // `local_https_port: "3443"`) flow through the resolved-params pipeline
          // and never enter `defaults`, which instead holds the param-definition
          // fallback (1443) — so without this, app_external_url would build the
          // OIDC redirect with the wrong port. Prefer value, then property default.
          const fromProp = appProperties.find(p => p.id === name);
          if (fromProp) {
            if (fromProp.value !== undefined && String(fromProp.value) !== "") {
              return String(fromProp.value);
            }
            if (fromProp.default !== undefined && String(fromProp.default) !== "") {
              return String(fromProp.default);
            }
          }
          const fromDefault = defaults.get(name);
          return fromDefault !== undefined && String(fromDefault) !== ""
            ? String(fromDefault)
            : undefined;
        };
        const sslActive = selectedAddons.includes("addon-ssl");
        const scheme = sslActive ? "https" : "http";
        const host = lookupEffective("hostname");
        const port = sslActive
          ? lookupEffective("local_https_port")
          : lookupEffective("http_port");
        if (host) {
          defaults.set(
            "app_external_url",
            port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`,
          );
        }
      }

      // Inject oci_image_tag from versions.sh if available, otherwise extract from oci_image property.
      // During fresh install, this is overwritten by the image download script output.
      // During reconfigure, image scripts don't run, so this default is used for notes.
      // Docker-compose apps have no single oci_image property — leave empty so
      // the notes writer doesn't fall back to the deployer version. The post-
      // start script `post-update-version-from-docker.py` fills in the real
      // multi-service version after docker pull.
      const versions = parseVersionsLib(this.pm.getRepositories());
      const versionFromLib = getOciImageTag(versions, application);
      if (versionFromLib) {
        defaults.set("oci_image_tag", versionFromLib);
      } else {
        const ociImageProp = loaded.application?.properties?.find(
          (p: { id: string }) => p.id === "oci_image",
        );
        const ociImageValue = ociImageProp?.value ? String(ociImageProp.value) : "";
        const ociImageTag = ociImageValue.includes(":")
          ? ociImageValue.split(":").pop() ?? ""
          : ociImageValue;
        defaults.set("oci_image_tag", ociImageTag);
      }

      // Icon data for embedding in notes (Data URL avoids mixed content issues)
      // Always use readApplicationIcon() which normalizes SVG size for notes display
      const iconData =
        this.pm
          .getApplicationService()
          .readApplicationIcon(application);
      if (iconData) {
        defaults.set("icon_base64", iconData.iconContent);
        defaults.set("icon_mime_type", iconData.iconType);
      }

      // Mark deployer-instance for self-reconfigure support
      if (application === "proxvex") {
        defaults.set("is_deployer", "true");
      }

      // Store selected addon IDs for notes update (comma-separated for shell script)
      if (selectedAddons.length > 0) {
        defaults.set("selected_addons", selectedAddons.join(","));
      }

      // Persist the submitted deploy payload as a base64-JSON snapshot embedded
      // (invisibly) in the container notes. A later reconfigure reads it back to
      // restore install-time parameter values that the request does not re-send
      // — see mergeDeployBaseline below and the `proxvex:deploy-params` marker.
      // Built from body.params (post-baseline-merge) AFTER the addon delta merge
      // so the persisted addon lists are the effective ones.
      defaults.set(
        "deploy_params_b64",
        this.parameterProcessor.buildDeployParamsSnapshot(
          body.params,
          loaded.parameters,
          selectedAddons,
          disabledAddons,
          allStackIds,
        ),
      );

      const contextManager =
        this.pm.getContextManager();
      // Process parameters: for upload parameters with "local:" prefix, read file and base64 encode
      const processedParams = await this.parameterProcessor.processParameters(
        paramsToUse,
        loaded.parameters,
        contextManager,
      );

      // Merge addon certtype parameters into the parameter list for cert injection
      let allCertParameters: IParameter[] = [...loaded.parameters];
      if (selectedAddons.length > 0) {
        const addonService = this.pm.getAddonService();
        for (const addonId of selectedAddons) {
          try {
            const addon = addonService.getAddon(addonId);
            if (addon.parameters) {
              allCertParameters.push(
                ...addon.parameters.filter(p => p.certtype),
              );
            }
          } catch { /* addon not found, skip */ }
        }
      }

      // Reconfigure tasks send only previous_vm_id; hostname must be resolved
      // from the existing managed container so the cert injector below signs
      // for the right name (otherwise it falls back to "localhost" and the
      // disk cert never rotates because of the script-side identity check).
      await this.resolveHostnameFromPreviousVmId(processedParams, veCtxToUse);

      // Auto-generate certificate parameters for certtype params without user upload.
      // Hub mode → CertificateAuthorityService (signs locally with on-disk CA key).
      // Spoke mode → RemoteCaProvider (delegates signing to Hub via /api/hub/ca/*).
      const caProvider = this.pm.getCaProvider();
      await this.certificateInjector.injectCertificateRequests(
        processedParams,
        allCertParameters,
        caProvider,
        veContextKey,
        loaded.application?.properties as Array<{ id: string; value?: unknown; default?: unknown }> | undefined,
      );
      // mTLS client certs (addon-mtls). Independent of SSL — only fires when a
      // certtype="client" param is present, i.e. addon-mtls is selected.
      await this.certificateInjector.injectClientCertificateRequests(
        processedParams,
        allCertParameters,
        caProvider,
        veContextKey,
      );

      // Start ProxmoxExecution
      const inputs = processedParams.map((p) => ({
        id: p.id,
        value: p.value,
      }));

      // Note: previous versions auto-injected the request's userAccessToken
      // as ZITADEL_PAT for addon-oidc apps. That was fundamentally broken:
      // both browser-session tokens and CLI client_credentials JWTs are issued
      // with audience=<proxvex_project_id>, but the Zitadel Management API
      // (which conf-setup-oidc-client.sh hits to create per-app OIDC clients)
      // requires audience=zitadel_iam_project — resulting in
      // "Errors.Token.Invalid (AUTH-7fs1e)" against any production deployer
      // running with addon-oidc enforced. Operator overrides via
      // production/.env (OCI_DEPLOYER_PAT → deploy.sh's augment_params)
      // continue to fill ZITADEL_PAT explicitly when needed; bearer
      // acquisition for headless flows otherwise falls through tier 2/3 in
      // conf-setup-oidc-client.sh (admin-client.pat from /bootstrap on the
      // Zitadel LXC, then DEPLOYER_OIDC_MACHINE_* once Phase 2 grants
      // deployer-cli the IAM-org audience needed for Management API).

      // E.8: if this is a clone-side handler for an orchestrated self-upgrade,
      // the Hub passed its outer restartKey in the body. Use it so the Clone's
      // entire pipeline runs under the Hub's key — one bundle, one stream,
      // one source of truth for the orchestrated task.
      // Flag name kept in sync with ORCHESTRATED_FLAG in
      // services/self-upgrade-orchestrator.mts (string-only here to avoid
      // pulling that module into the route-handler import graph).
      const orchestratedBody = body as { _orchestrated_via_clone?: boolean; outer_restart_key?: string };
      const restartKeyOverride =
        orchestratedBody._orchestrated_via_clone === true && orchestratedBody.outer_restart_key
          ? orchestratedBody.outer_restart_key
          : undefined;
      const { exec, restartKey } = this.executionSetup.setupExecution(
        commands,
        inputs,
        defaults,
        veCtxToUse,
        this.messageManager,
        this.restartManager,
        application,
        task,
        sshCommand,
        loaded.processedTemplates,
        this.debugCollector,
        this.appLogMonitor,
        restartKeyOverride,
      );

      // Persist shared_volpath per VE context whenever it appears in outputs
      exec.on("finished", (msg: import("@src/backend-types.mjs").IVMContext) => {
        const sharedVolpath = msg.outputs?.shared_volpath;
        if (sharedVolpath && typeof sharedVolpath === "string") {
          const caService = new CertificateAuthorityService(storageContext);
          caService.setSharedVolpath(veContextKey, sharedVolpath);
        }
      });

      // Respond immediately with restartKey, run execution in background
      const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(
        body.params,
      );
      this.executionSetup.setupExecutionResultHandlers(
        exec,
        restartKey,
        this.restartManager,
        fallbackRestartInfo,
        // Collect provides_* outputs and write to stack after execution
        async (completedExec) => {
          await this.collectAndStoreProvides(completedExec, allStackIds, application, storageContext);
        },
        // Release the per-hostname lock once the background execution settles
        // (success OR failure). The pipeline runs for minutes; holding the lock
        // for its whole lifetime is exactly the point — a parallel task on the
        // same hostname stays blocked until this one is done.
        () => {
          if (lockKey) this.activeHostnameTasks.delete(lockKey);
        },
      );

      // Hand lock ownership to the background execution above; the method-level
      // finally must NOT release it on this synchronous return.
      lockReleaseDeferred = true;
      return {
        success: true,
        restartKey,
      };
    } catch (err: any) {
      return this.buildErrorResult(err);
    } finally {
      // Release the hostname lock on every exit the background execution did
      // NOT take ownership of: early errors, the self-upgrade orchestration
      // returns, and any throw. Skipped when lockReleaseDeferred is set (the
      // regular path handed release to onSettled, or this was a 409 rejection
      // that must not touch the foreign lock).
      if (!lockReleaseDeferred && lockKey) {
        this.activeHostnameTasks.delete(lockKey);
      }
    }
  }


  /**
   * Handles GET /api/ve/execute/:veContext
   *
   * `restartKey` (when provided) filters to the single message-group that
   * belongs to this CLI invocation. Without it, parallel CLI processes (one
   * per livetest scenario under `--parallel`) all see the union of every
   * deploy's messages on the same VE host → each one sees foreign errors,
   * reports `Execution failed at step 'Failed' (exit 1)`, and the run gets
   * phantom failures. (Confirmed via livetest β: postgres/mtls,
   * postgrest/default, zitadel/default, test-proxvex-deployer/default all
   * reported byte-identical stderr containing zitadel-login compose-up logs.)
   */
  handleGetMessages(veContext: IVEContext, since?: number, restartKey?: string): IVeExecuteMessagesResponse {
    // Filter by restartKey first (per-CLI isolation under --parallel).
    const baseGroups = restartKey
      ? this.messageManager.messages.filter((g) => g.restartKey === restartKey)
      : this.messageManager.messages;
    // Add vmInstallKey to each message group if it exists
    const messages = baseGroups.map((group) => {
      // If vmInstallKey is already set, keep it
      if (group.vmInstallKey) {
        return group;
      }
      // Try to find vmInstallContext by looking up VE contexts
      const contextManager =
        this.pm.getContextManager();

      const vmInstallContext =
        contextManager.getVMInstallContextByHostnameAndApplication(
          veContext.host,
          group.application,
        );
      if (vmInstallContext) {
        const vmInstallKey = `vminstall_${veContext.host}_${group.application}`;
        // Update the group with vmInstallKey
        group.vmInstallKey = vmInstallKey;
      }

      return group;
    });

    // Delta-polling: if since is provided, only return messages with index > since
    if (since !== undefined && !isNaN(since)) {
      return messages.map(group => ({
        ...group,
        messages: group.messages.filter(m => m.index !== undefined && m.index > since),
      }));
    }
    return messages;
  }

  /**
   * Handles POST /api/ve/restart/:restartKey/:veContext
   */
  async handleVeRestart(
    restartKey: string,
    veContextKey: string,
  ): Promise<{
    success: boolean;
    restartKey?: string;
    vmInstallKey?: string;
    error?: string;
    errorDetails?: IJsonError;
    statusCode?: number;
  }> {
    const restartInfo = this.restartManager.getRestartInfo(restartKey);
    if (!restartInfo) {
      return {
        success: false,
        error: "Restart info not found",
        statusCode: 404,
      };
    }

    const contextManager = this.pm.getContextManager();
    const ctx = contextManager.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get application/task from the message group that has this restartKey
    const messageGroup =
      this.messageManager.findMessageGroupByRestartKey(restartKey);
    if (!messageGroup) {
      return {
        success: false,
        error: "No message group found for this restart key",
        statusCode: 404,
      };
    }

    const { application, task } = messageGroup;
    const veCtxToUse = ctx as IVEContext;

    const executionMode = determineExecutionMode();
    const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";

    // Reload application to get commands
    const templateProcessor = veCtxToUse
      .getStorageContext()
      .getTemplateProcessor();
    let loaded;
    try {
      // Use parameters from restartInfo.inputs for skip_if_all_missing checks
      const initialInputs = restartInfo.inputs
        .filter(
          (p) => p.value !== null && p.value !== undefined && p.value !== "",
        )
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        executionMode,
        initialInputs,
      );
    } catch (err: any) {
      return this.buildErrorResult(err);
    }
    const commands = loaded.commands;
    const defaults = this.parameterProcessor.buildDefaults(
      loaded.parameters,
      loaded.propertyDefaults,
    );

    // Process parameters from restartInfo.inputs
    const paramsFromRestartInfo = restartInfo.inputs.map((p) => ({
      name: p.name,
      value: p.value,
    }));

    const processedParams = await this.parameterProcessor.processParameters(
      paramsFromRestartInfo,
      loaded.parameters,
      this.pm.getContextManager(),
    );

    const inputs = processedParams.map((p) => ({
      id: p.id,
      value: p.value,
    }));

    // Create execution with reloaded commands but use restartInfo for state
    const { exec, restartKey: newRestartKey } =
      this.executionSetup.setupExecution(
        commands,
        inputs,
        defaults,
        veCtxToUse,
        this.messageManager,
        this.restartManager,
        application,
        task,
        sshCommand,
        loaded.processedTemplates,
        this.debugCollector,
        this.appLogMonitor,
      );

    this.executionSetup.setupRestartExecutionResultHandlers(
      exec,
      newRestartKey,
      restartInfo,
      this.restartManager,
    );

    // Try to find vmInstallContext for this installation to return vmInstallKey
    const hostname =
      typeof veCtxToUse.host === "string"
        ? veCtxToUse.host
        : (veCtxToUse.host as any)?.host || "unknown";
    const vmInstallContext =
      contextManager.getVMInstallContextByHostnameAndApplication(
        hostname,
        application,
      );
    const vmInstallKey = vmInstallContext
      ? `vminstall_${hostname}_${application}`
      : undefined;

    return {
      success: true,
      restartKey: newRestartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }

  /**
   * Handles POST /api/ve/restart-installation/:vmInstallKey/:veContext
   * Restarts an installation from scratch using the vmInstallContext.
   */
  async handleVeRestartInstallation(
    vmInstallKey: string,
    veContextKey: string,
  ): Promise<{
    success: boolean;
    restartKey?: string;
    vmInstallKey?: string;
    error?: string;
    errorDetails?: IJsonError;
    statusCode?: number;
  }> {
    const contextManager = this.pm.getContextManager();
    const ctx = contextManager.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get vmInstallContext
    const vmInstallContextValue =
      contextManager.getVMInstallContextByVmInstallKey(vmInstallKey);
    if (
      !vmInstallContextValue ||
      !(vmInstallContextValue instanceof VMInstallContext)
    ) {
      return {
        success: false,
        error: "VM install context not found",
        statusCode: 404,
      };
    }

    const installCtx = vmInstallContextValue as IVMInstallContext;
    const veCtxToUse = ctx as IVEContext;
    const templateProcessor = veCtxToUse
      .getStorageContext()
      .getTemplateProcessor();

    const executionMode = determineExecutionMode();
    const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";

    // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
    const initialInputs = installCtx.changedParams
      .filter(
        (p) => p.value !== null && p.value !== undefined && p.value !== "",
      )
      .map((p) => ({
        id: p.name,
        value: p.value,
      }));

    // Load application to get commands (with initialInputs for skip_if_all_missing checks)
    let loaded;
    try {
      loaded = await templateProcessor.loadApplication(
        installCtx.application,
        installCtx.task,
        veCtxToUse,
        executionMode,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
      );
    } catch (err: any) {
      return this.buildErrorResult(err);
    }
    const commands = loaded.commands;
    const defaults = this.parameterProcessor.buildDefaults(
      loaded.parameters,
      loaded.propertyDefaults,
    );

    // Use changedParams from vmInstallContext as inputs
    const processedParams = await this.parameterProcessor.processParameters(
      installCtx.changedParams,
      loaded.parameters,
      this.pm.getContextManager(),
    );

    const inputs = processedParams.map((p) => ({
      id: p.id,
      value: p.value,
    }));

    const { exec, restartKey } = this.executionSetup.setupExecution(
      commands,
      inputs,
      defaults,
      veCtxToUse,
      this.messageManager,
      this.restartManager,
      installCtx.application,
      installCtx.task,
      sshCommand,
      loaded.processedTemplates,
      this.debugCollector,
      this.appLogMonitor,
    );

    // Respond immediately with restartKey, run execution in background
    const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(
      installCtx.changedParams,
    );
    this.executionSetup.setupExecutionResultHandlers(
      exec,
      restartKey,
      this.restartManager,
      fallbackRestartInfo,
    );

    // Set vmInstallKey in message group if it exists
    if (vmInstallKey) {
      this.messageManager.setVmInstallKeyForGroup(
        installCtx.application,
        installCtx.task,
        vmInstallKey,
      );
    }

    return {
      success: true,
      restartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }
}

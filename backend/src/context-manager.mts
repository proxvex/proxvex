import { JsonValidator } from "./jsonvalidator.mjs";
import {
  IConfiguredPathes,
  IContext,
  IVEContext,
  IVMContext,
  IVMInstallContext,
  storageKey as storageContextKey,
} from "./backend-types.mjs";
import { TemplateProcessor } from "./templates/templateprocessor.mjs";
import { ISsh, TaskType, IStack, IStackEntry, IStackProvides } from "./types.mjs";
import { Context } from "./context.mjs";
import { Ssh } from "./ssh.mjs";
import {
  IApplicationPersistence,
  ITemplatePersistence,
} from "./persistence/interfaces.mjs";

export class VMContext implements IVMContext {
  vmid: number;
  vekey: string;
  outputs: Record<string, string | number | boolean>;
  constructor(data: IVMContext) {
    this.vmid = data.vmid;
    this.vekey = data.vekey;
    this.outputs = data.outputs || {};
  }
  getKey(): string {
    return `vm_${this.vmid}`;
  }
}

export class VMInstallContext implements IVMInstallContext {
  constructor(data: IVMInstallContext) {
    this.hostname = data.hostname;
    this.application = data.application;
    this.task = data.task;
    this.changedParams = data.changedParams;
  }
  public hostname: string;
  public application: string;
  public task: TaskType;
  public changedParams: Array<{
    name: string;
    value: string | number | boolean;
  }>;
  getKey(): string {
    return `vminstall_${this.hostname}_${this.application}`;
  }
}

export class StackContext implements IStack {
  id: string;
  name: string;
  stacktype: string | string[];
  entries: IStackEntry[];
  provides?: IStackProvides[] | undefined;
  dirty?: boolean | undefined;

  constructor(data: IStack) {
    this.id = data.id;
    this.name = data.name;
    this.stacktype = data.stacktype;
    this.entries = data.entries || [];
    this.provides = data.provides;
    if (data.dirty !== undefined) this.dirty = data.dirty;
  }

  getKey(): string {
    return `stack_${this.id}`;
  }
}

class VEContext implements IVEContext {
  host: string;
  port?: number;
  current?: boolean;
  isHub?: boolean;
  hubApiUrl?: string;
  hubCaFingerprint?: string;
  private contextManager: ContextManager;
  constructor(data: ISsh, contextManager: ContextManager) {
    this.host = data.host;
    if (data.port !== undefined) this.port = data.port;
    if (data.current !== undefined) this.current = data.current;
    if (data.isHub !== undefined) this.isHub = data.isHub;
    if (data.hubApiUrl !== undefined) this.hubApiUrl = data.hubApiUrl;
    if (data.hubCaFingerprint !== undefined)
      this.hubCaFingerprint = data.hubCaFingerprint;
    this.contextManager = contextManager;
  }
  getStorageContext(): ContextManager {
    return this.contextManager;
  }
  getKey(): string {
    return `ve_${this.host}`;
  }
  toJSON(): object {
    return {
      host: this.host,
      port: this.port,
      current: this.current,
      isHub: this.isHub,
      hubApiUrl: this.hubApiUrl,
      hubCaFingerprint: this.hubCaFingerprint,
    };
  }
}

/**
 * Manages execution contexts (VE, VM, VMInstall) for LXC operations
 * - VEContext: Virtual Environment (Proxmox host) connections
 * - VMContext: Virtual Machine information
 * - VMInstallContext: VM installation state
 *
 * Renamed from StorageContext to better reflect its purpose:
 * It manages execution contexts, not storage/entities.
 *
 * No longer a singleton - managed by PersistenceManager
 */
export class ContextManager extends Context implements IContext {
  private pathes: IConfiguredPathes;
  jsonValidator: JsonValidator;
  private persistence: IApplicationPersistence & ITemplatePersistence;

  // In-memory only maps for vm_* and vminstall_* (not persisted to storagecontext.json)
  private vmContexts = new Map<string, VMContext>();
  private vmInstallContexts = new Map<string, VMInstallContext>();

  constructor(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
    pathes: IConfiguredPathes,
    jsonValidator: JsonValidator,
    persistence: IApplicationPersistence & ITemplatePersistence,
  ) {
    super(storageContextFilePath, secretFilePath);
    this.pathes = pathes;
    this.jsonValidator = jsonValidator;
    this.persistence = persistence;
    // vm_* and vminstall_* are no longer loaded from disk — they are in-memory only.
    // Remove any stale vm_*/vminstall_* entries that may still exist in the persisted file.
    this.purgeStaleEntries();
    // VEContext needs ContextManager reference
    // We need to manually load VE contexts since loadContexts doesn't support factory functions
    // Access protected context via keys() and get() methods
    const savedKeys = this.keys().filter((k) => k.startsWith("ve_"));
    for (const key of savedKeys) {
      const value = this.get(key);
      if (value) {
        const instance = new VEContext(value, this);
        // Update in-memory cache
        this.set(key, instance);
      }
    }
    this.loadContexts("stack", StackContext);
  }

  /**
   * Remove stale vm_* and vminstall_* entries from persisted storage.
   * These are now in-memory only and should not be written to disk.
   */
  private purgeStaleEntries(): void {
    for (const key of this.keys()) {
      if (key.startsWith("vm_") || key.startsWith("vminstall_")) {
        this.remove(key);
      }
    }
  }
  getLocalPath(): string {
    return this.pathes.localPath;
  }

  getJsonPath(): string {
    return this.pathes.jsonPath;
  }

  getSchemaPath(): string {
    return this.pathes.schemaPath;
  }

  getKey(): string {
    return storageContextKey;
  }

  getJsonValidator(): JsonValidator {
    return this.jsonValidator;
  }

  getTemplateProcessor(): TemplateProcessor {
    return new TemplateProcessor(this.pathes, this, this.persistence);
  }
  getCurrentVEContext(): IVEContext | null {
    for (const ctx of this.keys()
      .filter((k) => k.startsWith("ve_"))
      .map((k) => this.get(k))) {
      if (ctx instanceof VEContext && (ctx as IVEContext).current === true) {
        return ctx;
      }
    }
    return null;
  }
  setVMContext(vmContext: IVMContext): string {
    const key = `vm_${vmContext.vmid}`;
    const ctx = new VMContext(vmContext);
    this.vmContexts.set(key, ctx);
    return key;
  }
  setVEContext(veContext: ISsh): string {
    const key = `ve_${veContext.host}`;
    this.set(key, new VEContext(veContext, this));
    return key;
  }
  setVMInstallContext(vmInstallContext: IVMInstallContext): string {
    const vmInstall = new VMInstallContext(vmInstallContext);
    const key = vmInstall.getKey();
    this.vmInstallContexts.set(key, vmInstall);
    return key;
  }

  getVEContextByKey(key: string): IVEContext | null {
    const value = this.get(key);
    if (value instanceof VEContext) return value as IVEContext;
    return null;
  }

  /** Find a VMContext by hostname stored inside its data (in-memory only) */
  getVMContextByHostname(hostname: string): IVMContext | null {
    for (const vm of this.vmContexts.values()) {
      const h = vm.outputs.hostname;
      if (typeof h === "string" && h === hostname) {
        return vm;
      }
    }
    return null;
  }

  /** Find a VMInstallContext by hostname and application (in-memory only) */
  getVMInstallContextByHostnameAndApplication(
    hostname: string,
    application: string,
  ): IVMInstallContext | null {
    const key = `vminstall_${hostname}_${application}`;
    return this.vmInstallContexts.get(key) ?? null;
  }

  /** Find a VMInstallContext by vmInstallKey (in-memory only) */
  getVMInstallContextByVmInstallKey(
    vmInstallKey: string,
  ): IVMInstallContext | null {
    return this.vmInstallContexts.get(vmInstallKey) ?? null;
  }

  // Stack methods
  addStack(stack: IStack): string {
    const ctx = new StackContext(stack);
    this.set(ctx.getKey(), ctx);
    return ctx.getKey();
  }

  getStack(id: string): IStack | null {
    // Try direct key lookup: id may be the full id (e.g. "postgres_production")
    // or prefixed with "stack_" (e.g. "stack_postgres_production")
    const key = id.startsWith("stack_") ? id : `stack_${id}`;
    const value = this.get(key);
    if (value instanceof StackContext) return value;
    // Fallback: search by id across all stacks (not by name — use stackId consistently)
    for (const k of this.keys().filter((k) => k.startsWith("stack_"))) {
      const v = this.get(k);
      if (v instanceof StackContext && v.id === id) return v;
    }
    return null;
  }

  listStacks(stacktype?: string): IStack[] {
    const stacks: IStack[] = [];
    for (const key of this.keys().filter((k) => k.startsWith("stack_"))) {
      const value = this.get(key);
      if (value instanceof StackContext) {
        const types = Array.isArray(value.stacktype) ? value.stacktype : [value.stacktype];
        if (!stacktype || types.includes(stacktype)) {
          stacks.push(value);
        }
      }
    }
    return stacks;
  }

  deleteStack(id: string): boolean {
    // Try direct key lookup
    const key = id.startsWith("stack_") ? id : `stack_${id}`;
    if (this.has(key)) {
      this.remove(key);
      return true;
    }
    // Fallback: search by id across all stacks (not by name)
    for (const k of this.keys().filter((k) => k.startsWith("stack_"))) {
      const v = this.get(k);
      if (v instanceof StackContext && v.id === id) {
        this.remove(k);
        return true;
      }
    }
    return false;
  }

  /** Build ISsh descriptors for all VE contexts using current storage */
  listSshConfigs(): ISsh[] {
    const result: ISsh[] = [];
    const pubCmd = Ssh.getPublicKeyCommand();
    for (const key of this.keys().filter((k) => k.startsWith("ve_"))) {
      const anyCtx: any = this.get(key);
      if (anyCtx && typeof anyCtx.host === "string") {
        const item: ISsh = { host: anyCtx.host } as ISsh;
        if (typeof anyCtx.port === "number") item.port = anyCtx.port;
        if (typeof anyCtx.current === "boolean") item.current = anyCtx.current;
        if (typeof anyCtx.isHub === "boolean") item.isHub = anyCtx.isHub;
        if (typeof anyCtx.hubApiUrl === "string") item.hubApiUrl = anyCtx.hubApiUrl;
        if (typeof anyCtx.hubCaFingerprint === "string")
          item.hubCaFingerprint = anyCtx.hubCaFingerprint;
        if (pubCmd) item.publicKeyCommand = pubCmd;
        // Nur für den aktuellen SSH-Context eine kurze Prüfung
        if (item.current === true) {
          const perm = Ssh.checkSshPermission(item.host, item.port);
          item.permissionOk = perm.permissionOk;
          if (perm.stderr) (item as any).stderr = perm.stderr;
          const stderr = (perm.stderr || "").toLowerCase();
          const portListening =
            perm.permissionOk ||
            (!stderr.includes("connection refused") &&
              !stderr.includes("no route to host") &&
              !stderr.includes("operation timed out") &&
              !stderr.includes("timed out"));
          if (!portListening) {
            item.installSshServer = Ssh.getInstallSshServerCommand();
          }
        }
        result.push(item);
      }
    }
    return result;
  }

  /** Build an ISsh descriptor from the current VE context in ContextManager */
  getCurrentSsh(): ISsh | null {
    const ctx = this.getCurrentVEContext();
    if (!ctx) return null;
    const pub = Ssh.getPublicKeyCommand();
    const install = Ssh.getInstallSshServerCommand();
    const base: ISsh = { host: ctx.host } as ISsh;
    if (typeof ctx.port === "number") base.port = ctx.port;
    if (typeof ctx.current === "boolean") base.current = ctx.current;
    if (pub) base.publicKeyCommand = pub;
    base.installSshServer = install;
    const perm = Ssh.checkSshPermission(base.host, base.port);
    base.permissionOk = perm.permissionOk;
    if ((perm as any).stderr) (base as any).stderr = (perm as any).stderr;
    return base;
  }
}

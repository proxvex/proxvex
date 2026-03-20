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

  constructor(data: IStack) {
    this.id = data.id;
    this.name = data.name;
    this.stacktype = data.stacktype;
    this.entries = data.entries || [];
    this.provides = data.provides;
  }

  getKey(): string {
    return `stack_${this.name}`;
  }
}

class VEContext implements IVEContext {
  host: string;
  port?: number;
  current?: boolean;
  private contextManager: ContextManager;
  constructor(data: ISsh, contextManager: ContextManager) {
    this.host = data.host;
    if (data.port !== undefined) this.port = data.port;
    if (data.current !== undefined) this.current = data.current;
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
    this.loadContexts("vm", VMContext);
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
    this.loadContexts("vminstall", VMInstallContext);
    this.loadContexts("stack", StackContext);
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
    // Verify that the VE context referenced by vekey exists
    const veContext = this.getVEContextByKey(vmContext.vekey);
    if (!veContext) {
      throw new Error(
        `VE context not found for key: ${vmContext.vekey}. Please set the VE context using setVEContext() before setting the VM context.`,
      );
    }

    const key = `vm_${vmContext.vmid}`;
    this.set(key, new VMContext(vmContext));
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
    this.set(key, vmInstall);
    return key;
  }

  getVEContextByKey(key: string): IVEContext | null {
    const value = this.get(key);
    if (value instanceof VEContext) return value as IVEContext;
    return null;
  }

  /** Find a VMContext by hostname stored inside its data */
  getVMContextByHostname(hostname: string): IVMContext | null {
    for (const key of this.keys().filter((k) => k.startsWith("vm_"))) {
      const value = this.get(key);
      if (value instanceof VMContext) {
        const vm = value as VMContext;
        const h = vm.outputs.hostname;
        if (typeof h === "string" && h === hostname) {
          return vm as IVMContext;
        }
      }
    }
    return null;
  }

  /** Find a VMInstallContext by hostname and application */
  getVMInstallContextByHostnameAndApplication(
    hostname: string,
    application: string,
  ): IVMInstallContext | null {
    const key = `vminstall_${hostname}_${application}`;
    const value = this.get(key);
    if (value instanceof VMInstallContext) {
      return value as IVMInstallContext;
    }
    return null;
  }

  /** Find a VMInstallContext by vmInstallKey (format: vminstall_${hostname}_${application}) */
  getVMInstallContextByVmInstallKey(
    vmInstallKey: string,
  ): IVMInstallContext | null {
    const value = this.get(vmInstallKey);
    if (value instanceof VMInstallContext) {
      return value as IVMInstallContext;
    }
    return null;
  }

  // Stack methods
  addStack(stack: IStack): string {
    const ctx = new StackContext(stack);
    this.set(ctx.getKey(), ctx);
    return ctx.getKey();
  }

  getStack(id: string): IStack | null {
    // id is "stack_<name>" or just the name
    const key = id.startsWith("stack_") ? id : `stack_${id}`;
    const value = this.get(key);
    if (value instanceof StackContext) return value;
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
    const key = id.startsWith("stack_") ? id : `stack_${id}`;
    if (this.has(key)) {
      this.remove(key);
      return true;
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

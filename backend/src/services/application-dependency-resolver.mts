import { IStacktypeDependency } from "../types.mjs";

/**
 * Source of dependency data. Implementations resolve names to definitions
 * without doing any I/O outside the call (so the resolver itself stays sync
 * and pure for the inputs it sees).
 */
export interface IDependencyDataSource {
  /** Application config: needed for `dependencies` and `stacktype` fields. */
  getApplication(
    name: string,
  ): { dependencies?: IStacktypeDependency[]; stacktype?: string | string[] } | null;
  /** Stacktype config: needed for its `dependencies` field. */
  getStacktype(
    name: string,
  ): { dependencies?: IStacktypeDependency[] } | null;
  /** Addon config: needed for `stacktype` and `dependencies` fields. */
  getAddon(
    id: string,
  ): { stacktype?: string | string[]; dependencies?: IStacktypeDependency[] } | null;
  /** Stack config: needed to map a stack id to its stacktype(s). */
  getStack(id: string): { stacktype?: string | string[] } | null;
}

export interface IResolvedDependency {
  /** App-ID of the dependency. */
  application: string;
  /** Origin: "application" | "stacktype:<name>" | "<addon-id>". */
  source: string;
  /**
   * Stacktype that connects consumer to this dep (if any). For
   *   - `source = "application"`: the stacktype the consumer and dep both declare
   *   - `source = "stacktype:<name>"`: that stacktype name
   *   - `source = "<addon-id>"`: the addon's own stacktype
   */
  stacktype: string | null;
  /**
   * Stack id from the caller's `selectedStackIds` whose stacktype matches
   * this dep's `stacktype`. Used downstream to filter candidate containers
   * to a specific stack instance.
   */
  expectedStackId: string | null;
}

export interface IResolveOptions {
  /**
   * If false, skips the consumer-app's own `dependencies` array. Used by the
   * livetest scenario auto-derive path which intentionally only considers
   * stacktype and addon dependencies. Defaults to true.
   */
  includeAppDeps?: boolean;
}

/**
 * Single source of truth for the question "given (application, addons,
 * stacks), which other applications must already be running?". Replaces
 * three near-duplicate inline implementations across `webapp-ve-route-handlers`,
 * `webapp-dependency-check-routes`, and the livetest scenario auto-derive
 * path.
 *
 * Pure with respect to its inputs — all I/O lives behind the data source.
 * The resolver dedups by `application` (first source wins), tags each entry
 * with where it came from, and pre-computes the expected stack id for the
 * caller so the downstream "is it actually running?" check has everything
 * it needs.
 */
export class ApplicationDependencyResolver {
  constructor(private source: IDependencyDataSource) {}

  resolve(
    application: string,
    selectedAddons: string[],
    selectedStackIds: string[],
    options: IResolveOptions = {},
  ): IResolvedDependency[] {
    const includeAppDeps = options.includeAppDeps !== false;
    const result: IResolvedDependency[] = [];
    const seen = new Set<string>();

    const stackIdByType = this.buildStackIdByType(selectedStackIds);
    const consumer = this.source.getApplication(application);
    const consumerStacktypes = toArray(consumer?.stacktype);

    const add = (depApp: string, src: string, stacktype: string | null): void => {
      if (depApp === application || seen.has(depApp)) return;
      seen.add(depApp);
      result.push({
        application: depApp,
        source: src,
        stacktype,
        expectedStackId: stacktype ? (stackIdByType[stacktype] ?? null) : null,
      });
    };

    if (includeAppDeps && consumer?.dependencies) {
      for (const dep of consumer.dependencies) {
        const sharedStacktype = this.findSharedStacktype(consumerStacktypes, dep.application);
        add(dep.application, "application", sharedStacktype);
      }
    }

    for (const stName of consumerStacktypes) {
      const st = this.source.getStacktype(stName);
      if (!st?.dependencies) continue;
      for (const dep of st.dependencies) {
        add(dep.application, `stacktype:${stName}`, stName);
      }
    }

    for (const addonId of new Set(selectedAddons)) {
      const addon = this.source.getAddon(addonId);
      if (!addon?.dependencies) continue;
      const addonStacktype = toArray(addon.stacktype)[0] ?? null;
      for (const dep of addon.dependencies) {
        add(dep.application, addonId, addonStacktype);
      }
    }

    return result;
  }

  private buildStackIdByType(selectedStackIds: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const sid of selectedStackIds) {
      const stack = this.source.getStack(sid);
      if (!stack?.stacktype) continue;
      for (const t of toArray(stack.stacktype)) {
        if (t && !result[t]) result[t] = sid;
      }
    }
    return result;
  }

  private findSharedStacktype(
    consumerStacktypes: string[],
    depApp: string,
  ): string | null {
    if (consumerStacktypes.length === 0) return null;
    const dep = this.source.getApplication(depApp);
    const depTypes = toArray(dep?.stacktype);
    for (const t of consumerStacktypes) {
      if (depTypes.includes(t)) return t;
    }
    return null;
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

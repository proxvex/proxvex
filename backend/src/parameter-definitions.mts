import fs from "fs";
import path from "path";
import { IParameter } from "./types.mjs";

/**
 * Loads json/shared/parameter-definitions.json — the canonical definition
 * for every parameter ID referenced from templates / addons / applications.
 *
 * Templates carry only `parameters: string[]` (a list of IDs); the registry
 * expands them into full IParameter objects so downstream code keeps the
 * shape it had before the migration.
 *
 * Bootstrap files (parameter-definitions.json itself, addon files written
 * before the registry exists) may still ship inline IParameter objects;
 * `expand` accepts either form.
 */
export class ParameterDefinitionsRegistry {
  private byId = new Map<string, IParameter>();
  private loaded = false;
  private filePath: string;
  private mtime = 0;

  constructor(jsonPath: string) {
    this.filePath = path.join(jsonPath, "shared", "parameter-definitions.json");
  }

  /** Load the registry once. Re-reads from disk if the file's mtime changed. */
  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }
    const stat = fs.statSync(this.filePath);
    if (this.loaded && stat.mtimeMs === this.mtime) return;
    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as { parameters?: IParameter[] };
    this.byId.clear();
    if (Array.isArray(parsed.parameters)) {
      for (const p of parsed.parameters) {
        if (p && typeof p.id === "string") this.byId.set(p.id, p);
      }
    }
    this.mtime = stat.mtimeMs;
    this.loaded = true;
  }

  /** Resolve a single ID to its canonical definition (or null when unknown). */
  resolve(id: string): IParameter | null {
    this.load();
    const def = this.byId.get(id);
    return def ? { ...def } : null;
  }

  /** Returns the list of all known IDs. Useful for validation. */
  getAllIds(): string[] {
    this.load();
    return [...this.byId.keys()];
  }

  /**
   * Expand a parameters[] array into full IParameter[].
   *   - string entries: looked up in the registry; missing IDs throw.
   *   - object entries: passed through as-is (legacy / migration window).
   */
  expand(params: unknown): IParameter[] {
    if (!Array.isArray(params)) return [];
    this.load();
    const out: IParameter[] = [];
    for (const entry of params) {
      if (typeof entry === "string") {
        const def = this.byId.get(entry);
        if (!def) {
          throw new Error(
            `Unknown parameter id "${entry}". Add it to json/shared/parameter-definitions.json.`,
          );
        }
        out.push({ ...def });
      } else if (entry && typeof entry === "object" && typeof (entry as IParameter).id === "string") {
        // Legacy inline definition — honour as-is so transitional files keep working.
        out.push(entry as IParameter);
      } else {
        throw new Error(
          `Invalid parameter entry: expected string id or object with id, got ${JSON.stringify(entry)}`,
        );
      }
    }
    return out;
  }
}

let cached: ParameterDefinitionsRegistry | null = null;
let cachedJsonPath: string | null = null;

/**
 * Returns a process-wide registry instance for the given jsonPath.
 * Re-creates the registry if jsonPath differs from the previous call
 * (e.g. test setup with a temporary directory).
 */
export function getParameterDefinitionsRegistry(jsonPath: string): ParameterDefinitionsRegistry {
  if (!cached || cachedJsonPath !== jsonPath) {
    cached = new ParameterDefinitionsRegistry(jsonPath);
    cachedJsonPath = jsonPath;
  }
  return cached;
}

/** Test helper: reset the cached registry. */
export function resetParameterDefinitionsRegistry(): void {
  cached = null;
  cachedJsonPath = null;
}

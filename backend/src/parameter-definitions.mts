import fs from "fs";
import path from "path";
import { IParameter } from "./types.mjs";
import { MarkdownReader } from "./markdown-reader.mjs";

/**
 * Loads json/shared/parameter-definitions.json — the canonical definition
 * for every parameter ID referenced from templates / addons / applications.
 *
 * On-disk format is `{ parameters: { <id>: { …definition… } } }` — the id
 * lives in the object key (intrinsic uniqueness, no Custom-Keyword needed
 * for JSON-Schema validation). The registry exposes the id as part of the
 * IParameter (synthesised from the key) so consumers see the same shape
 * they had with the previous array form.
 *
 * Templates carry `parameters: string[]` (a list of IDs); `expand` looks
 * each id up in the registry and returns full IParameter objects. Inline
 * object entries are still accepted as a legacy/migration fallback.
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
    const parsed = JSON.parse(raw) as {
      parameters?: Record<string, Omit<IParameter, "id">>;
    };
    this.byId.clear();
    if (parsed.parameters && typeof parsed.parameters === "object") {
      // Read the parallel parameter-definitions.md once. Fallback path:
      // for each parameter without a JSON `description`, look up the
      // `## <id>` section. Same precedence rule as the template loader
      // (see template-validator.mts:116-138): JSON wins, MD is fallback.
      const mdPath = MarkdownReader.getMarkdownPath(this.filePath);
      const mdExists = fs.existsSync(mdPath);
      for (const [id, def] of Object.entries(parsed.parameters)) {
        if (!def || typeof def !== "object") continue;
        const merged: IParameter = { ...(def as Omit<IParameter, "id">), id };
        if (
          mdExists &&
          (typeof merged.description !== "string" || merged.description.trim() === "")
        ) {
          const section = MarkdownReader.extractSection(mdPath, id);
          if (section) merged.description = section;
        }
        this.byId.set(id, merged);
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
   * Returns the set of parameter IDs flagged `secure: true`. Used by the
   * debug-bundle path in VariableResolver to redact values of these
   * parameters in the redacted twin script.
   */
  getSecureIds(): Set<string> {
    this.load();
    const out = new Set<string>();
    for (const [id, def] of this.byId.entries()) {
      if (def.secure === true) out.add(id);
    }
    return out;
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

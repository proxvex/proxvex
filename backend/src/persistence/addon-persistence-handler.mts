import path from "path";
import fs from "fs";
import { IConfiguredPathes } from "../backend-types.mjs";
import { IAddon } from "../types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";
import { MarkdownReader } from "../markdown-reader.mjs";
import { getParameterDefinitionsRegistry } from "../parameter-definitions.mjs";

/**
 * Handles addon-specific persistence operations
 * Addons are single JSON files in json/addons/ directory
 */
export class AddonPersistenceHandler {
  // Addon Caches
  private addonIdsCache: {
    json: string[] | null;
    local: string[] | null;
  } = {
    json: null,
    local: null,
  };
  private addonCache: Map<string, { data: IAddon; mtime: number }> = new Map();

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
    private enableCache: boolean = true,
  ) {}

  /**
   * Returns all addon IDs (filenames without .json)
   * Local addons override json addons with the same name
   */
  getAddonIds(): string[] {
    if (!this.enableCache) {
      // Cache disabled: always scan fresh
      const jsonAddons = this.scanAddonsDir(this.pathes.jsonPath);
      const localAddons = this.scanAddonsDir(this.pathes.localPath);
      // Merge with local priority (use Set to dedupe)
      const allIds = new Set([...jsonAddons, ...localAddons]);
      return Array.from(allIds);
    }

    // JSON: Load once
    if (this.addonIdsCache.json === null) {
      this.addonIdsCache.json = this.scanAddonsDir(this.pathes.jsonPath);
    }

    // Local: From cache (invalidated by fs.watch)
    if (this.addonIdsCache.local === null) {
      this.addonIdsCache.local = this.scanAddonsDir(this.pathes.localPath);
    }

    // Merge with local priority
    const allIds = new Set([
      ...this.addonIdsCache.json,
      ...this.addonIdsCache.local,
    ]);
    return Array.from(allIds);
  }

  /**
   * Loads an addon by ID
   * @param addonId ID of the addon (filename without .json)
   * @returns Addon data with id populated
   * @throws Error if addon not found or invalid
   */
  loadAddon(addonId: string): IAddon {
    // Resolve path: local first, then json
    const localFile = path.join(
      this.pathes.localPath,
      "addons",
      `${addonId}.json`,
    );
    const jsonFile = path.join(
      this.pathes.jsonPath,
      "addons",
      `${addonId}.json`,
    );

    let addonFile: string;
    if (fs.existsSync(localFile)) {
      addonFile = localFile;
    } else if (fs.existsSync(jsonFile)) {
      addonFile = jsonFile;
    } else {
      throw new Error(`Addon not found: ${addonId}`);
    }

    // Check cache first
    if (this.enableCache) {
      const mtime = fs.statSync(addonFile).mtimeMs;
      const cached = this.addonCache.get(addonId);
      if (cached && cached.mtime === mtime) {
        return cached.data;
      }
    }

    // Load and validate
    const addonData = this.jsonValidator.serializeJsonFileWithSchema<IAddon>(
      addonFile,
      "addon.schema.json",
    );

    // Set ID from filename
    addonData.id = addonId;

    // Expand parameter ID references to full IParameter objects.
    if (Array.isArray((addonData as any).parameters)) {
      const registry = getParameterDefinitionsRegistry(this.pathes.jsonPath);
      (addonData as any).parameters = registry.expand((addonData as any).parameters);
    }

    // Load notice from addon markdown file (## Notice section)
    const mdPath = addonFile.replace(/\.json$/, ".md");
    const notice = MarkdownReader.extractSection(mdPath, "Notice");
    if (notice) {
      addonData.notice = notice;
    }

    // Cache the addon
    if (this.enableCache) {
      const mtime = fs.statSync(addonFile).mtimeMs;
      this.addonCache.set(addonId, { data: addonData, mtime });
    }

    return addonData;
  }

  /**
   * Returns all addons
   */
  getAllAddons(): IAddon[] {
    const addonIds = this.getAddonIds();
    const addons: IAddon[] = [];

    for (const addonId of addonIds) {
      try {
        const addon = this.loadAddon(addonId);
        addons.push(addon);
      } catch (e) {
        // Skip invalid addons, but log error
        console.error(`Failed to load addon ${addonId}:`, e);
      }
    }

    return addons;
  }

  /**
   * Invalidate addon cache for a specific addon or all
   */
  invalidateAddonCache(addonId?: string): void {
    this.addonIdsCache.local = null;
    if (addonId) {
      this.addonCache.delete(addonId);
    } else {
      this.addonCache.clear();
    }
  }

  /**
   * Invalidate all caches
   */
  invalidateAllCaches(): void {
    this.addonIdsCache.json = null;
    this.addonIdsCache.local = null;
    this.addonCache.clear();
  }

  // Helper methods

  /**
   * Scans addons directory and returns addon IDs
   */
  private scanAddonsDir(basePath: string): string[] {
    const addonsDir = path.join(basePath, "addons");

    if (!fs.existsSync(addonsDir)) return [];

    const entries = fs.readdirSync(addonsDir, { withFileTypes: true });
    const addonIds: string[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const addonId = entry.name.replace(/\.json$/, "");
        addonIds.push(addonId);
      }
    }

    return addonIds;
  }
}

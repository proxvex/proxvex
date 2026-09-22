import { watch, FSWatcher } from "fs";
import path from "path";
import fs from "fs";
import { IConfiguredPathes } from "../backend-types.mjs";
import { createLogger } from "../logger/index.mjs";

/**
 * Manages file system watchers for local directories
 * Handles fs.watch initialization and cache invalidation callbacks
 */
export class FileWatcherManager {
  private localAppsWatcher?: FSWatcher | undefined;
  private localTemplatesWatcher?: FSWatcher | undefined;
  private localFrameworksWatcher?: FSWatcher | undefined;
  private localAddonsWatcher?: FSWatcher | undefined;
  private invalidateTimeout: NodeJS.Timeout | undefined;
  private readonly DEBOUNCE_MS = 300;
  private logger = createLogger("file-watcher");

  constructor(private pathes: IConfiguredPathes) {}

  /**
   * fs.watch with an 'error' handler. Without one, a single unreadable
   * directory in the local layer (e.g. EACCES on a folder copied in as root
   * with mode 0700) emits an unhandled 'error' event and crashes the whole
   * process. A failing watcher is closed and logged; changes below that
   * directory are then only picked up after a reload/restart.
   */
  private watchSafe(
    dir: string,
    options: { recursive: boolean },
    listener: (eventType: string, filename: string | null) => void,
  ): FSWatcher | undefined {
    try {
      const watcher = watch(dir, options, listener);
      watcher.on("error", (err: NodeJS.ErrnoException) => {
        this.logger.warn(
          `File watcher for ${dir} failed (${err.code ?? err.message}${err.path ? `: ${err.path}` : ""}) — watching stopped; check permissions`,
        );
        watcher.close();
      });
      return watcher;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      this.logger.warn(
        `Could not watch ${dir} (${e.code ?? e.message}) — changes need a reload`,
      );
      return undefined;
    }
  }

  /**
   * Initialisiert fs.watch für local-Verzeichnisse
   * Node.js 20.11.0+ unterstützt rekursives Watching nativ
   */
  initWatchers(
    onApplicationChange: () => void,
    onTemplateChange: () => void,
    onFrameworkChange: () => void,
    onAddonChange?: () => void,
  ): void {
    const localAppsDir = path.join(this.pathes.localPath, "applications");
    const localTemplatesDir = path.join(
      this.pathes.localPath,
      "shared",
      "templates",
    );
    const localFrameworksDir = path.join(this.pathes.localPath, "frameworks");
    const localAddonsDir = path.join(this.pathes.localPath, "addons");

    // Watch local applications (rekursiv)
    if (fs.existsSync(localAppsDir)) {
      this.localAppsWatcher = this.watchSafe(
        localAppsDir,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (filename && this.isApplicationChange(filename)) {
            this.debouncedInvalidate(onApplicationChange);
          }
        },
      );
    }

    // Watch local shared templates (rekursiv)
    // Bei Template-Änderungen: gesamten Template-Cache invalidieren
    if (fs.existsSync(localTemplatesDir)) {
      this.localTemplatesWatcher = this.watchSafe(
        localTemplatesDir,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (filename && filename.endsWith(".json")) {
            // Template-Änderungen sind selten, invalidieren gesamten Template-Cache
            onTemplateChange();
          }
        },
      );
    }

    // Watch local frameworks (rekursiv)
    if (fs.existsSync(localFrameworksDir)) {
      this.localFrameworksWatcher = this.watchSafe(
        localFrameworksDir,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (filename && filename.endsWith(".json")) {
            onFrameworkChange();
          }
        },
      );
    }

    // Watch local addons
    if (onAddonChange && fs.existsSync(localAddonsDir)) {
      this.localAddonsWatcher = this.watchSafe(
        localAddonsDir,
        { recursive: false },
        (eventType: string, filename: string | null) => {
          if (filename && filename.endsWith(".json")) {
            onAddonChange();
          }
        },
      );
    }
  }

  /**
   * Prüft ob eine Änderung relevant für Applications ist
   */
  private isApplicationChange(filename: string): boolean {
    // Ignoriere versteckte Dateien
    if (filename.startsWith(".")) return false;

    // Relevante Änderungen:
    // - application.json
    // - icon.png/svg
    // - Verzeichnis-Änderungen (neue/gelöschte Applications)
    return (
      filename.endsWith("application.json") ||
      filename.endsWith("icon.png") ||
      filename.endsWith("icon.svg") ||
      !filename.includes(".") // Verzeichnis-Name
    );
  }

  /**
   * Debounced Invalidation für Application-Cache
   */
  private debouncedInvalidate(callback: () => void): void {
    if (this.invalidateTimeout) {
      clearTimeout(this.invalidateTimeout);
    }
    this.invalidateTimeout = setTimeout(() => {
      callback();
      this.invalidateTimeout = undefined;
    }, this.DEBOUNCE_MS);
  }

  /**
   * Cleanup beim Shutdown
   */
  close(): void {
    if (this.localAppsWatcher) {
      this.localAppsWatcher.close();
    }
    if (this.localTemplatesWatcher) {
      this.localTemplatesWatcher.close();
    }
    if (this.localFrameworksWatcher) {
      this.localFrameworksWatcher.close();
    }
    if (this.localAddonsWatcher) {
      this.localAddonsWatcher.close();
    }
    if (this.invalidateTimeout) {
      clearTimeout(this.invalidateTimeout);
    }
  }
}

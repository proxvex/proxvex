import { IConfiguredPathes } from "../backend-types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";
import {
  IApplicationPersistence,
  ITemplatePersistence,
  IFrameworkPersistence,
  IAddonPersistence,
} from "./interfaces.mjs";
import { FileWatcherManager } from "./file-watcher-manager.mjs";
import { ApplicationPersistenceHandler } from "./application-persistence-handler.mjs";
import { TemplatePersistenceHandler } from "./template-persistence-handler.mjs";
import { FrameworkPersistenceHandler } from "./framework-persistence-handler.mjs";
import { AddonPersistenceHandler } from "./addon-persistence-handler.mjs";

/**
 * File system implementation of persistence interfaces
 * Handles caching and file system operations with fs.watch
 *
 * This class delegates to specialized handlers for better organization:
 * - ApplicationPersistenceHandler: Application operations
 * - TemplatePersistenceHandler: Template operations
 * - FrameworkPersistenceHandler: Framework operations
 * - AddonPersistenceHandler: Addon operations
 * - FileWatcherManager: File watching and cache invalidation
 */
export class FileSystemPersistence
  implements
    IApplicationPersistence,
    ITemplatePersistence,
    IFrameworkPersistence,
    IAddonPersistence
{
  private fileWatcher: FileWatcherManager;
  private applicationHandler: ApplicationPersistenceHandler;
  private templateHandler: TemplatePersistenceHandler;
  private frameworkHandler: FrameworkPersistenceHandler;
  private addonHandler: AddonPersistenceHandler;

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
    private enableCache: boolean = true,
  ) {
    // Initialize handlers
    this.applicationHandler = new ApplicationPersistenceHandler(
      pathes,
      jsonValidator,
      enableCache,
    );
    this.templateHandler = new TemplatePersistenceHandler(
      pathes,
      jsonValidator,
      enableCache,
    );
    this.frameworkHandler = new FrameworkPersistenceHandler(
      pathes,
      jsonValidator,
      enableCache,
    );
    this.addonHandler = new AddonPersistenceHandler(
      pathes,
      jsonValidator,
      enableCache,
    );

    // Initialize file watcher
    this.fileWatcher = new FileWatcherManager(pathes);
    this.fileWatcher.initWatchers(
      () => this.applicationHandler.invalidateApplicationCache(),
      () => this.templateHandler.invalidateCache(),
      () => this.frameworkHandler.invalidateFrameworkCache(),
      () => this.addonHandler.invalidateAddonCache(),
    );
  }

  // IApplicationPersistence Implementation

  getAllAppNames() {
    return this.applicationHandler.getAllAppNames();
  }

  getLocalAppNames() {
    return this.applicationHandler.getLocalAppNames();
  }

  listApplicationsForFrontend() {
    return this.applicationHandler.listApplicationsForFrontend();
  }

  readApplication(applicationName: string, opts: any) {
    return this.applicationHandler.readApplication(applicationName, opts);
  }

  readApplicationFile(applicationName: string) {
    return this.applicationHandler.readApplicationFile(applicationName);
  }

  readApplicationIcon(applicationName: string) {
    return this.applicationHandler.readApplicationIcon(applicationName);
  }

  writeApplication(applicationName: string, application: any) {
    this.applicationHandler.writeApplication(applicationName, application);
  }

  deleteApplication(applicationName: string) {
    this.applicationHandler.deleteApplication(applicationName);
  }

  // ITemplatePersistence Implementation

  resolveTemplatePath(
    templateName: string,
    isShared: boolean,
    category?: string,
  ) {
    return this.templateHandler.resolveTemplatePath(
      templateName,
      isShared,
      category,
    );
  }

  loadTemplate(templatePath: string) {
    return this.templateHandler.loadTemplate(templatePath);
  }

  writeTemplate(
    templateName: string,
    template: any,
    isShared: boolean,
    appPath?: string,
    category?: string,
  ) {
    this.templateHandler.writeTemplate(
      templateName,
      template,
      isShared,
      appPath,
      category,
    );
  }

  deleteTemplate(templateName: string, isShared: boolean, category?: string) {
    this.templateHandler.deleteTemplate(templateName, isShared, category);
  }

  writeScript(
    scriptName: string,
    content: string,
    isShared: boolean,
    appPath?: string,
    category?: string,
  ) {
    this.templateHandler.writeScript(
      scriptName,
      content,
      isShared,
      appPath,
      category,
    );
  }

  // IFrameworkPersistence Implementation

  getAllFrameworkNames() {
    return this.frameworkHandler.getAllFrameworkNames();
  }

  readFramework(frameworkId: string, opts: any) {
    return this.frameworkHandler.readFramework(frameworkId, opts);
  }

  writeFramework(frameworkId: string, framework: any) {
    this.frameworkHandler.writeFramework(frameworkId, framework);
  }

  deleteFramework(frameworkId: string) {
    this.frameworkHandler.deleteFramework(frameworkId);
  }

  // IAddonPersistence Implementation

  getAddonIds() {
    return this.addonHandler.getAddonIds();
  }

  loadAddon(addonId: string) {
    return this.addonHandler.loadAddon(addonId);
  }

  getAllAddons() {
    return this.addonHandler.getAllAddons();
  }

  // IPersistence Implementation

  invalidateCache(): void {
    this.applicationHandler.invalidateAllCaches();
    this.templateHandler.invalidateCache();
    this.frameworkHandler.invalidateAllCaches();
    this.addonHandler.invalidateAllCaches();
  }

  close(): void {
    this.fileWatcher.close();
  }
}

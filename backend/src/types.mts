export interface IJsonError extends Error {
  line?: number;
  message: string;
  details: IJsonError[] | undefined;
}
export interface ISsh {
  host: string;
  port?: number;
  current?: boolean;
  publicKeyCommand?: string;
  installSshServer?: string;
  permissionOk?: boolean;
  /** When true, this host runs a Hub and the local deployer acts as its Spoke. */
  isHub?: boolean;
  /** Full URL of the Hub's HTTP(S) API (e.g. https://old-prod-hub:3443). No default. */
  hubApiUrl?: string;
  /** SHA-256 fingerprint of the Hub's TLS CA, captured on first trust (TOFU). */
  hubCaFingerprint?: string;
}
export interface IUploadFile {
  destination: string;          // Required: "volumename:path/to/file" (e.g., "config:mosquitto.conf")
  label?: string;               // Optional: Display label (default: basename of destination)
  content?: string;             // Base64 encoded file content
  required?: boolean;
  advanced?: boolean;
  certtype?: CertType;
  help?: string;                // Optional: Markdown help text or documentation URL shown during installation
}

export interface IApplicationBase {
  name: string;
  description: string;
  icon?: string | undefined;
  extends?: string;
  tags?: string[];
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  stacktype?: string | string[];
  /** Addon IDs this application supports. Merged with parent via extends. */
  supported_addons?: string[];
  /** Addon IDs preselected by default (user can deselect). */
  default_addons?: string[];
  /** Addon IDs that are always active (user cannot deselect). */
  required_addons?: string[];
  uploadfiles?: IUploadFile[];
  errors?: string[];
  /** User-configurable parameters defined directly in application.json (new approach) */
  parameters?: IParameter[];
  /** Fixed property values set by this application (same format as template command properties) */
  properties?: IOutputObject[];
  /** Override name/description of parameters defined in templates */
  parameterOverrides?: IParameterOverride[];
  verification?: IApplicationVerification | undefined;
  dependencies?: { application: string }[];
  /** Feature flags this application supports (e.g. 'serial_tty', 'docker'). Merged with parent via extends. */
  supports?: string[];
  /** Zitadel role definitions for OIDC authentication. Required when 'addon-oidc' is in supported_addons. */
  oidc_roles?: { key: string; display_name: string; group?: string }[];
  /** If true, the application is not shown in the applications list but can appear in the installed list. */
  hidden?: boolean;
  /** Declares which stack variables this application consumes and how they are refreshed. */
  stack_usage?: IStackUsage[];
}

/**
 * Declares how an application or addon consumes stack variables and how they
 * should be propagated when the stack value changes (refresh-stack task).
 */
export interface IStackUsage {
  stacktype: string;
  vars: IStackUsageVar[];
}

export type StackRefreshMethod =
  | "compose-env"
  | "lxc-config-env"
  | "on-start-env"
  | "rerun-template"
  | "manual"
  | "no-action";

export interface IStackUsageVar {
  name: string;
  replacement?: StackRefreshMethod;
  /** For replacement="compose-env": env key inside docker-compose.yml */
  compose_key?: string;
  /** For replacement="lxc-config-env": variable name written as lxc.environment.<NAME>=<VAL> */
  lxc_var_name?: string;
  /** For replacement="on-start-env": script filename in ${VOLUME_DIR}/on_start.d/ */
  script?: string;
  /** For replacement="on-start-env": shell variable name inside the script */
  script_var?: string;
  /** For replacement="rerun-template" (deprecated): template filename to rerun */
  template?: string;
  /** Human-readable explanation shown in the UI (especially for no-action / manual). */
  description?: string;
  /** Optional template that verifies the stack value matches the target system */
  check?: string;
}

export interface IApplicationVerification {
  wait_seconds?: number;
  checks?: Record<string, boolean | number | string | { enabled?: boolean; fatal?: boolean }>;
}

export interface IApplicationWeb {
  name: string;
  description: string;
  icon?: string | undefined;
  iconContent?: string | undefined;
  iconType?: string | undefined;
  id: string;
  tags?: string[] | undefined;
  source: "local" | "hub" | "json";
  framework?: string | undefined;
  extends?: string | undefined;
  stacktype?: string | string[] | undefined;
  default_addons?: string[] | undefined;
  required_addons?: string[] | undefined;
  /** Application-level property pins (value/default). The configuration
   * dialog uses these as defaults for addon parameters the application has
   * already pinned (e.g. oci-image apps pin oidc_redirect_uri to a
   * hostname-based template, satisfying addon-oidc's required-flag
   * without the user typing anything). Backend already honours this via
   * ParameterValidator.applicationParamValues — exposing it here keeps the
   * UI form in sync with what the backend will accept. */
  properties?: IOutputObject[] | undefined;
  errors?: IJsonError[];
  verification?: IApplicationVerification | undefined;
}
export type TaskType =
  | "installation"
  | "backup"
  | "restore"
  | "uninstall"
  | "update"
  | "upgrade"
  | "reconfigure"
  | "webui"
  | "addon"
  | "check"
  | "refresh-stack";
// Generated from template.schema.json
export interface IOutputObject {
  id: string;
  value?:
    | string
    | number
    | boolean
    | (
        | string
        | { name: string; value: string | number | boolean }
        | { id: string; value: string | number | boolean }
      )[];
  /** Default value for the parameter. Unlike 'value', this will show the parameter as editable in the UI. */
  default?: string | number | boolean;
  /** Override the required-flag of a parameter defined in a template. */
  required?: boolean;
}

export interface ICommand {
  name: string;
  command?: string;
  script?: string;
  /** Inline script content resolved from resources (preferred over file paths). */
  scriptContent?: string;
  library?: string;
  /** Inline library content resolved from resources (preferred over file paths). */
  libraryContent?: string;
  libraryPath?: string; // Internal: resolved full path to library file
  template?: string;
  properties?: IOutputObject | IOutputObject[];
  outputs?: ({ id: string; default?: boolean; optional?: boolean } | string)[]; // Expected outputs from this command/script
  description?: string;
  /** @internal execute_on is set internally from template.execute_on, not part of the schema */
  execute_on?: "ve" | "lxc" | "hook" | string | { where: string; uid?: boolean; gid?: boolean };
  /** When execute_on is 'hook': also run the hook once immediately after deploy (default true). */
  hook_trigger_now?: boolean;
  /** @internal category is set internally from the template's category for look-ahead skip logic */
  category?: string;
}

export interface IVeExecuteMessage {
  command: string;
  commandtext?: string;
  //commandtext: string;
  stderr: string;
  result: string | null;
  exitCode: number;
  execute_on?: string;
  error?: IJsonError | undefined;
  index?: number;
  finished?: boolean;
  partial?: boolean; // If true, this is a partial/streaming output chunk (process still running)
  kind?: "skipped"; // Set when the command was skipped because skip_if_all_missing matched. Lets consumers (debug bundle) route the message into its own scripts[] entry instead of attaching it as stderr to the previous script.
  vmId?: number; // Container VMID (available in final success message)
  redirectUrl?: string; // Redirect URL for deployer self-reconfigure (new instance URL)
  switchoverScheduled?: boolean; // true for proxvex self-upgrade: the new deployer takes over the IP, so the UI must wait longer than the default redirect countdown before navigating to redirectUrl.
  completionInfo?: ICompletionInfo; // Optional structured completion info from application
  template?: string; // Filename of the template this command was loaded from (e.g. "342-post-install-acme-renew-on-start.json")
}

export interface ICompletionInfo {
  header: string;
  details?: string;
  url?: string;
}

export type ParameterType = "string" | "number" | "boolean" | "enum";
export type IParameterValue = string | number | boolean;
export type CertType = "ca" | "ca_pub" | "server" | "fullchain";

export interface IParameter {
  id: string;
  name: string;
  type: ParameterType;
  description?: string;
  multiline?: boolean;
  required?: boolean;
  secure?: boolean;
  advanced?: boolean;
  /** Internal parameter — never rendered in the UI. Set by backend, app properties, or addons. */
  internal?: boolean;
  /** Marks parameters typically set once globally per project (DNS, mirrors, registry credentials, …). Pure documentation hint, no runtime effect. */
  project?: boolean;
  /**
   * Restricts UI visibility to the listed tasks. When unset the parameter is
   * visible for every task. Use `["installation"]` for fields that are set
   * once at install and inherited unchanged on reconfigure/upgrade.
   */
  tasks?: string[];
  upload?: boolean;
  certtype?: CertType;
  default?: string | number | boolean;
  enumValues?: (string | { name: string; value: string | number | boolean })[];
  enumValuesTemplate?: string;
  validatePattern?: string;
  templatename?: string;
  template?: string;
  if?: string;
}

export type ParameterTarget = 'value' | 'default' | 'install';

export interface IParameterClassification {
  id: string;
  target: ParameterTarget;
}

export interface IParameterOverride {
  id: string;
  name?: string;
  description?: string;
}

export interface ITemplate {
  execute_on?: "ve" | "lxc" | "hook" | string | { where: string; uid?: boolean; gid?: boolean };
  hook_trigger_now?: boolean;
  skip_if_all_missing?: string[];
  skip_if_property_set?: string;
  implements?: string;
  persists_container_state?: boolean;
  name: string;
  description?: string;
  parameters?: IParameter[];
  commands: ICommand[];
}
export interface IError {
  message: string;
  errors?: string[];
}

export enum ApiUri {
  SshConfigs = "/api/sshconfigs",
  SshConfig = "/api/sshconfig",
  SshConfigGET = "/api/ssh/config/:host",
  SshCheck = "/api/ssh/check",
  VeConfiguration = "/api/:veContext/ve-configuration/:application",
  VeRestart = "/api/:veContext/ve/restart/:restartKey",
  VeRestartInstallation = "/api/:veContext/ve/restart-installation/:vmInstallKey",
  VeExecute = "/api/:veContext/ve/execute",
  VeExecuteStream = "/api/:veContext/ve/execute/stream",
  /** Debug bundle manifest for a given restartKey (JSON listing the files). */
  VeDebug = "/api/ve/debug/:restartKey",
  /** Single file from a debug bundle (path may contain slashes). */
  VeDebugFile = "/api/ve/debug/:restartKey/*",
  VeLogs = "/api/:veContext/ve/logs/:vmId",
  VeLogsHostname = "/api/:veContext/ve/logs/:vmId/hostname",
  VeDockerLogs = "/api/:veContext/ve/logs/:vmId/docker",
  VeDockerServices = "/api/:veContext/ve/logs/:vmId/docker/services",
  Applications = "/api/applications",
  ApplicationTags = "/api/applications/tags",
  LocalApplicationIds = "/api/applications/local/ids",
  Installations = "/api/:veContext/installations",
  InstallationVersions = "/api/:veContext/installations/:vmId/versions",
  ContainerConfig = "/api/:veContext/container-config/:vmId",
  TemplateDetailsForApplication = "/api/:veContext/template-details/:application/:task",
  UnresolvedParameters = "/api/:veContext/unresolved-parameters/:application",
  EnumValues = "/api/:veContext/enum-values/:application",
  FrameworkNames = "/api/framework-names",
  FrameworkParameters = "/api/framework-parameters/:frameworkId",
  FrameworkCreateApplication = "/api/framework-create-application",
  FrameworkFromImage = "/api/framework-from-image",
  ApplicationFrameworkData = "/api/application/:applicationId/framework-data",
  ApplicationTestData = "/api/application/:applicationId/test-data",
  TestScenarios = "/api/test-scenarios",

  CompatibleAddons = "/api/addons/compatible/:application",
  AddonInstall = "/api/:veContext/addons/install/:addonId",
  PreviewUnresolvedParameters = "/api/:veContext/preview-unresolved-parameters",

  Stacktypes = "/api/stacktypes",
  Stacks = "/api/stacks",
  Stack = "/api/stack/:id",
  StackRefreshPreview = "/api/stack/:id/refresh-preview",
  StackRefreshApply = "/api/stack/:id/refresh",

  // Auth endpoints
  AuthConfig = "/api/auth/config",
  AuthLogin = "/api/auth/login",
  AuthLogout = "/api/auth/logout",
  AuthToken = "/api/auth/token",

  // Version / build info
  Version = "/api/version",

  // Certificate management endpoints
  CertificateStatus = "/api/:veContext/ve/certificates",
  CertificateRenew = "/api/:veContext/ve/certificates/renew",
  CertificateCa = "/api/:veContext/ve/certificates/ca",
  CertificateCaGenerate = "/api/:veContext/ve/certificates/ca/generate",
  CertificatePveStatus = "/api/:veContext/ve/certificates/pve",
  CertificatePveProvision = "/api/:veContext/ve/certificates/pve/provision",
  CertificateDomainSuffix = "/api/:veContext/ve/certificates/domain-suffix",
  CertificateCaDownload = "/api/:veContext/ve/certificates/ca/download",
  CertificateGenerate = "/api/:veContext/ve/certificates/generate",
  CertificatesAll = "/api/certificates",
  CertificateAutoRenewal = "/api/certificates/auto-renewal",
  CertificateAutoRenewalCheck = "/api/certificates/auto-renewal/check",
  CertificateRenewAll = "/api/certificates/renew-all",
  StackRestorePreview = "/api/stack/restore-preview",

  // Maintenance endpoints
  LogRotation = "/api/maintenance/log-rotation",
  LogRotationCheck = "/api/maintenance/log-rotation/check",
  ReplacedCleanup = "/api/maintenance/replaced-cleanup",
  ReplacedCleanupRun = "/api/maintenance/replaced-cleanup/run",
  ReplacedCleanupList = "/api/maintenance/replaced-cleanup/list",
  LockedCleanupList = "/api/maintenance/locked-containers/list",
  LockedCleanupDestroy = "/api/maintenance/locked-containers/destroy-all",

  // Application overview
  ApplicationOverview = "/api/application-overview/:applicationId",

  // Dependency check
  DependencyCheck = "/api/:veContext/dependency-check/:application",

  // Test queue (parallel test execution)
  TestQueueInit = "/api/test-queue/init",
  TestQueueNext = "/api/test-queue/next",
  TestQueueComplete = "/api/test-queue/complete/:app/:variant",
  TestQueueFail = "/api/test-queue/fail/:app/:variant",
  TestQueueStatus = "/api/test-queue/status",

  // Logger endpoints
  LoggerConfig = "/api/logger/config",
  LoggerLevel = "/api/logger/level/:level",
  LoggerDebugComponents = "/api/logger/debug-components",

  // Hub endpoints (always active, mTLS-protected for spoke access)
  HubCaSign = "/api/hub/ca/sign",
  HubCaCert = "/api/hub/ca/cert",
  HubStacks = "/api/hub/stacks",
  HubStack = "/api/hub/stack/:id",
  HubProject = "/api/hub/project",
  HubSpokes = "/api/hub/spokes",
  HubSpoke = "/api/hub/spoke/:id",
  HubRepositoriesTarball = "/api/hub/repositories.tar.gz",
  SpokeSync = "/api/spoke/sync",
  SpokeProbeHub = "/api/spoke/probe-hub",
}

// Tags definition interfaces
export interface ITagDefinition {
  id: string;
  name: string;
}

export interface ITagGroup {
  id: string;
  name: string;
  tags: ITagDefinition[];
}

export interface ITagsConfig {
  groups: ITagGroup[];
  internal: string[];
}

export type ITagsConfigResponse = ITagsConfig;

// Response interfaces for all backend endpoints (frontend mirror)
export interface IFrameworkPropertyInfo {
  id: string;
  isDefault: boolean;
}

export interface IUnresolvedParametersResponse {
  unresolvedParameters: IParameter[];
  addons?: IAddonWithParameters[];
  frameworkProperties?: IFrameworkPropertyInfo[];
}
export interface IEnumValuesEntry {
  id: string;
  enumValues: (string | { name: string; value: string | number | boolean })[];
  default?: string | number | boolean;
}
export interface IEnumValuesResponse {
  enumValues: IEnumValuesEntry[];
}
export interface ISshConfigsResponse {
  sshs: ISsh[];
  key?: string | undefined;
  publicKeyCommand?: string | undefined;
  installSshServer?: string | undefined;
}
export interface ISshConfigKeyResponse {
  key: string;
}
export interface ISshCheckResponse {
  permissionOk: boolean;
  stderr?: string | undefined;
}
export interface ISetSshConfigResponse {
  success: boolean;
  key?: string | undefined;
}
export interface IDeleteSshConfigResponse {
  success: boolean;
  deleted?: boolean;
  key?: string | undefined;
}
export interface IPostVeConfigurationBody {
  task: string;
  params: { name: string; value: IParameterValue }[];
  outputs?: { id: string; value: IParameterValue }[];
  changedParams?: { name: string; value: IParameterValue }[];
  selectedAddons?: string[];
  disabledAddons?: string[];
  /** Addons currently installed in the container (from notes markers). Used for delta injection. */
  installedAddons?: string[];
  stackId?: string;
  /** Multiple stack IDs when app + addons require different stacktypes */
  stackIds?: string[];
}
export interface IPostEnumValuesBody {
  task: string;
  params?: { id: string; value: IParameterValue }[];
  refresh?: boolean;
}
export interface IPostSshConfigResponse {
  success: boolean;
  key?: string;
}
export interface IPostVeConfigurationResponse {
  success: boolean;
  restartKey?: string;
  vmInstallKey?: string;
}
export type IApplicationsResponse = IApplicationWeb[];

export interface ITestScenarioResponse {
  id: string;
  application: string;
  description: string;
  depends_on?: string[];
  task?: string;
  wait_seconds?: number;
  cli_timeout?: number;
  verify?: Record<string, boolean | number | string>;
  params?: { name: string; value?: string; append?: string }[];
  selectedAddons?: string[];
  stackId?: string;
  stackIds?: string[];
  /** Override stack name (default derived from scenario variant). Set when a
   *  reconfigure-only scenario must join an existing stack (e.g. zitadel/reconf-ssl
   *  needs to share postgres_ssl + oidc_ssl with the zitadel/ssl install
   *  dependency) instead of forking a fresh `*_<variant>` stack with new
   *  auto-generated passwords. */
  stack_name?: string;
  uploads?: { name: string; content: string }[];
  cleanup?: Record<string, string>;
  /** Per-template expected failure exit codes for livetests. Keys are
   *  template filenames, values are the required non-zero exit code. */
  expect2fail?: Record<string, number>;
  /** Per-template tolerated failure exit codes. Unlike expect2fail (which
   *  *requires* the failure), allowed2fail only relaxes a failure: pass-or-
   *  exit-with-listed-code is OK. */
  allowed2fail?: Record<string, number>;
  /** Optional Playwright spec(s) to run after the scenario's verifications.
   *  Filename (or array of filenames) relative to
   *  json/applications/<app>/tests/playwright/. The livetest runner invokes
   *  them via `pnpm run test:applications` after running the test-deployer
   *  grant refresh on the matching Zitadel dependency. */
  playwright_spec?: string | string[];
  /** Environment variables that must be set (and non-empty) on the dev box
   *  before this scenario is selectable. The livetest runner drops the
   *  scenario from the plan with a warning when any of these are missing
   *  (e.g. `["CF_TOKEN"]` for ACME Cloudflare DNS-01 scenarios). */
  requires_env?: string[];
  /** Source-consumption strategy for upgrade/reconfigure scenarios.
   *  `isolate` (default) clones the source first so the original stays
   *  available to other consumers. `in-place` runs against the source
   *  directly (docker-compose upgrade). `shared` is the legacy behaviour. */
  consumes_source?: "isolate" | "in-place" | "shared";
}

export interface ITestScenariosResponse {
  scenarios: ITestScenarioResponse[];
}

export interface IDependencyStatus {
  application: string;
  source: string; // "application" or addon ID like "addon-oidc"
  /**
   * - `running` — definitely up; install can proceed
   * - `stopped` — definitely down; install must block until user starts the dep
   * - `not_found` — no managed container with this application_id exists
   * - `unknown` — couldn't determine status (pct status timeout / lock /
   *   transient failure even after retry). Surface as a warning, not a
   *   blocker — install MAY proceed at the user's discretion.
   */
  status: "running" | "stopped" | "not_found" | "unknown";
  hostname?: string;
  vmId?: number;
}

export interface IDependencyCheckResponse {
  dependencies: IDependencyStatus[];
}

export interface IPlannedStep {
  name: string;
  description?: string;
  isShared?: boolean;
  isLocal?: boolean;
  isHub?: boolean;
}

export interface ISingleExecuteMessagesResponse {
  application: string;
  task: string;
  messages: IVeExecuteMessage[];
  plannedSteps?: IPlannedStep[];
  restartKey?: string;
  vmInstallKey?: string;
}
export interface IApplicationResponse {
  application: IApplicationWeb;
  parameters: IParameter[];
}

export interface IManagedOciContainer {
  vm_id: number;
  hostname?: string;
  oci_image: string;
  icon?: string;
  application_id?: string;
  application_name?: string;
  version?: string;
  status?: string;
  addons?: string[];
  is_deployer_instance?: boolean;
  username?: string;
  uid?: string;
  gid?: string;
  memory?: number;
  cores?: number;
  rootfs_storage?: string;
  disk_size?: string;
  bridge?: string;
  mount_points?: { source: string; target: string }[];
  volumes?: string;
  /** Stack memberships parsed from `stack-id <id>` markers in container notes.
   * A container belongs to one stack per stacktype it covers (e.g. zitadel
   * spans postgres/oidc/cloudflare → three stack ids). Used by the dependency
   * check to match containers per the dep's stacktype. */
  stack_ids?: string[];
  /** True for PVE host entries (not LXC containers). */
  is_host?: boolean;
}

export type IInstallationsResponse = IManagedOciContainer[];

export interface IServiceVersion {
  service: string;
  image: string;
  currentVersion: string;
}

export interface IContainerVersionsResponse {
  services: IServiceVersion[];
  framework: string;
}


export type IVeExecuteMessagesResponse = ISingleExecuteMessagesResponse[];
export interface IVeConfigurationResponse {
  success: boolean;
  restartKey?: string;
  vmInstallKey?: string;
}
export interface IFrameworkPropertyObject {
  id: string;
  default: boolean;
}
export type IFrameworkProperty = string | IFrameworkPropertyObject;
export interface IFramework {
  id: string;
  name: string;
  extends: string;
  properties: IFrameworkProperty[];
  icon?: string;
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  description?: string;
}

export interface IFrameworkName {
  id: string;
  name: string;
}
export interface IFrameworkNamesResponse {
  frameworks: IFrameworkName[];
}
export interface IFrameworkParametersResponse {
  parameters: IParameter[];
}
// Base interface for framework-based requests (shared between create and preview)
export interface IFrameworkApplicationDataBody {
  frameworkId: string;
  name: string;
  description: string;
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  icon?: string;
  iconContent?: string;
  tags?: string[];
  stacktype?: string | string[];
  supported_addons?: string[];
  parameterValues: { id: string; value: string | number | boolean }[];
  parameterClassifications?: IParameterClassification[];
  uploadfiles?: IUploadFile[];
}

// For creating applications - extends base with applicationId
export interface IPostFrameworkCreateApplicationBody
  extends IFrameworkApplicationDataBody {
  applicationId: string;
  update?: boolean; // If true, overwrite existing application
}

// For preview - uses base directly
export type IPostPreviewUnresolvedParametersBody = IFrameworkApplicationDataBody;
export interface IPostFrameworkCreateApplicationResponse {
  success: boolean;
  applicationId?: string;
}

export interface IOciImageAnnotations {
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  description?: string;
}

export interface IPostFrameworkFromImageBody {
  image: string;
  tag?: string;
}

export interface IApplicationDefaults {
  applicationProperties?: {
    name?: string;
    applicationId?: string;
    description?: string;
    url?: string;
    documentation?: string;
    source?: string;
    vendor?: string;
  };
  parameters?: Record<string, string | number | boolean>;
}

export interface IPostFrameworkFromImageResponse {
  annotations: IOciImageAnnotations;
  defaults: IApplicationDefaults;
}

export interface IApplicationFrameworkDataResponse {
  frameworkId: string;
  applicationId: string;
  name: string;
  description: string;
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  icon?: string;
  iconContent?: string;
  tags?: string[];
  stacktype?: string | string[];
  supported_addons?: string[];
  default_addons?: string[];
  required_addons?: string[];
  parameterValues: { id: string; value: string | number | boolean }[];
}

// Log API response interfaces
export interface IVeLogsResponse {
  success: boolean;
  vmId: number;
  service?: string;
  lines: number;
  content: string;
  error?: string;
}

// Addon interfaces
export interface IAddonVolume {
  id: string;
  mount_point: string;
  default_size?: string;
}

/** Template reference: either a string or object with name and optional position/before/after */
export type AddonTemplateReference =
  | string
  | {
      name: string;
      position?: "start" | "end";
      before?: string;
      after?: string;
    };

export interface IAddon {
  /** Addon ID (derived from filename without .json) */
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  /** Stacktypes this addon requires (e.g., "oidc", "cloudflare") */
  stacktype?: string | string[];
  /** Parameter IDs that must exist in the application for this addon to be compatible */
  required_parameters?: string[];
  /** Applications that must be installed for this addon to function (in the same stack) */
  dependencies?: IStacktypeDependency[];
  /** User-configurable parameters defined directly in addon JSON */
  parameters?: IParameter[];
  /** Fixed property values set by this addon (same format as template command properties) */
  properties?: IOutputObject[];
  /** Fixed volumes required by this addon */
  volumes?: IAddonVolume[];
  /** Templates for new installation (phase-based) */
  installation?: {
    pre_start?: AddonTemplateReference[];
    post_start?: AddonTemplateReference[];
  };
  /** Templates for reconfiguring existing container (phase-based) */
  reconfigure?: {
    pre_start?: AddonTemplateReference[];
    post_start?: AddonTemplateReference[];
  };
  /** Templates for upgrade/reconfigure */
  upgrade?: AddonTemplateReference[];
  /** Templates for disabling a previously installed addon */
  disable?: {
    pre_start?: AddonTemplateReference[];
    post_start?: AddonTemplateReference[];
  };
  /** Key for notes persistence */
  notes_key: string;
  /** Override name/description of parameters defined in templates */
  parameterOverrides?: IParameterOverride[];
  /** Markdown notice extracted from addon .md file (## Notice section) */
  notice?: string;
  /** Declares which stack variables this addon consumes and how they are refreshed. */
  stack_usage?: IStackUsage[];
}

export interface IActiveAddon {
  addonId: string;
  parameters: Record<string, string | number | boolean>;
}

/** Addon with extracted parameters from its templates */
export interface IAddonWithParameters extends IAddon {
  /** Parameters extracted from addon templates (installation, reconfigure, upgrade) */
  parameters?: IParameter[];
}

export interface ICompatibleAddonsResponse {
  addons: IAddonWithParameters[];
}

/**
 * Normalize stacktype to an array for uniform handling.
 * Supports both string ("postgres") and array (["postgres", "oidc"]) formats.
 */
export function normalizeStacktype(
  stacktype: string | string[] | undefined,
): string[] {
  if (!stacktype) return [];
  return Array.isArray(stacktype) ? stacktype : [stacktype];
}

/**
 * Check if an application's stacktype matches a given stacktype string.
 */
export function stacktypeMatches(
  appStacktype: string | string[] | undefined,
  targetStacktype: string,
): boolean {
  return normalizeStacktype(appStacktype).includes(targetStacktype);
}

// Stacktype variable definition (items in stacktype json files)
export interface IStacktypeVariable {
  name: string;
  external?: boolean; // true = manual input required, false/undefined = auto-generate
  required?: boolean; // for external variables: whether a non-empty value must be provided (default: true)
  length?: number; // length of generated secret (default: 32)
}

// Stacktype dependency (application that must be installed for this stacktype)
export interface IStacktypeDependency {
  application: string;
  task?: string; // default: "installation"
}

// Stacktype provides definition (connection info that providers publish)
export interface IStacktypeProvides {
  name: string;
  description?: string;
}

// Stacktype entry (aggregated from json/stacktypes/*.json)
export interface IStacktypeEntry {
  name: string; // derived from filename (e.g. "postgres", "oidc")
  displayName?: string; // human-readable name from JSON "name" field
  description?: string;
  entries: IStacktypeVariable[];
  provides?: IStacktypeProvides[]; // Connection info that providers can publish
  dependencies?: IStacktypeDependency[];
}

// Stack entry (items in stack.entries array)
export interface IStackEntry {
  name: string;
  value: string | number | boolean;
}

// Stack provides entry (runtime connection info published by providers)
export interface IStackProvides {
  name: string;
  value: string;
  application?: string | undefined; // Which app provided this value
}

// Stack (from stack.schema.json)
export interface IStack {
  id: string;
  name: string;
  stacktype: string | string[];
  entries: IStackEntry[];
  provides?: IStackProvides[] | undefined; // Runtime connection info (URLs, ports, protocols)
  /**
   * True when the stack has values that have not yet been propagated to its
   * consumers. Set on update (POST /api/stacks when any entry value changes),
   * cleared after a successful refresh-stack run.
   */
  dirty?: boolean | undefined;
}

// API Response types for stacks
export interface IStacktypesResponse {
  stacktypes: IStacktypeEntry[];
}

export interface IStacksResponse {
  stacks: IStack[];
}

export interface IStackResponse {
  stack: IStack;
}

export interface IStackRestorePreviewRequest {
  stacktype: string | string[];
  name: string;
}

export interface IStackRestorePreviewEntry {
  name: string;
  value: string;
  status: "unique" | "missing";
  sources: string[];
}

export interface IStackRestorePreviewConflict {
  name: string;
  values: { value: string; sources: string[] }[];
}

export interface IStackRestorePreviewDependency {
  canonical: string;
  alias: string;
  source: string;
  replacement?: string;
}

export interface IStackRestorePreviewResponse {
  stack_id: string;
  entries: IStackRestorePreviewEntry[];
  conflicts: IStackRestorePreviewConflict[];
  errors: string[];
  sources_scanned: number;
  dependency_trace: IStackRestorePreviewDependency[];
}

// Template trace interfaces (used by frontend trace dialog and backend template processor)
export interface ITemplateTraceEntry {
  name: string;
  path: string;
  origin:
    | "application-local"
    | "application-hub"
    | "application-json"
    | "shared-local"
    | "shared-hub"
    | "shared-json"
    | "unknown";
  isShared: boolean;
  skipped: boolean;
  conditional: boolean;
}

export interface IParameterTraceEntry {
  id: string;
  name: string;
  required?: boolean;
  default?: string | number | boolean;
  template?: string;
  templatename?: string;
  source:
    | "user_input"
    | "template_output"
    | "template_properties"
    | "default"
    | "missing";
  sourceTemplate?: string;
  sourceKind?: "outputs" | "properties";
}

export interface ITemplateTraceInfo {
  application: string;
  task: TaskType;
  localDir: string;
  jsonDir: string;
  appLocalDir?: string;
  appJsonDir?: string;
}

// Simplified load result for API responses (backend extends this with full fields)
export interface ITemplateProcessorLoadResult {
  templateTrace?: ITemplateTraceEntry[];
  parameterTrace?: IParameterTraceEntry[];
  traceInfo?: ITemplateTraceInfo;
}

// Application overview response types
export interface IApplicationOverviewResponse {
  applicationId: string;
  name: string;
  description: string;
  markdownContent: string | null;
  extendsHierarchy: { id: string; name: string }[];
  dependencies: IApplicationOverviewDependency[];
  stacktype?: IApplicationOverviewStacktype[] | undefined;
  parameters: IApplicationOverviewParameter[];
  templates: IApplicationOverviewTemplate[];
}

export interface IApplicationOverviewStacktype {
  name: string;
  role: "provider" | "consumer";
}

export interface IApplicationOverviewDependency {
  application: string;
  name: string;
  description?: string | undefined;
}

export interface IApplicationOverviewParameter {
  id: string;
  name: string;
  type: string;
  required: boolean;
  advanced: boolean;
  internal: boolean;
  secure: boolean;
  default?: string | number | boolean | undefined;
  description?: string | undefined;
  defaultSource?: string | undefined;
  origin:
    | "application-local"
    | "application-hub"
    | "application-json"
    | "shared-local"
    | "shared-hub"
    | "shared-json";
  sourceType: "value" | "default" | "parameter";
  installedValue?: string | number | boolean | undefined;
}

export interface IApplicationOverviewTemplate {
  seq: number;
  name: string;
  path: string;
  origin:
    | "application-local"
    | "application-hub"
    | "application-json"
    | "shared-local"
    | "shared-hub"
    | "shared-json"
    | "unknown";
  isShared: boolean;
  category?: string | undefined;
  executeOn?: string | undefined;
  skipped: boolean;
  skipReason?: string | undefined;
  skipIfAllMissing?: string[] | undefined;
  skipIfPropertySet?: string | undefined;
  implements?: string | undefined;
  addedByAddon?: string | undefined;
  scriptName?: string | undefined;
  scriptPath?: string | undefined;
  scriptOrigin?: string | undefined;
  outputs: string[];
  parameters: string[];
}

// Addon install body (shared between frontend service and backend route)
export interface IPostAddonInstallBody {
  vm_id: number;
  application_id?: string;
  params?: { name: string; value: string | number | boolean }[];
}

// Certificate management interfaces
export interface ICertificateStatus {
  hostname: string;
  host?: string | undefined;
  file: string;
  certtype: string;
  subject: string;
  issuer: string;
  expiry_date: string;
  days_remaining: number;
  status: "ok" | "warning" | "expired";
}

export interface ICertificateStatusResponse {
  certificates: ICertificateStatus[];
  ca?: { subject: string; expiry_date: string; days_remaining: number; status: string };
}

export interface IPostCertRenewBody {
  hostnames: string[];
}

export interface IPostCertRenewResponse {
  success: boolean;
  renewed: number;
  errors?: string[];
}

export interface IPostCaImportBody {
  key: string;   // Base64 PEM
  cert: string;  // Base64 PEM
}

export interface ICaInfoResponse {
  exists: boolean;
  subject?: string;
  /** notBefore of the CA certificate (ISO 8601). */
  issued_date?: string;
  expiry_date?: string;
  days_remaining?: number;
  project_domain_suffix?: string;
}

export interface IPostGenerateCertBody {
  hostname: string;
}

export interface IGenerateCertResponse {
  hostname: string;
  fqdn: string;
  key: string;       // Base64 PEM
  fullchain: string; // Base64 PEM
}

export interface IAutoRenewalStatus {
  enabled: boolean;
  last_check?: string | undefined;
  next_check?: string | undefined;
  last_renewed?: string[] | undefined;
  last_renewed_date?: string | undefined;
  last_error?: string | undefined;
}

export interface ILogRotationStatus {
  enabled: boolean;
  last_check?: string | undefined;
  next_check?: string | undefined;
  last_rotated_count?: number | undefined;
  last_deleted_count?: number | undefined;
  last_error?: string | undefined;
}

export interface IReplacedCleanupStatus {
  enabled: boolean;
  grace_days: number;
  last_check?: string | undefined;
  next_check?: string | undefined;
  last_destroyed?: string[] | undefined;
  last_error?: string | undefined;
}

export interface ILockedContainer {
  vm_id: number;
  hostname?: string;
  lock: string;
  replaced_at?: string;
  replaced_by?: string;
  ve_host: string;
}

export interface ILockedCleanupResult {
  destroyed: string[];
  failed: { vmid: number; ve_host: string; error: string }[];
}

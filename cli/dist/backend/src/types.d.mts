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
}
export interface IUploadFile {
    destination: string;
    label?: string;
    content?: string;
    required?: boolean;
    advanced?: boolean;
    certtype?: CertType;
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
    stacktype?: string;
    uploadfiles?: IUploadFile[];
    errors?: string[];
    /** User-configurable parameters defined directly in application.json (new approach) */
    parameters?: IParameter[];
    /** Fixed property values set by this application (same format as template command properties) */
    properties?: IOutputObject[];
    /** Override name/description of parameters defined in templates */
    parameterOverrides?: IParameterOverride[];
}
export interface IApplicationWeb {
    name: string;
    description: string;
    icon?: string | undefined;
    iconContent?: string | undefined;
    iconType?: string | undefined;
    id: string;
    tags?: string[] | undefined;
    source: "local" | "json";
    framework?: string | undefined;
    extends?: string | undefined;
    stacktype?: string | undefined;
    errors?: IJsonError[];
}
export type TaskType = "installation" | "backup" | "restore" | "uninstall" | "update" | "upgrade" | "copy-upgrade" | "copy-rollback" | "addon-reconfigure" | "webui" | "addon";
export interface IOutputObject {
    id: string;
    value?: string | number | boolean | (string | {
        name: string;
        value: string | number | boolean;
    } | {
        id: string;
        value: string | number | boolean;
    })[];
    /** Default value for the parameter. Unlike 'value', this will show the parameter as editable in the UI. */
    default?: string | number | boolean;
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
    libraryPath?: string;
    template?: string;
    properties?: IOutputObject | IOutputObject[];
    outputs?: ({
        id: string;
        default?: boolean;
        optional?: boolean;
    } | string)[];
    description?: string;
    /** @internal execute_on is set internally from template.execute_on, not part of the schema */
    execute_on?: "ve" | "lxc" | string;
}
export interface IVeExecuteMessage {
    command: string;
    commandtext?: string;
    stderr: string;
    result: string | null;
    exitCode: number;
    execute_on?: string;
    error?: IJsonError | undefined;
    index?: number;
    finished?: boolean;
    partial?: boolean;
    vmId?: number;
    redirectUrl?: string;
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
    upload?: boolean;
    certtype?: CertType;
    default?: string | number | boolean;
    enumValues?: (string | {
        name: string;
        value: string | number | boolean;
    })[];
    templatename?: string;
    template?: string;
    if?: string;
}
export interface IParameterOverride {
    id: string;
    name?: string;
    description?: string;
}
export interface ITemplate {
    execute_on?: "ve" | "lxc" | string;
    skip_if_all_missing?: string[];
    skip_if_property_set?: string;
    name: string;
    description?: string;
    parameters?: IParameter[];
    commands: ICommand[];
}
export interface IError {
    message: string;
    errors?: string[];
}
export declare enum ApiUri {
    SshConfigs = "/api/sshconfigs",
    SshConfig = "/api/sshconfig",
    SshConfigGET = "/api/ssh/config/:host",
    SshCheck = "/api/ssh/check",
    VeConfiguration = "/api/:veContext/ve-configuration/:application/:task",
    VeRestart = "/api/:veContext/ve/restart/:restartKey",
    VeRestartInstallation = "/api/:veContext/ve/restart-installation/:vmInstallKey",
    VeExecute = "/api/:veContext/ve/execute",
    VeLogs = "/api/:veContext/ve/logs/:vmId",
    VeLogsHostname = "/api/:veContext/ve/logs/:vmId/hostname",
    VeDockerLogs = "/api/:veContext/ve/logs/:vmId/docker",
    Applications = "/api/applications",
    ApplicationTags = "/api/applications/tags",
    LocalApplicationIds = "/api/applications/local/ids",
    Installations = "/api/:veContext/installations",
    ContainerConfig = "/api/:veContext/container-config/:vmId",
    TemplateDetailsForApplication = "/api/:veContext/template-details/:application/:task",
    UnresolvedParameters = "/api/:veContext/unresolved-parameters/:application/:task",
    EnumValues = "/api/:veContext/enum-values/:application/:task",
    FrameworkNames = "/api/framework-names",
    FrameworkParameters = "/api/framework-parameters/:frameworkId",
    FrameworkCreateApplication = "/api/framework-create-application",
    FrameworkFromImage = "/api/framework-from-image",
    ApplicationFrameworkData = "/api/application/:applicationId/framework-data",
    VeCopyUpgrade = "/api/:veContext/ve/copy-upgrade/:application",
    CompatibleAddons = "/api/addons/compatible/:application",
    AddonInstall = "/api/:veContext/addons/install/:addonId",
    PreviewUnresolvedParameters = "/api/:veContext/preview-unresolved-parameters",
    Stacktypes = "/api/stacktypes",
    Stacks = "/api/stacks",
    Stack = "/api/stack/:id",
    Version = "/api/version",
    CertificateStatus = "/api/:veContext/ve/certificates",
    CertificateRenew = "/api/:veContext/ve/certificates/renew",
    CertificateCa = "/api/:veContext/ve/certificates/ca",
    CertificateCaGenerate = "/api/:veContext/ve/certificates/ca/generate",
    CertificatePveStatus = "/api/:veContext/ve/certificates/pve",
    CertificatePveProvision = "/api/:veContext/ve/certificates/pve/provision",
    CertificateDomainSuffix = "/api/:veContext/ve/certificates/domain-suffix",
    LoggerConfig = "/api/logger/config",
    LoggerLevel = "/api/logger/level/:level",
    LoggerDebugComponents = "/api/logger/debug-components"
}
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
export interface IUnresolvedParametersResponse {
    unresolvedParameters: IParameter[];
    addons?: IAddonWithParameters[];
}
export interface IEnumValuesEntry {
    id: string;
    enumValues: (string | {
        name: string;
        value: string | number | boolean;
    })[];
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
    params: {
        name: string;
        value: IParameterValue;
    }[];
    outputs?: {
        id: string;
        value: IParameterValue;
    }[];
    changedParams?: {
        name: string;
        value: IParameterValue;
    }[];
    selectedAddons?: string[];
    disabledAddons?: string[];
    stackId?: string;
}
export interface IPostEnumValuesBody {
    params?: {
        id: string;
        value: IParameterValue;
    }[];
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
export interface ISingleExecuteMessagesResponse {
    application: string;
    task: string;
    messages: IVeExecuteMessage[];
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
    mount_points?: {
        source: string;
        target: string;
    }[];
    volumes?: string;
}
export type IInstallationsResponse = IManagedOciContainer[];
export interface IPostVeCopyUpgradeBody {
    oci_image: string;
    source_vm_id: number;
    vm_id?: number;
    application_id?: string;
    application_name?: string;
    version?: string;
    disk_size?: string;
    bridge?: string;
    memory?: number;
    storage?: string;
    registry_username?: string;
    registry_password?: string;
    registry_token?: string;
    platform?: string;
    selectedAddons?: string[];
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
    stacktype?: string;
    parameterValues: {
        id: string;
        value: string | number | boolean;
    }[];
    uploadfiles?: IUploadFile[];
}
export interface IPostFrameworkCreateApplicationBody extends IFrameworkApplicationDataBody {
    applicationId: string;
    update?: boolean;
}
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
    stacktype?: string;
    parameterValues: {
        id: string;
        value: string | number | boolean;
    }[];
}
export interface IVeLogsResponse {
    success: boolean;
    vmId: number;
    service?: string;
    lines: number;
    content: string;
    error?: string;
}
export interface IAddonVolume {
    id: string;
    mount_point: string;
    default_size?: string;
}
/** Template reference: either a string or object with name and optional before/after */
export type AddonTemplateReference = string | {
    name: string;
    before?: string;
    after?: string;
};
export interface IAddon {
    /** Addon ID (derived from filename without .json) */
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    /** Application IDs, 'tag:<tag-id>' or '*' for all */
    compatible_with: string[] | "*";
    /** Parameter IDs that must exist in the application for this addon to be compatible */
    required_parameters?: string[];
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
    /** Templates for copy-upgrade */
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
export interface IStacktypeVariable {
    name: string;
    external?: boolean;
    length?: number;
}
export interface IStacktypeDependency {
    application: string;
    task?: string;
}
export interface IStacktypeEntry {
    name: string;
    entries: IStacktypeVariable[];
    dependencies?: IStacktypeDependency[];
}
export interface IStackEntry {
    name: string;
    value: string | number | boolean;
}
export interface IStack {
    id: string;
    name: string;
    stacktype: string;
    entries: IStackEntry[];
}
export interface IStacktypesResponse {
    stacktypes: IStacktypeEntry[];
}
export interface IStacksResponse {
    stacks: IStack[];
}
export interface IStackResponse {
    stack: IStack;
}
export interface ITemplateTraceEntry {
    name: string;
    path: string;
    origin: "application-local" | "application-json" | "shared-local" | "shared-json" | "unknown";
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
    source: "user_input" | "template_output" | "template_properties" | "default" | "missing";
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
export interface ITemplateProcessorLoadResult {
    templateTrace?: ITemplateTraceEntry[];
    parameterTrace?: IParameterTraceEntry[];
    traceInfo?: ITemplateTraceInfo;
}
export interface IPostAddonInstallBody {
    vm_id: number;
    application_id?: string;
    params?: {
        name: string;
        value: string | number | boolean;
    }[];
}
export interface ICertificateStatus {
    hostname: string;
    file: string;
    certtype: string;
    subject: string;
    expiry_date: string;
    days_remaining: number;
    status: "ok" | "warning" | "expired";
}
export interface ICertificateStatusResponse {
    certificates: ICertificateStatus[];
    ca?: {
        subject: string;
        expiry_date: string;
        days_remaining: number;
        status: string;
    };
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
    key: string;
    cert: string;
}
export interface ICaInfoResponse {
    exists: boolean;
    subject?: string;
    expiry_date?: string;
    days_remaining?: number;
    domain_suffix?: string;
}

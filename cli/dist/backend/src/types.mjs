export var ApiUri;
(function (ApiUri) {
    ApiUri["SshConfigs"] = "/api/sshconfigs";
    ApiUri["SshConfig"] = "/api/sshconfig";
    ApiUri["SshConfigGET"] = "/api/ssh/config/:host";
    ApiUri["SshCheck"] = "/api/ssh/check";
    ApiUri["VeConfiguration"] = "/api/:veContext/ve-configuration/:application";
    ApiUri["VeRestart"] = "/api/:veContext/ve/restart/:restartKey";
    ApiUri["VeRestartInstallation"] = "/api/:veContext/ve/restart-installation/:vmInstallKey";
    ApiUri["VeExecute"] = "/api/:veContext/ve/execute";
    ApiUri["VeLogs"] = "/api/:veContext/ve/logs/:vmId";
    ApiUri["VeLogsHostname"] = "/api/:veContext/ve/logs/:vmId/hostname";
    ApiUri["VeDockerLogs"] = "/api/:veContext/ve/logs/:vmId/docker";
    ApiUri["Applications"] = "/api/applications";
    ApiUri["ApplicationTags"] = "/api/applications/tags";
    ApiUri["LocalApplicationIds"] = "/api/applications/local/ids";
    ApiUri["Installations"] = "/api/:veContext/installations";
    ApiUri["ContainerConfig"] = "/api/:veContext/container-config/:vmId";
    ApiUri["TemplateDetailsForApplication"] = "/api/:veContext/template-details/:application/:task";
    ApiUri["UnresolvedParameters"] = "/api/:veContext/unresolved-parameters/:application";
    ApiUri["EnumValues"] = "/api/:veContext/enum-values/:application";
    ApiUri["FrameworkNames"] = "/api/framework-names";
    ApiUri["FrameworkParameters"] = "/api/framework-parameters/:frameworkId";
    ApiUri["FrameworkCreateApplication"] = "/api/framework-create-application";
    ApiUri["FrameworkFromImage"] = "/api/framework-from-image";
    ApiUri["ApplicationFrameworkData"] = "/api/application/:applicationId/framework-data";
    ApiUri["VeCopyUpgrade"] = "/api/:veContext/ve/copy-upgrade/:application";
    ApiUri["CompatibleAddons"] = "/api/addons/compatible/:application";
    ApiUri["AddonInstall"] = "/api/:veContext/addons/install/:addonId";
    ApiUri["PreviewUnresolvedParameters"] = "/api/:veContext/preview-unresolved-parameters";
    ApiUri["Stacktypes"] = "/api/stacktypes";
    ApiUri["Stacks"] = "/api/stacks";
    ApiUri["Stack"] = "/api/stack/:id";
    // Version / build info
    ApiUri["Version"] = "/api/version";
    // Certificate management endpoints
    ApiUri["CertificateStatus"] = "/api/:veContext/ve/certificates";
    ApiUri["CertificateRenew"] = "/api/:veContext/ve/certificates/renew";
    ApiUri["CertificateCa"] = "/api/:veContext/ve/certificates/ca";
    ApiUri["CertificateCaGenerate"] = "/api/:veContext/ve/certificates/ca/generate";
    ApiUri["CertificatePveStatus"] = "/api/:veContext/ve/certificates/pve";
    ApiUri["CertificatePveProvision"] = "/api/:veContext/ve/certificates/pve/provision";
    ApiUri["CertificateDomainSuffix"] = "/api/:veContext/ve/certificates/domain-suffix";
    ApiUri["CertificateCaDownload"] = "/api/:veContext/ve/certificates/ca/download";
    ApiUri["CertificateGenerate"] = "/api/:veContext/ve/certificates/generate";
    // Logger endpoints
    ApiUri["LoggerConfig"] = "/api/logger/config";
    ApiUri["LoggerLevel"] = "/api/logger/level/:level";
    ApiUri["LoggerDebugComponents"] = "/api/logger/debug-components";
})(ApiUri || (ApiUri = {}));
/**
 * Normalize stacktype to an array for uniform handling.
 * Supports both string ("postgres") and array (["postgres", "oidc"]) formats.
 */
export function normalizeStacktype(stacktype) {
    if (!stacktype)
        return [];
    return Array.isArray(stacktype) ? stacktype : [stacktype];
}
/**
 * Check if an application's stacktype matches a given stacktype string.
 */
export function stacktypeMatches(appStacktype, targetStacktype) {
    return normalizeStacktype(appStacktype).includes(targetStacktype);
}
//# sourceMappingURL=types.mjs.map
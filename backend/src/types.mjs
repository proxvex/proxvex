export var ApiUri;
(function (ApiUri) {
    ApiUri["SshConfigs"] = "/api/sshconfigs";
    ApiUri["SshConfig"] = "/api/sshconfig";
    ApiUri["SshConfigGET"] = "/api/ssh/config/:host";
    ApiUri["SshCheck"] = "/api/ssh/check";
    ApiUri["VeConfiguration"] = "/api/:veContext/ve-configuration/:application/:task";
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
    ApiUri["TemplateDetailsForApplication"] = "/api/:veContext/template-details/:application/:task";
    ApiUri["UnresolvedParameters"] = "/api/:veContext/unresolved-parameters/:application/:task";
    ApiUri["EnumValues"] = "/api/:veContext/enum-values/:application/:task";
    ApiUri["FrameworkNames"] = "/api/framework-names";
    ApiUri["FrameworkParameters"] = "/api/framework-parameters/:frameworkId";
    ApiUri["FrameworkCreateApplication"] = "/api/framework-create-application";
    ApiUri["FrameworkFromImage"] = "/api/framework-from-image";
    ApiUri["ApplicationFrameworkData"] = "/api/application/:applicationId/framework-data";
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
    // Logger endpoints
    ApiUri["LoggerConfig"] = "/api/logger/config";
    ApiUri["LoggerLevel"] = "/api/logger/level/:level";
    ApiUri["LoggerDebugComponents"] = "/api/logger/debug-components";
})(ApiUri || (ApiUri = {}));
//# sourceMappingURL=types.mjs.map
import { IApplicationOverviewResponse } from './application-overview.types';

const ZITADEL_MARKDOWN = `## Overview

ZITADEL is an open source identity management platform that provides authentication and authorization services.
It serves as the central identity provider in the stack, managing users, roles, and OIDC-based authentication.

## Integration with OIDC Addon

Applications that support the \`addon-oidc\` addon connect to Zitadel for Single Sign-On (SSO).
The OIDC addon automatically:
- Creates an OIDC application in the configured Zitadel project
- Configures redirect URIs for the target application
- Provisions the required client credentials

## User Management

User management is done **exclusively through the Zitadel Web UI or API** — not through oci-lxc-deployer.
After installation, access the Zitadel admin console at \`https://<hostname>/ui/console\` to:
- Create and manage users
- Assign roles to users
- Configure authentication policies (MFA, passwordless, etc.)
`;

export function getMockOverviewData(applicationId: string, task: string): IApplicationOverviewResponse {
  if (applicationId === 'zitadel') {
    return getZitadelMock(task);
  }
  return getGenericMock(applicationId, task);
}

function getZitadelMock(task: string): IApplicationOverviewResponse {
  const isInstallation = task === 'installation';
  return {
    applicationId: 'zitadel',
    name: 'zitadel',
    description: 'ZITADEL is an open source identity management platform.',
    markdownContent: ZITADEL_MARKDOWN,
    extendsHierarchy: [
      { id: 'zitadel', name: 'zitadel' },
      { id: 'docker-compose', name: 'docker-compose' },
      { id: 'oci-image', name: 'oci-image' },
    ],
    dependencies: [
      {
        application: 'postgres',
        name: 'PostgreSQL',
        description: 'Relational database for Zitadel identity data',
      },
    ],
    stacktype: [
      { name: 'oidc', role: 'provider' },
      { name: 'postgres', role: 'consumer' },
    ],
    parameters: [
      {
        id: 'hostname',
        name: 'Hostname',
        type: 'string',
        required: false,
        advanced: false,
        internal: false,
        secure: false,
        default: 'zitadel',
        description: 'Hostname for the Docker Compose container.',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'default',
      },
      {
        id: 'ZITADEL_EXTERNALDOMAIN',
        name: 'External Domain',
        type: 'string',
        required: false,
        advanced: false,
        internal: false,
        secure: false,
        default: '{{ hostname }}',
        description: 'Public domain name for Zitadel (used in URLs and OIDC config)',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'default',
      },
      {
        id: 'vm_id',
        name: 'VM ID',
        type: 'number',
        required: true,
        advanced: false,
        internal: false,
        secure: false,
        description: 'Proxmox VM/CT ID',
        origin: 'shared-json',
        sourceType: 'parameter',
      },
      {
        id: 'oci_image',
        name: 'OCI Image',
        type: 'string',
        required: true,
        advanced: false,
        internal: false,
        secure: false,
        default: 'ghcr.io/zitadel/zitadel:latest',
        description: 'Docker/OCI image reference',
        defaultSource: '200-post-pull-oci-image.json',
        origin: 'shared-json',
        sourceType: 'default',
      },
      {
        id: 'uid',
        name: 'User ID',
        type: 'string',
        required: false,
        advanced: true,
        internal: false,
        secure: false,
        default: '1000',
        description: 'UID for the container user',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'value',
      },
      {
        id: 'gid',
        name: 'Group ID',
        type: 'string',
        required: false,
        advanced: true,
        internal: false,
        secure: false,
        default: '1001',
        description: 'GID for the container group',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'value',
      },
      {
        id: 'compose_file',
        name: 'Compose File',
        type: 'string',
        required: false,
        advanced: true,
        internal: true,
        secure: false,
        default: 'file:Zitadel.docker-compose.yml',
        description: 'Docker compose file reference',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'default',
      },
      {
        id: 'ssl_mode',
        name: 'SSL Mode',
        type: 'string',
        required: false,
        advanced: false,
        internal: true,
        secure: false,
        default: 'native',
        description: 'SSL termination mode',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'value',
      },
      {
        id: 'https_port',
        name: 'HTTPS Port',
        type: 'string',
        required: false,
        advanced: true,
        internal: false,
        secure: false,
        default: '1443',
        description: 'HTTPS port for the application',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'value',
      },
      {
        id: 'postgres_password',
        name: 'PostgreSQL Password',
        type: 'string',
        required: true,
        advanced: false,
        internal: false,
        secure: true,
        description: 'Password for the PostgreSQL database',
        origin: 'shared-json',
        sourceType: 'parameter',
      },
      {
        id: 'startup_order',
        name: 'Startup Order',
        type: 'string',
        required: false,
        advanced: true,
        internal: true,
        secure: false,
        default: '20',
        description: 'Container startup order in Proxmox',
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'value',
      },
      {
        id: 'dns_server',
        name: 'DNS Server',
        type: 'string',
        required: false,
        advanced: true,
        internal: false,
        secure: false,
        description: 'DNS server for the container',
        origin: 'shared-json',
        sourceType: 'parameter',
      },
    ],
    templates: isInstallation
      ? [
          {
            seq: 1, name: 'Create LXC Container',
            path: 'json/shared/templates/create_ct/100-conf-create-lxc-container.json',
            origin: 'shared-json', isShared: true, category: 'create_ct', executeOn: 'host',
            skipped: false, scriptName: 'conf-create-lxc-container.sh', scriptPath: 'json/shared/scripts/conf-create-lxc-container.sh', scriptOrigin: 'shared-json',
            outputs: ['vm_id'], parameters: ['vm_id', 'hostname', 'dns_server', 'memory', 'cores', 'disk_size'],
          },
          {
            seq: 2, name: 'Configure Startup Order',
            path: 'json/shared/templates/pre_start/120-conf-startup-order.json',
            origin: 'shared-json', isShared: true, category: 'pre_start', executeOn: 've',
            skipped: false, skipIfAllMissing: ['startup_order'],
            scriptName: 'conf-set-startup-order.sh', scriptPath: 'json/shared/scripts/conf-set-startup-order.sh', scriptOrigin: 'shared-json',
            outputs: [], parameters: ['startup_order', 'startup_up', 'startup_timeout'],
          },
          {
            seq: 3, name: 'Start Container',
            path: 'json/shared/templates/start/150-host-start-container.json',
            origin: 'shared-json', isShared: true, category: 'start', executeOn: 'host',
            skipped: false, scriptName: 'host-start-container.sh', scriptPath: 'json/shared/scripts/host-start-container.sh', scriptOrigin: 'shared-json',
            outputs: [], parameters: ['vm_id'],
          },
          {
            seq: 4, name: 'Install Alpine Packages',
            path: 'json/shared/templates/post_start/185-post-install-apk-package.json',
            origin: 'shared-json', isShared: true, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-install-apk-package.sh', scriptPath: 'json/shared/scripts/post-install-apk-package.sh', scriptOrigin: 'shared-json',
            outputs: [], parameters: ['alpine_packages'],
          },
          {
            seq: 5, name: 'Pull OCI Image',
            path: 'json/shared/templates/post_start/200-post-pull-oci-image.json',
            origin: 'shared-json', isShared: true, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-pull-oci-image.sh', scriptPath: 'json/shared/scripts/post-pull-oci-image.sh', scriptOrigin: 'shared-json',
            outputs: ['oci_image_digest'], parameters: ['oci_image'],
          },
          {
            seq: 6, name: 'Setup Docker Compose',
            path: 'json/shared/templates/post_start/250-post-setup-docker-compose.json',
            origin: 'shared-json', isShared: true, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-setup-docker-compose.sh', scriptPath: 'json/shared/scripts/post-setup-docker-compose.sh', scriptOrigin: 'shared-json',
            outputs: [], parameters: ['compose_file', 'envs', 'volumes'],
          },
          {
            seq: 7, name: 'SSL Certificate Setup',
            path: 'json/shared/templates/post_start/280-post-setup-ssl.json',
            origin: 'shared-json', isShared: true, category: 'post_start', executeOn: 'lxc',
            skipped: false, implements: 'ssl',
            scriptName: 'post-setup-ssl-certs.sh', scriptPath: 'json/shared/scripts/post-setup-ssl-certs.sh', scriptOrigin: 'shared-json',
            outputs: [], parameters: ['ssl_mode'],
            addedByAddon: 'addon-ssl',
          },
          {
            seq: 8, name: 'Setup Deployer in Zitadel',
            path: 'json/applications/zitadel/templates/340-post-setup-deployer-in-zitadel.json',
            origin: 'application-json', isShared: false, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-setup-deployer-in-zitadel.sh', scriptPath: 'json/applications/zitadel/scripts/post-setup-deployer-in-zitadel.sh', scriptOrigin: 'application-json',
            outputs: ['deployer_client_id', 'deployer_client_secret'], parameters: ['ZITADEL_EXTERNALDOMAIN'],
          },
          {
            seq: 9, name: 'Setup Test Project',
            path: 'json/applications/zitadel/templates/350-post-setup-test-project.json',
            origin: 'application-json', isShared: false, category: 'post_start', executeOn: 'lxc',
            skipped: true, skipReason: 'skip_if_all_missing: [test_project_name]',
            skipIfAllMissing: ['test_project_name'],
            scriptName: 'post-setup-test-project.sh', scriptPath: 'json/applications/zitadel/scripts/post-setup-test-project.sh', scriptOrigin: 'application-json',
            outputs: [], parameters: ['test_project_name'],
          },
          {
            seq: 10, name: 'Harden Zitadel Compose',
            path: 'json/applications/zitadel/templates/360-post-harden-zitadel-compose.json',
            origin: 'application-json', isShared: false, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-harden-zitadel-compose.sh', scriptPath: 'json/applications/zitadel/scripts/post-harden-zitadel-compose.sh', scriptOrigin: 'application-json',
            outputs: [], parameters: [],
          },
        ]
      : [
          {
            seq: 1, name: 'Setup Docker Compose',
            path: 'json/shared/templates/post_start/250-post-setup-docker-compose.json',
            origin: 'shared-json', isShared: true, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-setup-docker-compose.sh', scriptPath: 'json/shared/scripts/post-setup-docker-compose.sh', scriptOrigin: 'shared-json',
            outputs: [], parameters: ['compose_file', 'envs', 'volumes'],
          },
          {
            seq: 2, name: 'Harden Zitadel Compose',
            path: 'json/applications/zitadel/templates/360-post-harden-zitadel-compose.json',
            origin: 'application-json', isShared: false, category: 'post_start', executeOn: 'lxc',
            skipped: false, scriptName: 'post-harden-zitadel-compose.sh', scriptPath: 'json/applications/zitadel/scripts/post-harden-zitadel-compose.sh', scriptOrigin: 'application-json',
            outputs: [], parameters: [],
          },
        ],
  };
}

function getGenericMock(applicationId: string, _task: string): IApplicationOverviewResponse {
  return {
    applicationId,
    name: applicationId,
    description: `Application: ${applicationId}`,
    markdownContent: null,
    extendsHierarchy: [{ id: applicationId, name: applicationId }],
    dependencies: [],
    parameters: [
      {
        id: 'hostname',
        name: 'Hostname',
        type: 'string',
        required: true,
        advanced: false,
        internal: false,
        secure: false,
        default: applicationId,
        defaultSource: 'application.json',
        origin: 'application-json',
        sourceType: 'default',
      },
    ],
    templates: [
      {
        seq: 1, name: 'Create LXC Container',
        path: 'json/shared/templates/create_ct/100-conf-create-lxc-container.json',
        origin: 'shared-json', isShared: true, category: 'create_ct', executeOn: 'host',
        skipped: false, scriptName: 'conf-create-lxc-container.sh', scriptPath: 'json/shared/scripts/conf-create-lxc-container.sh', scriptOrigin: 'shared-json',
        outputs: ['vm_id'], parameters: ['vm_id', 'hostname'],
      },
    ],
  };
}

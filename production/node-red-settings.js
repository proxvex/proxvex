const fs = require('fs');

module.exports = {
    https: {
        key: fs.readFileSync('/certs/privkey.pem'),
        cert: fs.readFileSync('/certs/fullchain.pem')
    },
    requireHttps: true,
    uiPort: process.env.NODERED_PORT || 1880,
    flowFile: 'flows.json',
    credentialSecret: process.env.NODERED_CREDENTIAL_SECRET || false,

    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false
        }
    },

    editorTheme: {
        projects: { enabled: false },
        page: { title: 'Node-RED' }
    }

    // adminAuth (OIDC) is injected at deploy time by
    // json/applications/node-red/scripts/pre_start/conf-configure-oidc-app.sh
};

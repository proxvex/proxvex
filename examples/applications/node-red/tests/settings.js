const fs = require('fs');
module.exports = {
    https: {
        key: fs.readFileSync('/certs/server.key'),
        cert: fs.readFileSync('/certs/server.crt')
    },
    uiPort: 1880,
    requireHttps: true
};

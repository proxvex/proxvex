const fs = require('fs');
module.exports = {
    https: {
        key: fs.readFileSync('/certs/privkey.pem'),
        cert: fs.readFileSync('/certs/fullchain.pem')
    },
    uiPort: 1880,
    requireHttps: true
};

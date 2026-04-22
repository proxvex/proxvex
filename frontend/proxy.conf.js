const host = process.env.DEPLOYER_HOST || "localhost";
const port = process.env.DEPLOYER_PORT || process.env.PORT || 3080;
const target = `http://${host}:${port}`;

module.exports = {
  "/api": {
    target,
    secure: false,
    changeOrigin: true,
    logLevel: "debug",
  },
  "/socket.io": {
    target,
    ws: true,
    secure: false,
    changeOrigin: true,
    logLevel: "debug",
  },
};

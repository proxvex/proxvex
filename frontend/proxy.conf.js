const port = process.env.DEPLOYER_PORT || process.env.PORT || 3080;

module.exports = {
  "/api": {
    target: `http://localhost:${port}`,
    secure: false,
    changeOrigin: true,
    logLevel: "debug",
  },
  "/socket.io": {
    target: `http://localhost:${port}`,
    ws: true,
    secure: false,
    changeOrigin: true,
    logLevel: "debug",
  },
};

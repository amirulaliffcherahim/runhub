// pm2's fork wrapper becomes process.argv[1], which defeats server.mjs's isMain guard.
// Run node directly (interpreter "none") so argv[1] is server.mjs.
module.exports = {
  apps: [{
    name: "runhub",
    script: process.execPath,
    args: "server.mjs",
    interpreter: "none",
    cwd: "/home/yuki/code/runhub",
    env: { HOST: "100.109.19.100", PORT: "3300" },
    max_restarts: 10,
  }],
};

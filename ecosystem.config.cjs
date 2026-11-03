// pm2's fork wrapper becomes process.argv[1], which defeats server.mjs's isMain guard.
// Run node directly (interpreter "none") so argv[1] is server.mjs.
//
// HOST/PORT are deliberately NOT set here: `.env` is the single source of truth
// (HOST=0.0.0.0 serves localhost for cloudflared *and* the Tailscale IP).
// Anything set in `env` below would override .env, because db.mjs's loadEnv
// only fills in variables that are not already present.
module.exports = {
  apps: [{
    name: "runhub",
    script: process.execPath,
    args: "server.mjs",
    interpreter: "none",
    cwd: "/home/yuki/code/runhub",
    max_restarts: 10,
  }],
};

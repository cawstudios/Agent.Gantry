// Local-only pm2 ecosystem for a build+run smoke test on macOS, BEFORE AWS.
// Mirrors the EC2 ecosystem (uat-deployment-ec2.md §8) but with local paths.
//
//   Run from a NORMAL Terminal (not from inside Claude Code, so injected model
//   env stays out):
//     pm2 start agents/boondi_support/docs/ecosystem.local.config.cjs
//
//   Tear down after:  pm2 delete all
//   Do NOT run `pm2 startup` — that installs a launchd boot service (dev-mode rule).
//
// pm2 ecosystem files must use a recognized config suffix such as `.config.cjs`.
// The repo is ESM `type:module`, so `require` is required here — not an `import`.
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const os = require('os');

const cwd = path.resolve(__dirname, '..', '..', '..'); // repo root (file is in agents/boondi_support/docs)
const home = os.homedir();
const gantryHome = path.join(home, 'gantry'); // reuse your existing settings + model creds
const node = process.execPath;

// Blank any injected model creds so children use the brokered Model Gateway,
// not a personal token. (Best-effort backstop; running from a clean Terminal is
// the real fix.)
const stripModelEnv = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  ANTHROPIC_BASE_URL: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  OPENAI_API_KEY: '',
};

module.exports = {
  apps: [
    {
      name: 'mcp-shopify',
      cwd,
      script: node,
      args: 'packages/mcp-shopify/dist/index.js',
      interpreter: 'none',
      env: { ...stripModelEnv, GANTRY_HOME: gantryHome },
    },
    {
      name: 'mcp-crm',
      cwd,
      script: node,
      args: 'packages/mcp-crm/dist/index.js',
      interpreter: 'none',
      env: { ...stripModelEnv, GANTRY_HOME: gantryHome },
    },
    {
      name: 'gantry-core',
      cwd,
      script: node,
      args: 'dist/index.js',
      interpreter: 'none',
      kill_timeout: 30000, // graceful drain on reload/stop
      env: {
        ...stripModelEnv,
        GANTRY_HOME: gantryHome,
        // Use a DIFFERENT IPC socket than `npm run dev` (whose default is
        // ~/gantry/data/ipc/core.sock). Both cores auto-load the same
        // ~/gantry/.env, so this override MUST stay here, not in .env, or the two
        // would share one socket and collide.
        GANTRY_IPC_SOCKET_PATH: path.join(gantryHome, 'run', 'pm2-core.sock'),
        GANTRY_OUTBOUND_DRYRUN: '1',
      },
    },
    // Admin dashboard omitted — add it here once it's ready, mirroring §8.
  ],
};

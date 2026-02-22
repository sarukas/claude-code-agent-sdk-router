#!/usr/bin/env node
// CLI — five commands: setup, start, run, version, help

import { existsSync } from 'fs';
import { CONFIG_FILE } from './core/services/config';

const VERSION = '0.1.0';

function ensureConfig(): void {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`Config not found: ${CONFIG_FILE}`);
    console.error('Run "ccasr setup" to create it.');
    process.exit(1);
  }
}

const command = process.argv[2];

switch (command) {
  case 'setup':
    import('./cli/setup').then(({ runSetup }) => runSetup()).catch((err) => {
      console.error('Setup failed:', err.message || err);
      process.exit(1);
    });
    break;

  case 'start':
    ensureConfig();
    import('./core/server').then(({ startServer }) =>
      startServer().catch((err) => {
        console.error('Fatal error:', err.message || err);
        process.exit(1);
      })
    );
    break;

  case 'run':
    ensureConfig();
    import('./cli/run').then(({ runCommand }) =>
      runCommand(process.argv.slice(3))
    ).catch((err) => {
      console.error('Run failed:', err.message || err);
      process.exit(1);
    });
    break;

  case 'version':
    console.log(`ccasr v${VERSION}`);
    console.log(`node ${process.version}`);
    break;

  case 'help':
  default:
    console.log(`
ccasr v${VERSION} — Claude Code Agent SDK Router

Usage: ccasr <command>

Commands:
  setup     Interactive setup wizard — creates config file
  start     Start the proxy server (foreground, Ctrl-C to stop)
  run       Start proxy + launch command (e.g. ccasr run claude)
  version   Print version info
  help      Show this help message

Quick start:
  ccasr setup            Configure providers and router
  ccasr run claude       Start proxy and launch Claude Code

Config:
  ${CONFIG_FILE}

Manual setup:
  export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
  export ANTHROPIC_API_KEY=ccasr-proxy
`);
}

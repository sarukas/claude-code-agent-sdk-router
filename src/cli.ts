#!/usr/bin/env node
// CLI — three commands only: start, version, help

import { startServer } from './core/server';

const VERSION = '0.1.0';

const command = process.argv[2];

switch (command) {
  case 'start':
    startServer().catch((err) => {
      console.error('Fatal error:', err.message || err);
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
  start     Start the proxy server (foreground, Ctrl-C to stop)
  version   Print version info
  help      Show this help message

Config:
  ~/.ccasr/config.json (JSON5 — comments allowed)

Setup:
  export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
  export ANTHROPIC_API_KEY=any-non-empty-string
`);
}

#!/usr/bin/env node
// CLI — three commands only: start, version, help

// TODO: Phase 4 — implement CLI commands
const command = process.argv[2];

switch (command) {
  case 'start':
    console.log('Starting server... (not yet implemented)');
    break;
  case 'version':
    console.log('ccasr v0.1.0');
    break;
  case 'help':
  default:
    console.log(`
Usage: ccasr <command>

Commands:
  start     Start the proxy server (foreground)
  version   Print version info
  help      Show this help message

Setup:
  export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
  export ANTHROPIC_API_KEY=any-non-empty-string
`);
}

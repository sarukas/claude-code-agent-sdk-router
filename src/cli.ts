#!/usr/bin/env node
// CLI — five commands: setup, start, run, version, help
// All commands accept --config <path> and --route <name>.

import { existsSync } from 'fs';
import { CONFIG_FILE } from './core/services/config';

const VERSION = '0.1.0';

function cliPrefix(): string {
  const argv1 = process.argv[1] || '';
  if (argv1.includes('tsx') || argv1.endsWith('cli.ts')) {
    return 'npx tsx src/cli.ts';
  }
  return 'ccasr';
}

/** Extract --config <path> and --route <name> from argv */
function extractFlags(args: string[]): { configPath: string | undefined; activeRoute: string | undefined; rest: string[] } {
  let configPath: string | undefined;
  let activeRoute: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i] === '--route' && i + 1 < args.length) {
      activeRoute = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { configPath, activeRoute, rest };
}

function ensureConfig(configPath: string): void {
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error(`Run "${cliPrefix()} setup" to create it.`);
    process.exit(1);
  }
}

/** Extract --port and --secret flags for gateway mode */
function extractGatewayFlags(args: string[]): { port: number | undefined; secret: string | undefined; rest: string[] } {
  let port: number | undefined;
  let secret: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--secret' && i + 1 < args.length) {
      secret = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { port, secret, rest };
}

// Parse args: command is first positional, --config/--route can appear anywhere
const { configPath: customConfig, activeRoute, rest: positionalArgs } = extractFlags(process.argv.slice(2));
const command = positionalArgs[0];
const effectiveConfig = customConfig || CONFIG_FILE;

switch (command) {
  case 'setup':
    import('./cli/setup').then(({ runSetup }) => runSetup(customConfig)).catch((err) => {
      console.error('Setup failed:', err.message || err);
      process.exit(1);
    });
    break;

  case 'start':
    ensureConfig(effectiveConfig);
    import('./core/server').then(({ startServer }) =>
      startServer(customConfig, activeRoute).catch((err) => {
        console.error('Fatal error:', err.message || err);
        process.exit(1);
      })
    );
    break;

  case 'run':
    ensureConfig(effectiveConfig);
    import('./cli/run').then(({ runCommand }) =>
      runCommand(positionalArgs.slice(1), customConfig, activeRoute)
    ).catch((err) => {
      console.error('Run failed:', err.message || err);
      process.exit(1);
    });
    break;

  case 'gateway': {
    const gwFlags = extractGatewayFlags(positionalArgs.slice(1));
    import('./core/server').then(async ({ createGateway }) => {
      try {
        const gw = await createGateway({
          port: gwFlags.port,
          proxySecret: gwFlags.secret,
        });
        const addr = gw.address();
        console.log('\n========================================');
        console.log('  ccasr — Gateway Mode');
        console.log('========================================');
        console.log(`  Listening:  http://${addr.host}:${addr.port}`);
        console.log(`  Auth:       ${gwFlags.secret ? 'proxySecret required' : 'passthrough (localhost-only)'}`);
        console.log(`  Providers:  all 7 (credentials per-request)`);
        console.log('========================================');
        if (!gwFlags.secret) {
          console.log(`\nAgent SDK integration (passthrough mode):`);
          console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${addr.port}`);
          console.log(`  ANTHROPIC_API_KEY=<provider-api-key>`);
          console.log(`  ANTHROPIC_MODEL=openrouter,google/gemini-2.5-flash`);
        } else {
          console.log(`\nWith proxySecret, use X-Provider-Api-Key header or POST /v1/credentials`);
        }
        console.log(`\nHealth: curl http://127.0.0.1:${addr.port}/health\n`);

        const shutdown = async (signal: string) => {
          console.log(`\nReceived ${signal}, shutting down...`);
          await gw.close();
          process.exit(0);
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
      } catch (err: any) {
        console.error('Gateway failed:', err.message || err);
        process.exit(1);
      }
    });
    break;
  }

  case 'version':
    console.log(`ccasr v${VERSION}`);
    console.log(`node ${process.version}`);
    break;

  case 'help':
  default:
    { const cmd = cliPrefix();
    console.log(`
ccasr v${VERSION} — Claude Code Agent SDK Router

Usage: ${cmd} <command> [--config <path>] [--route <name>]

Commands:
  setup     Interactive setup wizard — creates or edits config file
  start     Start the proxy server (foreground, Ctrl-C to stop)
  run       Start proxy + launch command (e.g. ${cmd} run claude)
  gateway   Start in gateway mode — no config file, per-request credentials
  version   Print version info
  help      Show this help message

Options:
  --config <path>  Use alternative config file (default: ${CONFIG_FILE})
  --route <name>   Use a named route set (overrides ActiveRoute in config)

Gateway options:
  --port <number>  Port to listen on (default: OS-assigned)
  --secret <token> Require x-api-key header for proxy auth

Quick start:
  ${cmd} setup            Configure providers and routes
  ${cmd} run claude       Start proxy and launch Claude Code

Gateway mode (Agent SDK):
  ${cmd} gateway --port 8901
  Then set: ANTHROPIC_BASE_URL=http://127.0.0.1:8901
            ANTHROPIC_API_KEY=<provider-api-key>
            ANTHROPIC_MODEL=openrouter,google/gemini-2.5-flash

Named routes:
  ${cmd} start --route mixed     Start with "mixed" route set
  ${cmd} run --route cheap claude

Config:
  ${CONFIG_FILE}

Manual setup:
  export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
  export ANTHROPIC_API_KEY=ccasr-proxy
`);
    }
}

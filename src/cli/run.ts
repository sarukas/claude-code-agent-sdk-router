// Run wrapper — starts proxy, injects env vars, launches child process.

import { spawn } from 'child_process';
import { createServer, printBanner } from '../core/server';

export async function runCommand(args: string[], configPath?: string, activeRoute?: string): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: ccasr run <command> [args...]');
    console.error('Example: ccasr run claude');
    process.exit(1);
  }

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  // 1. Start proxy server
  const { app, context } = await createServer(configPath, activeRoute);
  const port = context.config.get('PORT');

  try {
    await app.listen({ port, host: '127.0.0.1' });
  } catch (err: any) {
    console.error(`Failed to start proxy: ${err.message}`);
    process.exit(1);
  }

  printBanner(context);
  console.log(`\nLaunching: ${cmd} ${cmdArgs.join(' ')}\n`);

  // 2. Spawn child with env vars injected
  const child = spawn(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: 'ccasr-proxy',
    },
  });

  // 3. Forward signals to child
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  // 4. On child exit, shut down proxy and exit
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.error(`Command not found: ${cmd}`);
    } else {
      console.error(`Failed to launch: ${err.message}`);
    }
    app.close().then(() => process.exit(127));
  });

  child.on('exit', (code, signal) => {
    const exitCode = code ?? (signal ? 128 : 1);
    app.close().then(() => process.exit(exitCode));
  });
}

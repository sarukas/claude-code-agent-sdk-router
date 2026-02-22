// Fastify server — no plugin hooks, no agent hooks, no APIKEY middleware.
// Binds to 127.0.0.1 only.

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import pino from 'pino';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { AppConfig } from './types';
import { ConfigService, CONFIG_DIR } from './services/config';
import { ProviderService } from './services/provider';
import { TransformerService } from './services/transformer';
import { errorHandler } from './api/middleware';
import { registerRoutes } from './api/routes';
import { CaptureLogger } from './utils/capture';

const LOGS_DIR = join(CONFIG_DIR, 'logs');

export interface ServerContext {
  config: ConfigService;
  providers: ProviderService;
  transformers: TransformerService;
  capture?: CaptureLogger;
}

export async function createServer(configPath?: string, activeRoute?: string, opts?: { quiet?: boolean }): Promise<{ app: FastifyInstance; context: ServerContext }> {
  // Load config
  const config = new ConfigService(configPath, activeRoute);
  const appConfig = config.getConfig();

  // Create services
  const providers = new ProviderService(appConfig.Providers);
  const transformers = new TransformerService();

  const context: ServerContext = { config, providers, transformers };

  // Create capture logger for per-provider JSONL data capture
  if (appConfig.LOG) {
    context.capture = new CaptureLogger(LOGS_DIR, appConfig.ActiveRoute);
  }

  // Build logger config.
  // In quiet mode (run command), skip console output to avoid polluting child process stdout.
  // Console output uses main-thread pino.destination (unbuffered).
  // File output uses pino-roll transport (worker thread, buffered — fine for files).
  const quiet = opts?.quiet ?? false;
  const logLevel = appConfig.LOG ? 'debug' : 'info';
  const logToFile = appConfig.LOG_FILE !== false;

  let logger: pino.Logger;

  if (logToFile) {
    mkdirSync(LOGS_DIR, { recursive: true });
    const fileTransport = pino.transport({
      target: 'pino-roll',
      options: {
        file: join(LOGS_DIR, 'ccasr.log'),
        size: appConfig.LOG_MAX_SIZE || '10m',
        limit: { count: appConfig.LOG_MAX_FILES || 5 },
      },
    });
    if (quiet) {
      // File only — no console output
      logger = pino({ level: 'info' }, fileTransport);
    } else {
      const consoleStream = pino.destination({ dest: 1, sync: true });
      const multistream = pino.multistream([
        { stream: consoleStream, level: logLevel as pino.Level },
        { stream: fileTransport, level: 'info' as pino.Level },
      ]);
      logger = pino({ level: logLevel }, multistream);
    }
  } else if (quiet) {
    // No file, no console — silent logger
    logger = pino({ level: 'silent' });
  } else {
    logger = pino({ level: logLevel });
  }

  // Create Fastify instance
  const app = Fastify({
    loggerInstance: logger as any,
    bodyLimit: 50 * 1024 * 1024, // 50MB for large context windows
  });

  // Register error handler
  app.setErrorHandler(errorHandler);

  // Register CORS
  await app.register(cors);

  // Decorate with context
  app.decorate('serverContext', context);

  // PreHandler: extract provider,model from request body
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/')) return;

    const body = request.body as any;
    if (!body?.model) {
      return reply.code(400).send({ error: { message: 'Missing model in request body', type: 'invalid_request' } });
    }

    // Parse "provider,model" format
    const comma = (body.model as string).indexOf(',');
    if (comma === -1) {
      // No provider prefix — resolve tier from model name
      const resolved = config.resolveModel(body.model);
      (request as any).providerName = resolved.provider;
      body.model = resolved.model;
      return;
    }

    (request as any).providerName = body.model.substring(0, comma);
    body.model = body.model.substring(comma + 1);
  });

  // Register routes
  registerRoutes(app, context);

  return { app, context };
}

export function printBanner(context: ServerContext): void {
  const config = context.config;
  const appConfig = config.getConfig();
  const port = appConfig.PORT;

  console.log('\n========================================');
  console.log('  ccasr — Claude Code Agent SDK Router');
  console.log('========================================');
  console.log(`  Config:     ${config.configPath}`);
  console.log(`  Port:       ${port}`);
  console.log(`  Logging:    ${appConfig.LOG ? 'ON' : 'OFF'}`);

  // Providers
  const providers = appConfig.Providers;
  console.log(`  Providers:  ${providers.map(p => p.name).join(', ')}`);

  // Active route
  const formatEntry = (e: string) => { const i = e.indexOf(','); return `${e.substring(0, i)} / ${e.substring(i + 1)}`; };
  const routeNames = Object.keys(appConfig.Routes);
  console.log(`  Routes:     ${routeNames.join(', ')}`);
  console.log(`  Active:     ${appConfig.ActiveRoute}`);
  const router = appConfig.Router;
  console.log(`    sonnet:   ${formatEntry(router.sonnet)}`);
  if (router.opus) console.log(`    opus:     ${formatEntry(router.opus)}`);
  if (router.haiku) console.log(`    haiku:    ${formatEntry(router.haiku)}`);
  console.log('========================================');
}

export async function startServer(configPath?: string, activeRoute?: string): Promise<void> {
  const { app, context } = await createServer(configPath, activeRoute);
  const port = context.config.get('PORT');

  try {
    const address = await app.listen({ port, host: '127.0.0.1' });
    app.log.info(`Server listening on ${address}`);
    printBanner(context);
    console.log(`\nTo use with Claude Code:`);
    console.log(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
    console.log(`  export ANTHROPIC_API_KEY=any-non-empty-string\n`);

    const shutdown = async (signal: string) => {
      app.log.info(`Received ${signal}, shutting down...`);
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

export { LOGS_DIR };

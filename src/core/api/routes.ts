// API routes — exactly two endpoints:
//   POST /v1/messages  — main routing endpoint
//   GET  /health       — health check

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerContext } from '../server';
import { routeRequest } from '../../router';

const VERSION = '0.1.0';

export function registerRoutes(app: FastifyInstance, context: ServerContext): void {
  // Health check
  app.get('/health', async () => {
    return {
      status: 'ok',
      version: VERSION,
      providers: context.providers.getNames(),
      timestamp: new Date().toISOString(),
    };
  });

  // Main routing endpoint — accepts Anthropic /v1/messages format
  app.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    return routeRequest(request, reply, context);
  });

  // Gemini uses a special endpoint pattern with model in the URL path
  app.post('/v1beta/models/:modelAndAction', async (request: FastifyRequest, reply: FastifyReply) => {
    return routeRequest(request, reply, context);
  });
}

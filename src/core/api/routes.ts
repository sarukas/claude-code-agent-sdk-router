// API routes:
//   POST /v1/messages     — main routing endpoint
//   GET  /health          — health check
//   POST /v1/credentials  — register credential (gateway mode only)
//   DELETE /v1/credentials/:id — revoke credential (gateway mode only)

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerContext } from '../server';
import type { SupportedProvider } from '../types';
import { SUPPORTED_PROVIDERS } from '../types';
import { CredentialStore } from '../services/credentials';
import { routeRequest } from '../../router';

const VERSION = '0.1.2';

export function registerRoutes(app: FastifyInstance, context: ServerContext): void {
  const isGateway = context.config.mode === 'gateway';

  // Health check — enhanced in gateway mode
  app.get('/health', async () => {
    const appConfig = context.config.getConfig();
    const base: Record<string, any> = {
      status: 'ok',
      version: VERSION,
      mode: isGateway ? 'gateway' : 'standard',
      providers: context.providers.getNames(),
      transformers: context.transformers.getNames(),
      timestamp: new Date().toISOString(),
    };

    if (isGateway) {
      base.features = {
        per_request_credentials: true,
        credential_store: !!context.credentials,
        passthrough_auth: !context.proxySecret,
        streaming: true,
        image_conversion: true,
        thinking_support: true,
      };
    } else {
      base.activeRoute = appConfig.ActiveRoute;
      base.routes = Object.keys(appConfig.Routes);
    }

    return base;
  });

  // Credential store endpoints — only in gateway mode
  if (context.credentials) {
    app.post('/v1/credentials', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as any;
      if (!body?.provider || !body?.api_key) {
        return reply.code(400).send({
          error: { message: 'Missing required fields: provider, api_key', type: 'invalid_request' },
        });
      }

      if (!CredentialStore.isValidProvider(body.provider)) {
        return reply.code(400).send({
          error: {
            message: `Invalid provider "${body.provider}". Must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
            type: 'invalid_request',
          },
        });
      }

      const ttl = body.ttl_seconds ? Math.max(1, Math.min(86400, Number(body.ttl_seconds))) : undefined;
      const id = context.credentials!.register(body.provider as SupportedProvider, body.api_key, ttl);
      const expiresIn = ttl ?? 3600;

      return reply.code(201).send({
        credential_id: id,
        expires_in_seconds: expiresIn,
      });
    });

    app.delete('/v1/credentials/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const revoked = context.credentials!.revoke(id);
      if (!revoked) {
        return reply.code(404).send({
          error: { message: 'Credential not found or already expired', type: 'not_found' },
        });
      }
      return reply.code(204).send();
    });
  }

  // Main routing endpoint — accepts Anthropic /v1/messages format
  app.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    return routeRequest(request, reply, context);
  });

  // Gemini uses a special endpoint pattern with model in the URL path
  app.post('/v1beta/models/:modelAndAction', async (request: FastifyRequest, reply: FastifyReply) => {
    return routeRequest(request, reply, context);
  });
}

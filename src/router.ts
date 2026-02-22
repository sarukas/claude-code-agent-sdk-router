// Request router — the core request processing pipeline.
//
// Flow:
// 1. Claude Code sends Anthropic /v1/messages format
// 2. AnthropicTransformer.transformRequestOut converts to unified (OpenAI) format
// 3. Provider transformer.transformRequestIn converts to provider-native format
// 4. Request is sent to provider API
// 5. Provider transformer.transformResponseOut converts response to unified format
// 6. AnthropicTransformer.transformResponseIn converts back to Anthropic format
// 7. Response is streamed back to Claude Code

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ProviderConfig, Transformer } from './core/types';
import type { ServerContext } from './core/server';
import { createApiError } from './core/api/middleware';
import { TRANSFORMERS } from './core/transformers/registry';

export async function routeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ServerContext,
): Promise<void> {
  const body = request.body as any;
  const providerName = (request as any).providerName as string;

  // Resolve provider config
  const provider = context.providers.get(providerName);
  if (!provider) {
    throw createApiError(`Provider '${providerName}' not found`, 404, 'provider_not_found');
  }

  // Get the Anthropic transformer (always the endpoint transformer for Claude Code)
  const anthropicTransformer = TRANSFORMERS.anthropic;
  if (!anthropicTransformer) {
    throw createApiError('Anthropic transformer not available', 500, 'internal_error');
  }

  // Get the provider-specific transformer
  const providerTransformer = TRANSFORMERS[provider.name as keyof typeof TRANSFORMERS];

  // Determine if this is a direct Anthropic pass-through
  const isAnthropicDirect = provider.name === 'anthropic';

  // Ensure stream flag is set
  if (body.stream === undefined) body.stream = false;

  let requestBody: any = body;
  let requestConfig: any = {};

  if (isAnthropicDirect) {
    // Anthropic direct: use auth to set headers, pass request as-is
    if (anthropicTransformer.auth) {
      const auth = await anthropicTransformer.auth(requestBody, provider);
      requestBody = auth.body;
      requestConfig = auth.config || {};
    }
  } else {
    // Non-Anthropic: convert Anthropic format → unified → provider format
    // Step 1: Anthropic → unified (OpenAI) format
    if (anthropicTransformer.transformRequestOut) {
      requestBody = await anthropicTransformer.transformRequestOut(requestBody);
    }

    // Step 2: Run provider-specific request transformer (if any)
    if (providerTransformer?.transformRequestIn) {
      const result = await providerTransformer.transformRequestIn(requestBody, provider);
      if (result.body) {
        requestBody = result.body;
        requestConfig = result.config || {};
      } else {
        requestBody = result;
      }
    }

    // Set default auth headers if no custom config was set
    if (!requestConfig.headers) {
      requestConfig.headers = { 'Authorization': `Bearer ${provider.api_key}` };
    }
  }

  // Build the target URL
  const url = requestConfig.url || new URL(provider.api_base_url);

  // Prepare headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(requestConfig.headers || {}),
  };

  // Remove undefined/null headers
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === 'undefined') {
      delete headers[key];
    }
  }

  // Send request to provider
  const timeoutMs = context.config.get('API_TIMEOUT_MS');
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    request.log.error(`Provider error (${provider.name}, ${body.model}): ${response.status} ${errorText}`);
    throw createApiError(
      `Provider error (${provider.name}): ${response.status} ${errorText}`,
      response.status,
      'provider_error',
    );
  }

  // Process response through transformer chain (reverse order)
  let finalResponse: Response = response;

  if (isAnthropicDirect) {
    // Anthropic direct: pass response as-is (already in Anthropic format)
  } else {
    // Step 3: Provider response → unified (OpenAI) format
    if (providerTransformer?.transformResponseOut) {
      finalResponse = await providerTransformer.transformResponseOut(finalResponse, request.log);
    }

    // Step 4: Unified (OpenAI) → Anthropic format
    if (anthropicTransformer.transformResponseIn) {
      finalResponse = await anthropicTransformer.transformResponseIn(finalResponse);
    }
  }

  // Send response back to Claude Code
  if (body.stream) {
    reply.header('Content-Type', 'text/event-stream');
    reply.header('Cache-Control', 'no-cache');
    reply.header('Connection', 'keep-alive');
    return reply.send(finalResponse.body);
  } else {
    const json = await finalResponse.json();
    return reply.send(json);
  }
}

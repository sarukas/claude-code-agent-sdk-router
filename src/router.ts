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
//
// When LOG=true, 4-point JSONL capture is written per-provider:
//   claude_in → provider_out → provider_in → claude_out

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ProviderConfig, Transformer } from './core/types';
import type { ServerContext } from './core/server';
import { createApiError } from './core/api/middleware';
import { TRANSFORMERS } from './core/transformers/registry';
// undici is built into Node 18+ — use require to avoid needing @types/undici
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProxyAgent } = require('undici') as { ProxyAgent: new (url: string) => any };

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase();
    if (lower === 'x-api-key' || lower === 'authorization') {
      masked[key] = '***';
    }
  }
  return masked;
}

let reqCounter = 0;

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

  const capture = context.capture;
  const reqId = `req-${++reqCounter}`;

  // ── Capture point 1: claude_in — raw request from Claude Code ──
  if (capture) {
    capture.log(provider.name, 'claude_in', {
      reqId, provider: provider.name, model: body.model,
      stream: !!body.stream, body,
    });
  }

  let requestBody: any = body;
  let requestConfig: any = {};

  if (isAnthropicDirect) {
    // Anthropic direct: use auth to set headers, pass request as-is
    if (anthropicTransformer.auth) {
      const auth = await anthropicTransformer.auth(requestBody, provider);
      requestBody = auth.body;
      requestConfig = auth.config || {};
    }
    // Anthropic API needs the /v1/messages path appended to the base URL
    requestConfig.url = new URL('/v1/messages', provider.api_base_url);
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

  // ── Capture point 2: provider_out — request sent to provider API ──
  if (capture) {
    capture.log(provider.name, 'provider_out', {
      reqId, provider: provider.name, model: body.model,
      stream: !!body.stream, url: url.toString(),
      headers: maskHeaders(headers), body: requestBody,
    });
  }

  // Send request to provider
  const timeoutMs = context.config.get('API_TIMEOUT_MS');
  const proxyUrl = context.config.get('PROXY_URL');
  const fetchOptions: any = {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (proxyUrl) {
    fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
  }
  let response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    request.log.error(`Provider error (${provider.name}, ${body.model}): ${response.status} ${errorText}`);
    throw createApiError(
      `Provider error (${provider.name}): ${response.status} ${errorText}`,
      response.status,
      'provider_error',
    );
  }

  // ── Capture point 3: provider_in — raw response from provider API ──
  if (capture) {
    if (body.stream && response.body) {
      const [pipelineStream, _capturePromise] = capture.teeAndCapture(
        response.body, provider.name, 'provider_in',
        { reqId, provider: provider.name, model: body.model, status: response.status },
      );
      response = new Response(pipelineStream, {
        status: response.status,
        headers: response.headers,
      });
    } else {
      const cloned = response.clone();
      cloned.text().then(text => {
        try {
          capture.log(provider.name, 'provider_in', {
            reqId, provider: provider.name, model: body.model,
            status: response.status, body: JSON.parse(text),
          });
        } catch {
          capture.log(provider.name, 'provider_in', {
            reqId, provider: provider.name, model: body.model,
            status: response.status, body: text,
          });
        }
      }).catch(() => {});
    }
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

    // ── Capture point 4: claude_out — final streamed response to Claude Code ──
    if (capture && finalResponse.body) {
      const [pipelineStream, _capturePromise] = capture.teeAndCapture(
        finalResponse.body, provider.name, 'claude_out',
        { reqId, provider: provider.name, model: body.model },
      );
      return reply.send(pipelineStream);
    }
    return reply.send(finalResponse.body);
  } else {
    const json = await finalResponse.json();

    // ── Capture point 4: claude_out — final JSON response to Claude Code ──
    if (capture) {
      capture.log(provider.name, 'claude_out', {
        reqId, provider: provider.name, model: body.model, body: json,
      });
    }
    return reply.send(json);
  }
}

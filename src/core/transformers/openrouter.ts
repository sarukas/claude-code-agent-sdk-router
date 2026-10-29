// OpenRouterTransformer — handles OpenRouter-specific request/response quirks.
//
// OpenRouter is OpenAI-compatible but:
// - For non-Claude models: strips cache_control, normalizes image URLs
// - For Claude models: converts image URLs to base64 data URIs
// - Streaming responses may need reasoning content extraction
//
// Based on musistudio/llms openrouter.transformer.ts (MIT), simplified.

import type { Transformer, UnifiedChatRequest, ProviderConfig } from '../types';
import { sanitizeToolName, buildToolNameMap, restoreToolName } from '../utils/toolNameSanitizer';

export class OpenRouterTransformer implements Transformer {
  name = 'openrouter';
  private model = '';
  private toolNameMap: Map<string, string> = new Map();

  async transformRequestIn(request: UnifiedChatRequest, provider: ProviderConfig): Promise<Record<string, any>> {
    this.model = request.model;
    const isClaude = request.model.includes('claude');
    const isGemini = request.model.includes('google/') || request.model.includes('gemini');
    // OpenRouter normalizes cache_control breakpoints for Anthropic, Gemini,
    // and OpenAI models (interchangeable markers). Keep them for those;
    // strip for the rest, which may reject unknown fields with a 400.
    const keepsCacheControl = isClaude || isGemini || request.model.startsWith('openai/');

    // Gemini 3.8 cannot disable reasoning. SDK helper calls may explicitly
    // request disabled/zero thinking; use a small valid effort for this family.
    // Optional-reasoning models (including Gemini 2.5) retain caller controls.
    if (/^google\/gemini-3\.8(?:-|$)/.test(request.model) &&
        (request.reasoning?.enabled === false || request.reasoning?.effort === 'none' || request.reasoning?.max_tokens === 0)) {
      request.reasoning = { ...request.reasoning, enabled: true, effort: 'low' };
      delete request.reasoning.max_tokens;
    }

    // Sanitize tool names for Gemini models (rejects consecutive underscores)
    if (isGemini && request.tools?.length) {
      this.toolNameMap = buildToolNameMap(request.tools);
      for (const tool of request.tools) {
        tool.function.name = sanitizeToolName(tool.function.name);
      }
      for (const msg of request.messages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            tc.function.name = sanitizeToolName(tc.function.name);
          }
        }
      }
    } else {
      this.toolNameMap = new Map();
    }

    for (const msg of request.messages) {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content as any[]) {
          if (!keepsCacheControl && item.cache_control) {
            delete item.cache_control;
          }
          if (item.type === 'image_url') {
            if (isClaude && !item.image_url.url.startsWith('http')) {
              item.image_url.url = `data:${item.media_type};base64,${item.image_url.url}`;
            }
            delete item.media_type;
          }
        }
      } else if (!keepsCacheControl && (msg as any).cache_control) {
        delete (msg as any).cache_control;
      }
    }

    return {
      body: request,
      config: {
        headers: {
          'Authorization': `Bearer ${provider.api_key}`,
          'HTTP-Referer': 'https://github.com/sarukas/claude-code-agent-sdk-router',
          'X-Title': 'ccasr',
        },
      },
    };
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const nameMap = this.toolNameMap;
    const routedModel = this.model;
    const bufferGemini = /(?:^google\/gemini-|^gemini-)/.test(routedModel);
    const carryReasoning = (message: any) => {
      if (!message) return;
      if (message.reasoning_details?.length || typeof message.reasoning === 'string') {
        message.ccasr_reasoning = { model: routedModel,
          ...(message.reasoning_details?.length ? {reasoning_details: message.reasoning_details} : {}),
          ...(typeof message.reasoning === 'string' ? {reasoning: message.reasoning} : {}),
        };
      }
      delete message.reasoning;
      delete message.reasoning_details;
    };
    if (response.headers.get('Content-Type')?.includes('application/json')) {
      const json: any = await response.json();
      carryReasoning(json.choices?.[0]?.message);
      // Restore sanitized tool names in JSON response
      if (nameMap.size > 0 && json.choices?.[0]?.message?.tool_calls) {
        for (const tc of json.choices[0].message.tool_calls) {
          if (tc.function?.name) tc.function.name = restoreToolName(tc.function.name, nameMap);
        }
      }
      return new Response(JSON.stringify(json), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    }

    if (!response.headers.get('Content-Type')?.includes('stream') || !response.body) {
      return response;
    }

    // Streaming: pass through with reasoning content extraction and tool call ID normalization
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let hasTextContent = false;
    let hasToolCall = false;
    let buffer = '';
    const pending: any[] = [];
    let pendingBytes = 0;
    // Gemini may attach opaque state to the last tool/text chunk. The SDK uses
    // the last content block as its final result, so the carrier must precede
    // the answer. Buffer this provider response (not the whole agent run) to
    // preserve metadata without emitting an invalid out-of-order signature.
    const emitChunk = (data: any, ctrl: ReadableStreamDefaultController) => {
      if (bufferGemini) {
        pendingBytes += Buffer.byteLength(JSON.stringify(data));
        if (pendingBytes > 16 * 1024 * 1024) throw new Error('Gemini response exceeds 16 MiB compatibility buffer');
        pending.push(data);
      } else {
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }
    };
    const flushPending = (ctrl: ReadableStreamDefaultController) => {
      const reasoning: any = { model: routedModel };
      for (const chunk of pending) {
        const delta = chunk.choices?.[0]?.delta;
        const part = delta?.ccasr_reasoning;
        if (!part) continue;
        if (part.reasoning_details?.length) (reasoning.reasoning_details ??= []).push(...part.reasoning_details);
        if (part.reasoning !== undefined) reasoning.reasoning = (reasoning.reasoning ?? '') + part.reasoning;
        delete delta.ccasr_reasoning;
      }
      if (reasoning.reasoning_details?.length || reasoning.reasoning !== undefined) {
        const initial = { id: pending[0]?.id, model: pending[0]?.model ?? routedModel,
          choices: [{index:0, delta:{ccasr_reasoning:reasoning}, finish_reason:null}] };
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(initial)}\n\n`));
      }
      for (const chunk of pending) ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      pending.length = 0;
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
    };

    const stream = new ReadableStream({
      start: async (controller) => {
        const reader = response.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                for (const line of buffer.split('\n')) {
                  if (line.trim()) processLine(line, controller);
                }
              }
              break;
            }

            if (!value || value.length === 0) continue;
            let chunk: string;
            try { chunk = decoder.decode(value, { stream: true }); }
            catch { continue; }
            if (!chunk) continue;

            buffer += chunk;
            if (buffer.length > 1_000_000) {
              // Safety: flush oversized buffer
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (line.trim()) processLine(line, controller);
              }
              continue;
            }

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.trim()) processLine(line, controller);
            }
          }
          if (bufferGemini) flushPending(controller);
          controller.close();
        } catch (e) {
          controller.error(e);
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        function processLine(line: string, ctrl: ReadableStreamDefaultController) {
          if (bufferGemini && line.trim() === 'data: [DONE]') return;
          if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') {
            ctrl.enqueue(encoder.encode(line + '\n'));
            return;
          }

          try {
            const data = JSON.parse(line.slice(6));

            // OpenRouter's usage chunk repeats the real finish_reason (e.g.
            // "length" on truncation) — never overwrite it, only fill it in
            // when absent so the Anthropic side sees a terminal chunk.
            if (data.usage && data.choices?.[0] && data.choices[0].finish_reason == null) {
              data.choices[0].finish_reason = hasToolCall ? 'tool_calls' : 'stop';
            }

            if (data.choices?.[0]?.finish_reason === 'error') {
              ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: data.choices[0].error })}\n\n`));
            }

            if (data.choices?.[0]?.delta?.content && !hasTextContent) {
              hasTextContent = true;
            }

            // Keep every reasoning detail and identifier, including encrypted
            // state attached to a tool call. The Anthropic adapter persists it
            // as opaque data, not a fabricated Claude thinking signature.
            carryReasoning(data.choices?.[0]?.delta);

            // Restore sanitized tool names for Gemini models
            if (nameMap.size > 0 && data.choices?.[0]?.delta?.tool_calls?.length) {
              for (const tool of data.choices[0].delta.tool_calls) {
                if (tool.function?.name) tool.function.name = restoreToolName(tool.function.name, nameMap);
              }
            }

            if (data.choices?.[0]?.delta?.tool_calls?.length && !hasToolCall) hasToolCall = true;

            if (data.choices?.[0]?.delta?.tool_calls?.length && hasTextContent) {
              data.choices[0].index = typeof data.choices[0].index === 'number' ? data.choices[0].index + 1 : 1;
            }

            emitChunk(data, ctrl);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            ctrl.enqueue(encoder.encode(line + '\n'));
          }
        }
      },
    });

    return new Response(stream, {
      status: response.status, statusText: response.statusText,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }
}

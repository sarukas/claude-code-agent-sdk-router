// OpenRouterTransformer — handles OpenRouter-specific request/response quirks.
//
// OpenRouter is OpenAI-compatible but:
// - For non-Claude models: strips cache_control, normalizes image URLs
// - For Claude models: converts image URLs to base64 data URIs
// - Streaming responses may need reasoning content extraction
//
// Based on musistudio/llms openrouter.transformer.ts (MIT), simplified.

import type { Transformer, UnifiedChatRequest, ProviderConfig } from '../types';
import { generateToolId } from '../utils/id';
import { sanitizeToolName, buildToolNameMap, restoreToolName } from '../utils/toolNameSanitizer';

export class OpenRouterTransformer implements Transformer {
  name = 'openrouter';
  private toolNameMap: Map<string, string> = new Map();

  async transformRequestIn(request: UnifiedChatRequest, provider: ProviderConfig): Promise<Record<string, any>> {
    const isClaude = request.model.includes('claude');
    const isGemini = request.model.includes('google/') || request.model.includes('gemini');

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
          if (!isClaude && item.cache_control) {
            delete item.cache_control;
          }
          if (item.type === 'image_url') {
            if (isClaude && !item.image_url.url.startsWith('http')) {
              item.image_url.url = `data:${item.media_type};base64,${item.image_url.url}`;
            }
            delete item.media_type;
          }
        }
      } else if (!isClaude && (msg as any).cache_control) {
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
    if (response.headers.get('Content-Type')?.includes('application/json')) {
      const json: any = await response.json();
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
    let reasoningContent = '';
    let isReasoningComplete = false;
    let hasToolCall = false;
    let buffer = '';

    const stream = new ReadableStream({
      start: async (controller) => {
        const reader = response.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                for (const line of buffer.split('\n')) {
                  if (line.trim()) controller.enqueue(encoder.encode(line + '\n'));
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
        } catch (e) {
          controller.error(e);
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
          controller.close();
        }

        function processLine(line: string, ctrl: ReadableStreamDefaultController) {
          if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') {
            ctrl.enqueue(encoder.encode(line + '\n'));
            return;
          }

          try {
            const data = JSON.parse(line.slice(6));

            if (data.usage) {
              data.choices[0].finish_reason = hasToolCall ? 'tool_calls' : 'stop';
            }

            if (data.choices?.[0]?.finish_reason === 'error') {
              ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: data.choices[0].error })}\n\n`));
            }

            if (data.choices?.[0]?.delta?.content && !hasTextContent) {
              hasTextContent = true;
            }

            // Reasoning content extraction
            if (data.choices?.[0]?.delta?.reasoning) {
              reasoningContent += data.choices[0].delta.reasoning;
              const thinkingChunk = { ...data, choices: [{ ...data.choices[0], delta: { ...data.choices[0].delta, thinking: { content: data.choices[0].delta.reasoning } } }] };
              delete thinkingChunk.choices[0].delta.reasoning;
              ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(thinkingChunk)}\n\n`));
              return;
            }

            if (data.choices?.[0]?.delta?.content && reasoningContent && !isReasoningComplete) {
              isReasoningComplete = true;
              const sigChunk = { ...data, choices: [{ ...data.choices[0], delta: { ...data.choices[0].delta, content: null, thinking: { content: reasoningContent, signature: Date.now().toString() } } }] };
              delete sigChunk.choices[0].delta.reasoning;
              ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(sigChunk)}\n\n`));
            }

            if (data.choices?.[0]?.delta?.reasoning) delete data.choices[0].delta.reasoning;

            // Normalize numeric tool call IDs
            if (data.choices?.[0]?.delta?.tool_calls?.length && !Number.isNaN(parseInt(data.choices[0].delta.tool_calls[0].id, 10))) {
              for (const tool of data.choices[0].delta.tool_calls) tool.id = generateToolId();
            }

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

            ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
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

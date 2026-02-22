// AnthropicTransformer — the critical path transformer.
//
// Claude Code sends Anthropic /v1/messages format natively.
// transformRequestOut: Anthropic → OpenAI unified format
// transformResponseIn: OpenAI unified → Anthropic format (both JSON and streaming)
//
// Based on musistudio/llms anthropic.transformer.ts (MIT), heavily simplified.

import type { Transformer, UnifiedChatRequest, UnifiedMessage, ToolDefinition, ProviderConfig } from '../types';
import { formatBase64 } from '../utils/image';
import { getThinkLevel } from '../utils/thinking';
import { createApiError } from '../api/middleware';
import { generateId, generateMessageId, generateToolUseId } from '../utils/id';

export class AnthropicTransformer implements Transformer {
  name = 'Anthropic';
  endPoint = '/v1/messages';

  async auth(_request: any, provider: ProviderConfig) {
    return {
      body: _request,
      config: {
        headers: {
          'x-api-key': provider.api_key,
          'anthropic-version': '2023-06-01',
          'authorization': undefined,
        } as Record<string, string | undefined>,
      },
    };
  }

  // Anthropic /v1/messages request → OpenAI unified format
  async transformRequestOut(request: Record<string, any>): Promise<UnifiedChatRequest> {
    const messages: UnifiedMessage[] = [];

    // Handle system message
    if (request.system) {
      if (typeof request.system === 'string') {
        messages.push({ role: 'system', content: request.system });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = request.system
          .filter((item: any) => item.type === 'text' && item.text)
          .map((item: any) => ({
            type: 'text' as const,
            text: item.text,
            cache_control: item.cache_control,
          }));
        messages.push({ role: 'system', content: textParts });
      }
    }

    // Deep clone to avoid mutation
    const requestMessages = JSON.parse(JSON.stringify(request.messages || []));

    for (const msg of requestMessages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      if (msg.role === 'user') {
        // Extract tool results
        const toolParts = msg.content.filter((c: any) => c.type === 'tool_result' && c.tool_use_id);
        for (const tool of toolParts) {
          messages.push({
            role: 'tool',
            content: typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content),
            tool_call_id: tool.tool_use_id,
            cache_control: tool.cache_control,
          });
        }

        // Extract text and media
        const textAndMedia = msg.content.filter(
          (c: any) => (c.type === 'text' && c.text) || (c.type === 'image' && c.source),
        );
        if (textAndMedia.length) {
          messages.push({
            role: 'user',
            content: textAndMedia.map((part: any) => {
              if (part?.type === 'image') {
                return {
                  type: 'image_url' as const,
                  image_url: {
                    url: part.source?.type === 'base64'
                      ? formatBase64(part.source.data, part.source.media_type)
                      : part.source.url,
                  },
                  media_type: part.source.media_type,
                };
              }
              return part;
            }),
          });
        }
      } else if (msg.role === 'assistant') {
        const assistantMsg: UnifiedMessage = { role: 'assistant', content: '' };

        const textParts = msg.content.filter((c: any) => c.type === 'text' && c.text);
        if (textParts.length) {
          assistantMsg.content = textParts.map((t: any) => t.text).join('\n');
        }

        const toolCallParts = msg.content.filter((c: any) => c.type === 'tool_use' && c.id);
        if (toolCallParts.length) {
          assistantMsg.tool_calls = toolCallParts.map((tool: any) => ({
            id: tool.id,
            type: 'function' as const,
            function: { name: tool.name, arguments: JSON.stringify(tool.input || {}) },
          }));
        }

        const thinkingPart = msg.content.find((c: any) => c.type === 'thinking' && c.signature);
        if (thinkingPart) {
          assistantMsg.thinking = { content: thinkingPart.thinking, signature: thinkingPart.signature };
        }

        messages.push(assistantMsg);
      }
    }

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream,
      tools: request.tools?.length ? this.convertAnthropicTools(request.tools) : undefined,
      tool_choice: request.tool_choice,
    };

    if (request.thinking) {
      result.reasoning = {
        effort: getThinkLevel(request.thinking.budget_tokens),
        enabled: request.thinking.type === 'enabled',
      };
    }

    if (request.tool_choice) {
      if (request.tool_choice.type === 'tool') {
        result.tool_choice = { type: 'function', function: { name: request.tool_choice.name } };
      } else {
        result.tool_choice = request.tool_choice.type;
      }
    }

    return result;
  }

  // OpenAI response → Anthropic format (handles both JSON and streaming)
  async transformResponseIn(response: Response): Promise<Response> {
    const isStream = response.headers.get('Content-Type')?.includes('text/event-stream');

    if (isStream) {
      if (!response.body) throw new Error('Stream response body is null');
      const converted = this.convertOpenAIStreamToAnthropic(response.body);
      return new Response(converted, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    }

    const data = await response.json() as any;
    const anthropicResponse = this.convertOpenAIResponseToAnthropic(data);
    return new Response(JSON.stringify(anthropicResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private convertAnthropicTools(tools: any[]): ToolDefinition[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema,
      },
    }));
  }

  // Complex streaming state machine: OpenAI SSE → Anthropic SSE
  private convertOpenAIStreamToAnthropic(openaiStream: ReadableStream): ReadableStream {
    const self = this;
    return new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        const messageId = generateMessageId();
        let stopReasonMessageDelta: Record<string, any> | null = null;
        let model = 'unknown';
        let hasStarted = false;
        let hasTextContentStarted = false;
        let hasFinished = false;
        let isThinkingStarted = false;
        let isClosed = false;
        let contentIndex = 0;
        let currentContentBlockIndex = -1;
        const toolCalls = new Map<number, any>();
        const toolCallIndexToBlockIndex = new Map<number, number>();

        const assignBlockIndex = () => contentIndex++;

        const emit = (data: string) => {
          if (!isClosed) {
            try { controller.enqueue(encoder.encode(data)); }
            catch { isClosed = true; }
          }
        };

        const emitEvent = (event: string, data: Record<string, any>) => {
          emit(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const closeStream = () => {
          if (isClosed) return;
          // Close remaining content block
          if (currentContentBlockIndex >= 0) {
            emitEvent('content_block_stop', { type: 'content_block_stop', index: currentContentBlockIndex });
            currentContentBlockIndex = -1;
          }

          if (stopReasonMessageDelta) {
            emitEvent('message_delta', stopReasonMessageDelta);
          } else {
            emitEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            });
          }

          emitEvent('message_stop', { type: 'message_stop' });
          try { controller.close(); } catch { /* already closed */ }
          isClosed = true;
        };

        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        try {
          reader = openaiStream.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!isClosed) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (isClosed || hasFinished) break;
              if (!line.startsWith('data:')) continue;

              const data = line.slice(5).trim();
              if (data === '[DONE]') continue;

              try {
                const chunk = JSON.parse(data);

                if (chunk.error) {
                  emitEvent('error', { type: 'error', message: { type: 'api_error', message: JSON.stringify(chunk.error) } });
                  continue;
                }

                model = chunk.model || model;

                // Send message_start on first chunk
                if (!hasStarted && !isClosed) {
                  hasStarted = true;
                  emitEvent('message_start', {
                    type: 'message_start',
                    message: {
                      id: messageId, type: 'message', role: 'assistant', content: [],
                      model, stop_reason: null, stop_sequence: null,
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  });
                }

                const choice = chunk.choices?.[0];

                // Track usage for final message_delta
                if (chunk.usage) {
                  const usage = {
                    input_tokens: (chunk.usage.prompt_tokens || 0) - (chunk.usage.prompt_tokens_details?.cached_tokens || 0),
                    output_tokens: chunk.usage.completion_tokens || 0,
                    cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
                  };
                  if (!stopReasonMessageDelta) {
                    stopReasonMessageDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage };
                  } else {
                    stopReasonMessageDelta.usage = usage;
                  }
                }

                if (!choice) continue;

                // Thinking content
                if (choice.delta?.thinking && !isClosed && !hasFinished) {
                  if (!isThinkingStarted) {
                    const idx = assignBlockIndex();
                    emitEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
                    currentContentBlockIndex = idx;
                    isThinkingStarted = true;
                  }
                  if (choice.delta.thinking.signature) {
                    emitEvent('content_block_delta', { type: 'content_block_delta', index: currentContentBlockIndex, delta: { type: 'signature_delta', signature: choice.delta.thinking.signature } });
                    emitEvent('content_block_stop', { type: 'content_block_stop', index: currentContentBlockIndex });
                    currentContentBlockIndex = -1;
                  } else if (choice.delta.thinking.content) {
                    emitEvent('content_block_delta', { type: 'content_block_delta', index: currentContentBlockIndex, delta: { type: 'thinking_delta', thinking: choice.delta.thinking.content } });
                  }
                }

                // Text content
                if (choice.delta?.content && !isClosed && !hasFinished) {
                  // Close non-text block if open
                  if (currentContentBlockIndex >= 0 && !hasTextContentStarted) {
                    emitEvent('content_block_stop', { type: 'content_block_stop', index: currentContentBlockIndex });
                    currentContentBlockIndex = -1;
                  }

                  if (!hasTextContentStarted) {
                    hasTextContentStarted = true;
                    const idx = assignBlockIndex();
                    emitEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
                    currentContentBlockIndex = idx;
                  }

                  emitEvent('content_block_delta', { type: 'content_block_delta', index: currentContentBlockIndex, delta: { type: 'text_delta', text: choice.delta.content } });
                }

                // Annotations (web search results)
                if (choice.delta?.annotations?.length && !isClosed && !hasFinished) {
                  if (currentContentBlockIndex >= 0 && hasTextContentStarted) {
                    emitEvent('content_block_stop', { type: 'content_block_stop', index: currentContentBlockIndex });
                    currentContentBlockIndex = -1;
                    hasTextContentStarted = false;
                  }

                  for (const annotation of choice.delta.annotations) {
                    const idx = assignBlockIndex();
                    emitEvent('content_block_start', {
                      type: 'content_block_start', index: idx,
                      content_block: {
                        type: 'web_search_tool_result', tool_use_id: generateToolUseId(),
                        content: [{ type: 'web_search_result', title: annotation.url_citation.title, url: annotation.url_citation.url }],
                      },
                    });
                    emitEvent('content_block_stop', { type: 'content_block_stop', index: idx });
                    currentContentBlockIndex = -1;
                  }
                }

                // Tool calls
                if (choice.delta?.tool_calls && !isClosed && !hasFinished) {
                  const processed = new Set<number>();
                  for (const toolCall of choice.delta.tool_calls) {
                    if (isClosed) break;
                    const tcIdx = toolCall.index ?? 0;
                    if (processed.has(tcIdx)) continue;
                    processed.add(tcIdx);

                    if (!toolCallIndexToBlockIndex.has(tcIdx)) {
                      // Close previous block
                      if (currentContentBlockIndex >= 0) {
                        emitEvent('content_block_stop', { type: 'content_block_stop', index: currentContentBlockIndex });
                        currentContentBlockIndex = -1;
                      }

                      const blockIdx = assignBlockIndex();
                      toolCallIndexToBlockIndex.set(tcIdx, blockIdx);
                      const toolCallId = toolCall.id || `call_${Date.now()}_${tcIdx}`;
                      const toolCallName = toolCall.function?.name || `tool_${tcIdx}`;

                      emitEvent('content_block_start', {
                        type: 'content_block_start', index: blockIdx,
                        content_block: { type: 'tool_use', id: toolCallId, name: toolCallName, input: {} },
                      });
                      currentContentBlockIndex = blockIdx;
                      toolCalls.set(tcIdx, { id: toolCallId, name: toolCallName, arguments: '', contentBlockIndex: blockIdx });
                    }

                    if (toolCall.function?.arguments) {
                      const blockIdx = toolCallIndexToBlockIndex.get(tcIdx);
                      if (blockIdx === undefined) continue;
                      const current = toolCalls.get(tcIdx);
                      if (current) current.arguments += toolCall.function.arguments;

                      emitEvent('content_block_delta', {
                        type: 'content_block_delta', index: blockIdx,
                        delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments },
                      });
                    }
                  }
                }

                // Finish reason
                if (choice.finish_reason && !isClosed && !hasFinished) {
                  if (currentContentBlockIndex >= 0) {
                    emitEvent('content_block_stop', { type: 'content_block_stop', index: currentContentBlockIndex });
                    currentContentBlockIndex = -1;
                  }

                  const stopMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };
                  const usage = {
                    input_tokens: (chunk.usage?.prompt_tokens || 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens || 0),
                    output_tokens: chunk.usage?.completion_tokens || 0,
                    cache_read_input_tokens: chunk.usage?.prompt_tokens_details?.cached_tokens || 0,
                  };
                  stopReasonMessageDelta = {
                    type: 'message_delta',
                    delta: { stop_reason: stopMap[choice.finish_reason] || 'end_turn', stop_sequence: null },
                    usage,
                  };
                  break;
                }
              } catch { /* skip unparseable lines */ }
            }
          }

          closeStream();
        } catch (error) {
          if (!isClosed) {
            try { controller.error(error); } catch { /* already closed */ }
          }
        } finally {
          if (reader) {
            try { reader.releaseLock(); } catch { /* ignore */ }
          }
        }
      },
    });
  }

  // OpenAI JSON response → Anthropic JSON response
  private convertOpenAIResponseToAnthropic(openaiResponse: any): any {
    try {
      const choice = openaiResponse.choices?.[0];
      if (!choice) throw new Error('No choices in OpenAI response');

      const content: any[] = [];

      // Annotations → web search results
      if (choice.message?.annotations) {
        const id = generateToolUseId();
        content.push({ type: 'server_tool_use', id, name: 'web_search', input: { query: '' } });
        content.push({
          type: 'web_search_tool_result', tool_use_id: id,
          content: choice.message.annotations.map((item: any) => ({
            type: 'web_search_result', url: item.url_citation.url, title: item.url_citation.title,
          })),
        });
      }

      if (choice.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
      }

      if (choice.message?.tool_calls?.length) {
        for (const toolCall of choice.message.tool_calls) {
          let parsedInput = {};
          try {
            const args = toolCall.function.arguments || '{}';
            parsedInput = typeof args === 'object' ? args : JSON.parse(args);
          } catch {
            parsedInput = { text: toolCall.function.arguments || '' };
          }
          content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: parsedInput });
        }
      }

      if (choice.message?.thinking?.content) {
        content.push({ type: 'thinking', thinking: choice.message.thinking.content, signature: choice.message.thinking.signature });
      }

      const stopMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };

      return {
        id: openaiResponse.id,
        type: 'message',
        role: 'assistant',
        model: openaiResponse.model,
        content,
        stop_reason: stopMap[choice.finish_reason] || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: (openaiResponse.usage?.prompt_tokens || 0) - (openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0),
          output_tokens: openaiResponse.usage?.completion_tokens || 0,
          cache_read_input_tokens: openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
        },
      };
    } catch {
      throw createApiError(`Provider error: ${JSON.stringify(openaiResponse)}`, 500, 'provider_error');
    }
  }
}

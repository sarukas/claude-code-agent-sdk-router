// GeminiTransformer — handles Google Gemini API format conversion.
//
// Gemini has the most non-trivial transformation:
// - URL uses model-in-path pattern (/v1beta/models/:model:action)
// - Tool parameter types have restrictions (string format limited)
// - Streaming uses a different SSE structure
// - Thinking content uses thought:true flag and thoughtSignature
//
// Based on musistudio/llms gemini.transformer.ts + gemini.util.ts (MIT), simplified.

import type { Transformer, UnifiedChatRequest, UnifiedMessage, ToolDefinition, ProviderConfig } from '../types';

// ---------------------------------------------------------------------------
// Gemini schema processing — converts JSON Schema to Gemini-compatible format
// ---------------------------------------------------------------------------

const GEMINI_TYPE = {
  TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED',
  STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN', ARRAY: 'ARRAY', OBJECT: 'OBJECT', NULL: 'NULL',
} as const;

const VALID_SCHEMA_FIELDS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems',
  'minItems', 'properties', 'required', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering',
  'default', 'items', 'minimum', 'maximum',
]);

function cleanupParameters(obj: any, keyName?: string): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((item) => cleanupParameters(item)); return; }

  if (keyName !== 'properties') {
    for (const key of Object.keys(obj)) {
      if (!VALID_SCHEMA_FIELDS.has(key)) delete obj[key];
    }
  }
  if (obj.enum && obj.type !== 'string') delete obj.enum;
  if (obj.type === 'string' && obj.format && !['enum', 'date-time'].includes(obj.format)) delete obj.format;

  for (const key of Object.keys(obj)) cleanupParameters(obj[key], key);
}

function flattenTypeArrayToAnyOf(typeList: string[], schema: any): void {
  if (typeList.includes('null')) schema.nullable = true;
  const noNull = typeList.filter((t) => t !== 'null');

  if (noNull.length === 1) {
    const upper = noNull[0].toUpperCase();
    schema.type = Object.values(GEMINI_TYPE).includes(upper as any) ? upper : GEMINI_TYPE.TYPE_UNSPECIFIED;
  } else {
    schema.anyOf = noNull.map((t) => {
      const upper = t.toUpperCase();
      return { type: Object.values(GEMINI_TYPE).includes(upper as any) ? upper : GEMINI_TYPE.TYPE_UNSPECIFIED };
    });
  }
}

function processJsonSchema(input: any): any {
  const out: any = {};
  let schema = input;

  if (schema.type && schema.anyOf) throw new Error('type and anyOf cannot both be populated');

  // Handle nullable anyOf: [{type:'null'}, {type:'object'}]
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    if (schema.anyOf[0]?.type === 'null') { out.nullable = true; schema = schema.anyOf[1]; }
    else if (schema.anyOf[1]?.type === 'null') { out.nullable = true; schema = schema.anyOf[0]; }
  }

  if (schema.type && Array.isArray(schema.type)) flattenTypeArrayToAnyOf(schema.type, out);

  for (const [key, value] of Object.entries(schema)) {
    if (value == null) continue;
    if (key === 'type') {
      if (value === 'null') throw new Error('type: null cannot be the only type');
      if (Array.isArray(value)) continue; // already handled
      const upper = (value as string).toUpperCase();
      out.type = Object.values(GEMINI_TYPE).includes(upper as any) ? upper : GEMINI_TYPE.TYPE_UNSPECIFIED;
    } else if (key === 'items') {
      out.items = processJsonSchema(value);
    } else if (key === 'anyOf') {
      out.anyOf = (value as any[]).filter((item) => {
        if (item.type === 'null') { out.nullable = true; return false; }
        return true;
      }).map(processJsonSchema);
    } else if (key === 'properties') {
      out.properties = {};
      for (const [k, v] of Object.entries(value as any)) out.properties[k] = processJsonSchema(v);
    } else if (key === 'additionalProperties') {
      continue; // skip
    } else {
      out[key] = value;
    }
  }
  return out;
}

function transformTool(tool: any): any {
  if (tool.functionDeclarations) {
    for (const fn of tool.functionDeclarations) {
      if (fn.parameters) {
        if (!Object.keys(fn.parameters).includes('$schema')) {
          fn.parameters = processJsonSchema(fn.parameters);
        } else {
          if (!fn.parametersJsonSchema) {
            fn.parametersJsonSchema = fn.parameters;
            delete fn.parameters;
          }
        }
      }
    }
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Request body builder: unified → Gemini
// ---------------------------------------------------------------------------

function buildRequestBody(request: UnifiedChatRequest): Record<string, any> {
  const tools: any[] = [];
  const funcDecls = request.tools
    ?.filter((tool) => tool.function.name !== 'web_search')
    ?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parametersJsonSchema: tool.function.parameters,
    }));

  if (funcDecls?.length) tools.push(transformTool({ functionDeclarations: funcDecls }));

  if (request.tools?.find((t) => t.function.name === 'web_search')) {
    tools.push({ googleSearch: {} });
  }

  const contents: any[] = [];
  const toolResponses = request.messages.filter((m) => m.role === 'tool');

  for (const message of request.messages.filter((m) => m.role !== 'tool')) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [];

    if (typeof message.content === 'string') {
      const part: any = { text: message.content };
      if (message.thinking?.signature) part.thoughtSignature = message.thinking.signature;
      parts.push(part);
    } else if (Array.isArray(message.content)) {
      for (const c of message.content) {
        if (c.type === 'text') {
          parts.push({ text: (c as any).text || '' });
        } else if (c.type === 'image_url') {
          const imgC = c as any;
          if (imgC.image_url.url.startsWith('http')) {
            parts.push({ file_data: { mime_type: imgC.media_type, file_uri: imgC.image_url.url } });
          } else {
            parts.push({ inlineData: { mime_type: imgC.media_type, data: imgC.image_url.url?.split(',')?.pop() || imgC.image_url.url } });
          }
        }
      }
    }

    if (message.tool_calls) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i];
        parts.push({
          functionCall: {
            id: tc.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || '{}'),
          },
          thoughtSignature: i === 0 && message.thinking?.signature ? message.thinking.signature : undefined,
        });
      }
    }

    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role, parts });

    // Attach tool responses after model messages with tool calls
    if (role === 'model' && message.tool_calls) {
      const funcResponses = message.tool_calls.map((tc) => {
        const resp = toolResponses.find((r) => r.tool_call_id === tc.id);
        return { functionResponse: { name: tc.function.name, response: { result: resp?.content } } };
      });
      contents.push({ role: 'user', parts: funcResponses });
    }
  }

  const generationConfig: any = {};
  if (request.reasoning?.effort && request.reasoning.effort !== 'none') {
    generationConfig.thinkingConfig = { includeThoughts: true };
    if (request.model.includes('gemini-3')) {
      generationConfig.thinkingConfig.thinkingLevel = request.reasoning.effort;
    } else {
      const budgets = request.model.includes('pro') ? [128, 32768] : [0, 24576];
      if (request.reasoning.max_tokens !== undefined) {
        generationConfig.thinkingConfig.thinkingBudget = Math.max(budgets[0], Math.min(budgets[1], request.reasoning.max_tokens));
      }
    }
  }

  const body: any = { contents, tools: tools.length ? tools : undefined, generationConfig };

  if (request.tool_choice) {
    const config: any = { functionCallingConfig: {} };
    if (request.tool_choice === 'auto') config.functionCallingConfig.mode = 'auto';
    else if (request.tool_choice === 'none') config.functionCallingConfig.mode = 'none';
    else if (request.tool_choice === 'required') config.functionCallingConfig.mode = 'any';
    else if (typeof request.tool_choice === 'object' && (request.tool_choice as any).function?.name) {
      config.functionCallingConfig.mode = 'any';
      config.functionCallingConfig.allowedFunctionNames = [(request.tool_choice as any).function.name];
    }
    body.toolConfig = config;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Response conversion: Gemini → OpenAI format
// ---------------------------------------------------------------------------

function convertGeminiJsonResponse(response: Response, jsonResponse: any): Response {
  let thinkingContent = '';
  let thinkingSignature = '';
  const parts = jsonResponse.candidates?.[0]?.content?.parts || [];
  const nonThinkingParts: any[] = [];

  for (const part of parts) {
    if (part.text && part.thought === true) thinkingContent += part.text;
    else nonThinkingParts.push(part);
  }

  thinkingSignature = parts.find((p: any) => p.thoughtSignature)?.thoughtSignature || '';

  const toolCalls = nonThinkingParts
    .filter((p) => p.functionCall)
    .map((p) => ({
      id: p.functionCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    }));

  const textContent = nonThinkingParts.filter((p) => p.text).map((p) => p.text).join('\n') || '';

  const res = {
    id: jsonResponse.responseId,
    choices: [{
      finish_reason: (jsonResponse.candidates[0].finishReason as string)?.toLowerCase() || null,
      index: 0,
      message: {
        content: textContent, role: 'assistant',
        tool_calls: toolCalls.length ? toolCalls : undefined,
        ...(thinkingSignature && { thinking: { content: thinkingContent || '(no content)', signature: thinkingSignature } }),
      },
    }],
    created: Math.floor(Date.now() / 1000),
    model: jsonResponse.modelVersion,
    object: 'chat.completion',
    usage: {
      completion_tokens: jsonResponse.usageMetadata?.candidatesTokenCount || 0,
      prompt_tokens: jsonResponse.usageMetadata?.promptTokenCount || 0,
      prompt_tokens_details: { cached_tokens: jsonResponse.usageMetadata?.cachedContentTokenCount || 0 },
      total_tokens: jsonResponse.usageMetadata?.totalTokenCount || 0,
    },
  };
  return new Response(JSON.stringify(res), { status: response.status, statusText: response.statusText, headers: response.headers });
}

function convertGeminiStreamResponse(response: Response): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let signatureSent = false;
  let contentSent = false;
  let hasThinkingContent = false;
  let pendingContent = '';
  let contentIndex = 0;
  let toolCallIndex = -1;

  const stream = new ReadableStream({
    async start(controller) {
      const emitChunk = (data: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const makeChunk = (delta: any, id: string, model: string, finishReason: string | null = null, usage?: any) => ({
        choices: [{ delta, finish_reason: finishReason, index: contentIndex, logprobs: null }],
        created: Math.floor(Date.now() / 1000),
        id, model, object: 'chat.completion.chunk',
        system_fingerprint: 'fp_a49d71b8a1',
        ...(usage && { usage }),
      });

      const makeUsage = (meta: any) => ({
        completion_tokens: meta?.candidatesTokenCount || 0,
        prompt_tokens: meta?.promptTokenCount || 0,
        prompt_tokens_details: { cached_tokens: meta?.cachedContentTokenCount || 0 },
        total_tokens: meta?.totalTokenCount || 0,
      });

      const reader = response.body!.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { if (buffer) await processLine(buffer); break; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) await processLine(line);
        }
      } catch (e) { controller.error(e); }
      finally { controller.close(); }

      async function processLine(line: string) {
        if (!line.startsWith('data: ')) return;
        const str = line.slice(6).trim();
        if (!str) return;

        try {
          const chunk = JSON.parse(str);
          if (!chunk.candidates?.[0]) return;

          const candidate = chunk.candidates[0];
          const parts = candidate.content?.parts || [];
          const id = chunk.responseId || '';
          const model = chunk.modelVersion || '';

          // Thinking content
          for (const part of parts.filter((p: any) => p.text && p.thought === true)) {
            if (!hasThinkingContent) hasThinkingContent = true;
            emitChunk(makeChunk({ role: 'assistant', content: null, thinking: { content: part.text } }, id, model));
          }

          // Thinking signature
          const sig = parts.find((p: any) => p.thoughtSignature)?.thoughtSignature;
          if (sig && !signatureSent) {
            if (!hasThinkingContent) {
              emitChunk(makeChunk({ role: 'assistant', content: null, thinking: { content: '(no content)' } }, id, model));
            }
            emitChunk(makeChunk({ role: 'assistant', content: null, thinking: { signature: sig } }, id, model));
            signatureSent = true;
            contentIndex++;
            if (pendingContent) {
              emitChunk(makeChunk({ role: 'assistant', content: pendingContent }, id, model));
              pendingContent = '';
              contentSent = true;
            }
          }

          const textContent = parts.filter((p: any) => p.text && p.thought !== true).map((p: any) => p.text).join('\n');

          if (!textContent && signatureSent && !contentSent) {
            emitChunk(makeChunk({ role: 'assistant', content: '(no content)' }, id, model));
            contentSent = true;
          }

          if (hasThinkingContent && textContent && !signatureSent) {
            if (model.includes('3')) { pendingContent += textContent; return; }
            emitChunk(makeChunk({ role: 'assistant', content: null, thinking: { signature: `ccr_${Date.now()}` } }, id, model));
            signatureSent = true;
          }

          if (textContent) {
            if (!pendingContent) contentIndex++;
            const usage = makeUsage(chunk.usageMetadata);
            const res = makeChunk(
              { role: 'assistant', content: textContent },
              id, model, candidate.finishReason?.toLowerCase() || null, usage,
            );

            // Grounding metadata → annotations
            if (candidate.groundingMetadata?.groundingChunks?.length) {
              (res.choices[0].delta as any).annotations = candidate.groundingMetadata.groundingChunks.map(
                (gc: any, idx: number) => {
                  const support = candidate.groundingMetadata.groundingSupports?.filter(
                    (s: any) => s.groundingChunkIndices?.includes(idx),
                  );
                  return {
                    type: 'url_citation',
                    url_citation: {
                      url: gc?.web?.uri || '', title: gc?.web?.title || '',
                      content: support?.[0]?.segment?.text || '',
                      start_index: support?.[0]?.segment?.startIndex || 0,
                      end_index: support?.[0]?.segment?.endIndex || 0,
                    },
                  };
                },
              );
            }
            emitChunk(res);
            if (!contentSent) contentSent = true;
          }

          // Tool calls
          const fCalls = parts.filter((p: any) => p.functionCall).map((p: any) => ({
            id: p.functionCall.id || `ccr_tool_${Math.random().toString(36).substring(2, 15)}`,
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
          }));

          for (const tool of fCalls) {
            contentIndex++;
            toolCallIndex++;
            const usage = makeUsage(chunk.usageMetadata);
            const res = makeChunk(
              { role: 'assistant', tool_calls: [{ ...tool, index: toolCallIndex }] },
              id, model, candidate.finishReason?.toLowerCase() || null, usage,
            );
            emitChunk(res);
          }
        } catch { /* skip unparseable chunks */ }
      }
    },
  });

  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// ---------------------------------------------------------------------------
// GeminiTransformer class
// ---------------------------------------------------------------------------

export class GeminiTransformer implements Transformer {
  name = 'gemini';
  endPoint = '/v1beta/models/:modelAndAction';

  async transformRequestIn(request: UnifiedChatRequest, provider: ProviderConfig): Promise<Record<string, any>> {
    return {
      body: buildRequestBody(request),
      config: {
        url: new URL(
          `./${request.model}:${request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
          provider.api_base_url,
        ),
        headers: {
          'x-goog-api-key': provider.api_key,
          'Authorization': undefined,
        },
      },
    };
  }

  async transformRequestOut(request: Record<string, any>): Promise<UnifiedChatRequest> {
    const contents = request.contents;
    const tools = request.tools;
    const result: UnifiedChatRequest = {
      messages: [], model: request.model,
      max_tokens: request.max_tokens, temperature: request.temperature, stream: request.stream,
      tool_choice: request.tool_choice,
    };

    if (Array.isArray(contents)) {
      for (const content of contents) {
        if (typeof content === 'string') {
          result.messages.push({ role: 'user', content });
        } else if (content.role === 'user') {
          result.messages.push({ role: 'user', content: content.parts?.map((p: any) => ({ type: 'text' as const, text: p.text || '' })) || [] });
        } else if (content.role === 'model') {
          result.messages.push({ role: 'assistant', content: content.parts?.map((p: any) => ({ type: 'text' as const, text: p.text || '' })) || [] });
        }
      }
    }

    if (Array.isArray(tools)) {
      result.tools = [];
      for (const tool of tools) {
        if (Array.isArray(tool.functionDeclarations)) {
          for (const fn of tool.functionDeclarations) {
            result.tools.push({ type: 'function', function: { name: fn.name, description: fn.description, parameters: fn.parameters } });
          }
        }
      }
    }

    return result;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    if (response.headers.get('Content-Type')?.includes('application/json')) {
      const json = await response.json();
      return convertGeminiJsonResponse(response, json);
    } else if (response.headers.get('Content-Type')?.includes('stream')) {
      return convertGeminiStreamResponse(response);
    }
    return response;
  }
}

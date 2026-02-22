// Gemini provider tests — custom format with tool call translation.

import { TestFn, sendMessage, sendStreamMessage, sendMessageExpectError, makeToolDef, assert } from '../harness';

export const providerName = 'gemini';

export const tests: TestFn[] = [
  {
    name: 'basic_query',
    fn: async (ctx) => {
      const res = await sendMessage(ctx, {
        messages: [{ role: 'user', content: 'Reply with exactly the word: hello' }],
      });
      assert(res.content && res.content.length > 0, 'response has content');
      assert(res.content[0].type === 'text', 'content is text type');
      assert(res.content[0].text.length > 0, 'text is non-empty');
    },
  },
  {
    name: 'tool_use',
    fn: async (ctx) => {
      const res = await sendMessage(ctx, {
        messages: [{ role: 'user', content: 'What is the weather in London? You MUST use the get_weather tool.' }],
        tools: [makeToolDef('get_weather', 'Get current weather for a city', { city: { type: 'string' } })],
      });
      const toolBlocks = (res.content || []).filter((b: any) => b.type === 'tool_use');
      assert(toolBlocks.length > 0, 'response contains tool_use block');
      assert(toolBlocks[0].name === 'get_weather', 'tool name is get_weather');
    },
  },
  {
    name: 'streaming',
    fn: async (ctx) => {
      const events = await sendStreamMessage(ctx, {
        messages: [{ role: 'user', content: 'Say hello briefly.' }],
      });
      assert(events.length > 0, 'received SSE events');
      const types = events.map(e => e.data?.type).filter(Boolean);
      assert(types.includes('message_start'), 'has message_start');
      assert(types.includes('content_block_delta'), 'has content_block_delta');
      assert(types.includes('message_stop'), 'has message_stop');
    },
  },
  {
    name: 'invalid_model',
    fn: async (ctx) => {
      const { status, body } = await sendMessageExpectError(ctx, {
        messages: [{ role: 'user', content: 'test' }],
      }, { overrideModel: `${ctx.provider},nonexistent-model-xyz-99` });
      assert(status >= 400, `expected error status, got ${status}`);
      assert(body?.error || typeof body === 'string', 'response contains error info');
    },
  },
  {
    name: 'web_search',
    fn: async (ctx) => {
      // Real 2-turn web_search tool round-trip
      // Note: Gemini transformer has special handling — it converts a tool named
      // 'web_search' to googleSearch: {}. The model may do a real server-side search
      // OR call the function. Either way we test the round-trip.
      const searchTool = makeToolDef('web_search', 'Search the web for information', {
        query: { type: 'string', description: 'The search query' },
      });

      const res1 = await sendMessage(ctx, {
        messages: [{ role: 'user', content: 'Search the web for "Top 10 sights in Lithuania". You MUST use the web_search tool.' }],
        tools: [searchTool],
      }, { timeout: 90_000 });

      // Gemini may return grounding results directly (via googleSearch) OR tool_use
      const toolBlock = (res1.content || []).find((b: any) => b.type === 'tool_use');
      const hasText = (res1.content || []).some((b: any) => b.type === 'text' && b.text.length > 0);
      const hasWebResult = (res1.content || []).some((b: any) => b.type === 'web_search_tool_result');

      if (hasWebResult || (hasText && !toolBlock)) {
        // Gemini did a server-side search via googleSearch — results are inline
        assert(true, 'Gemini returned search results directly');
        return;
      }

      assert(toolBlock, 'turn 1: model should call web_search tool or return search results');
      assert(toolBlock.name === 'web_search', 'tool name should be web_search');

      const searchResults = JSON.stringify({
        results: [
          { title: 'Vilnius Old Town', snippet: 'UNESCO World Heritage Site with baroque architecture' },
          { title: 'Trakai Island Castle', snippet: 'Medieval castle on an island in Lake Galve' },
          { title: 'Hill of Crosses', snippet: 'Pilgrimage site with over 100,000 crosses near Siauliai' },
          { title: 'Curonian Spit', snippet: 'Sand dune peninsula shared with Russia, UNESCO site' },
        ],
      });

      const res2 = await sendMessage(ctx, {
        messages: [
          { role: 'user', content: 'Search the web for "Top 10 sights in Lithuania". You MUST use the web_search tool.' },
          { role: 'assistant', content: res1.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: searchResults }] },
        ],
        tools: [searchTool],
      });

      const textBlock = (res2.content || []).find((b: any) => b.type === 'text');
      assert(textBlock, 'turn 2: model should produce text response');
      assert(textBlock.text.length > 20, 'response should be substantive');
    },
  },
];

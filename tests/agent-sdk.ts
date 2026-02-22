// Agent SDK simulation test suite.
// Mimics what Claude Code sends via direct HTTP to the proxy.
// Tests full Anthropic /v1/messages round-trip including multi-turn, tool calls,
// streaming SSE, subagent patterns, and edge cases.

import {
  TestFn, TestContext,
  sendMessage, sendStreamMessage, sendMessageExpectError,
  makeToolDef, fetchUrl, assert, assertDefined,
} from './harness';

export const suiteName = 'agent-sdk';

export const tests: TestFn[] = [
  // -----------------------------------------------------------------------
  // Basic
  // -----------------------------------------------------------------------
  {
    name: 'basic_anthropic_format',
    fn: async (ctx) => {
      const res = await sendMessage(ctx, {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: test_ok' }] },
        ],
      });
      assertDefined(res.id, 'response.id');
      assert(res.type === 'message', `response.type should be 'message', got '${res.type}'`);
      assert(res.role === 'assistant', `response.role should be 'assistant', got '${res.role}'`);
      assert(Array.isArray(res.content), 'response.content should be array');
      assert(res.content.length > 0, 'response.content should be non-empty');
      const textBlock = res.content.find((c: any) => c.type === 'text');
      assert(textBlock, 'should have a text content block');
      assert(textBlock.text.length > 0, 'text should be non-empty');
      assert(res.stop_reason !== undefined, 'stop_reason should be present');
      assert(res.usage !== undefined, 'usage should be present');
    },
  },
  {
    name: 'streaming_sse_parsing',
    fn: async (ctx) => {
      const events = await sendStreamMessage(ctx, {
        messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
      });
      assert(events.length > 3, `expected >3 SSE events, got ${events.length}`);

      const types = events.map(e => e.data?.type).filter(Boolean);

      // Verify full Anthropic SSE event lifecycle
      assert(types.includes('message_start'), 'missing message_start');
      assert(types.includes('content_block_start'), 'missing content_block_start');
      assert(types.includes('content_block_delta'), 'missing content_block_delta');
      assert(types.includes('content_block_stop'), 'missing content_block_stop');
      assert(types.includes('message_delta'), 'missing message_delta');
      assert(types.includes('message_stop'), 'missing message_stop');

      // Verify message_start has expected structure
      const msgStart = events.find(e => e.data?.type === 'message_start');
      assert(msgStart?.data?.message?.role === 'assistant', 'message_start role should be assistant');

      // Verify content deltas have text
      const deltas = events.filter(e => e.data?.type === 'content_block_delta');
      assert(deltas.length > 0, 'should have content_block_delta events');
      const hasTextDelta = deltas.some(e => e.data?.delta?.type === 'text_delta' && e.data?.delta?.text);
      assert(hasTextDelta, 'should have text_delta with content');
    },
  },

  // -----------------------------------------------------------------------
  // Tool use
  // -----------------------------------------------------------------------
  {
    name: 'multi_turn_tool_call',
    fn: async (ctx) => {
      // Turn 1: Ask model to use a tool
      const res1 = await sendMessage(ctx, {
        messages: [
          { role: 'user', content: 'What is 2+2? You MUST use the calculator tool to compute this.' },
        ],
        tools: [makeToolDef('calculator', 'Evaluate a math expression', { expression: { type: 'string' } })],
      });

      const toolBlock = (res1.content || []).find((b: any) => b.type === 'tool_use');
      assert(toolBlock, 'turn 1 should have tool_use block');
      assert(toolBlock.name === 'calculator', 'tool name should be calculator');
      assertDefined(toolBlock.id, 'tool_use should have id');

      // Turn 2: Provide tool result, get final answer
      const res2 = await sendMessage(ctx, {
        messages: [
          { role: 'user', content: 'What is 2+2? You MUST use the calculator tool to compute this.' },
          { role: 'assistant', content: res1.content },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: '4',
            }],
          },
        ],
        tools: [makeToolDef('calculator', 'Evaluate a math expression', { expression: { type: 'string' } })],
      });

      const textBlock = (res2.content || []).find((b: any) => b.type === 'text');
      assert(textBlock, 'turn 2 should have text response');
      assert(textBlock.text.length > 0, 'text should be non-empty');
      // The response should reference "4" somewhere
      assert(textBlock.text.includes('4'), 'response should mention the result 4');
    },
  },
  {
    name: 'web_search_tool',
    fn: async (ctx) => {
      // Real 2-turn web_search tool round-trip
      // Model calls web_search → we return simulated results → model summarizes
      const searchTool = makeToolDef('web_search', 'Search the web for information and return results', {
        query: { type: 'string', description: 'The search query' },
      });

      // Turn 1: model should call web_search
      const res1 = await sendMessage(ctx, {
        messages: [{
          role: 'user',
          content: 'Search the web for "Top 10 sights in Lithuania" using the web_search tool. You MUST call the tool.',
        }],
        tools: [searchTool],
      }, { timeout: 90_000 });

      const toolBlock = (res1.content || []).find((b: any) => b.type === 'tool_use');
      assert(toolBlock, 'turn 1: model should call web_search tool');
      assert(toolBlock.name === 'web_search', 'tool name should be web_search');
      assert(toolBlock.input?.query, 'tool input should have a query');

      // Turn 2: provide search results, verify model uses them
      const searchResults = JSON.stringify({
        results: [
          { title: 'Vilnius Old Town', snippet: 'UNESCO World Heritage Site, stunning baroque architecture in the capital' },
          { title: 'Trakai Island Castle', snippet: 'Fairy-tale medieval castle on an island in Lake Galve' },
          { title: 'Hill of Crosses', snippet: 'Sacred pilgrimage site with over 100,000 crosses near Siauliai' },
          { title: 'Curonian Spit', snippet: 'Unique sand dune peninsula, UNESCO World Heritage Site' },
          { title: 'Gediminas Tower', snippet: 'Iconic tower overlooking Vilnius, symbol of the city' },
        ],
      });

      const res2 = await sendMessage(ctx, {
        messages: [
          { role: 'user', content: 'Search the web for "Top 10 sights in Lithuania" using the web_search tool. You MUST call the tool.' },
          { role: 'assistant', content: res1.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: searchResults }] },
        ],
        tools: [searchTool],
      });

      const textBlock = (res2.content || []).find((b: any) => b.type === 'text');
      assert(textBlock, 'turn 2: model should produce text summarizing results');
      assert(textBlock.text.length > 30, 'response should be substantive');
      const text = textBlock.text.toLowerCase();
      assert(
        text.includes('vilnius') || text.includes('trakai') || text.includes('crosses') || text.includes('curonian'),
        'response should reference search result content',
      );
    },
  },
  {
    name: 'web_fetch_tool',
    fn: async (ctx) => {
      // Real 2-turn web_fetch round-trip:
      // Turn 1: model calls web_fetch with a URL
      // Turn 2: we actually fetch the URL, return content, model summarizes
      const fetchTool = makeToolDef('web_fetch', 'Fetch content from a URL and return it as text', {
        url: { type: 'string', description: 'The URL to fetch' },
      });

      // Turn 1: ask model to fetch httpbin.org/get
      const res1 = await sendMessage(ctx, {
        messages: [{
          role: 'user',
          content: 'Use the web_fetch tool to fetch https://httpbin.org/get and then tell me the "Host" header value from the JSON response. You MUST call the tool.',
        }],
        tools: [fetchTool],
      });

      const toolBlock = (res1.content || []).find((b: any) => b.type === 'tool_use');
      assert(toolBlock, 'turn 1: model should call web_fetch');
      assert(toolBlock.name === 'web_fetch', 'tool name should be web_fetch');
      assert(toolBlock.input?.url, 'tool input should have url');

      // Actually fetch the URL
      const fetchedUrl = toolBlock.input.url;
      let fetchedContent: string;
      try {
        fetchedContent = await fetchUrl(fetchedUrl);
      } catch (err: any) {
        fetchedContent = `Error fetching ${fetchedUrl}: ${err.message}`;
      }

      // Turn 2: send fetched content back, verify model references it
      const res2 = await sendMessage(ctx, {
        messages: [
          { role: 'user', content: 'Use the web_fetch tool to fetch https://httpbin.org/get and then tell me the "Host" header value from the JSON response. You MUST call the tool.' },
          { role: 'assistant', content: res1.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: fetchedContent }] },
        ],
        tools: [fetchTool],
      });

      const textBlock = (res2.content || []).find((b: any) => b.type === 'text');
      assert(textBlock, 'turn 2: model should produce text response');
      assert(textBlock.text.length > 0, 'response should be non-empty');
      // httpbin.org/get returns JSON with "Host": "httpbin.org" — model should mention it
      assert(
        textBlock.text.toLowerCase().includes('httpbin') || textBlock.text.includes('Host'),
        'response should reference content from the fetched URL',
      );
    },
  },

  // -----------------------------------------------------------------------
  // Subagent simulation
  // -----------------------------------------------------------------------
  {
    name: 'single_subagent_call',
    fn: async (ctx) => {
      const taskTool = makeToolDef('Task', 'Launch a sub-agent to handle a task', {
        prompt: { type: 'string', description: 'The task description for the sub-agent' },
        subagent_type: { type: 'string', description: 'The type of agent: Bash, Explore, or general-purpose' },
        description: { type: 'string', description: 'Short description of the task' },
      });

      const res = await sendMessage(ctx, {
        messages: [{
          role: 'user',
          content: 'Use the Task tool to launch a sub-agent that will list the files in the current directory. Use subagent_type "Bash" and provide a short description.',
        }],
        tools: [taskTool],
      });

      const toolBlocks = (res.content || []).filter((b: any) => b.type === 'tool_use');
      assert(toolBlocks.length > 0, 'response should have Task tool_use');
      assert(toolBlocks[0].name === 'Task', 'tool name should be Task');
      assert(toolBlocks[0].input?.prompt, 'Task input should have prompt');
      assert(toolBlocks[0].input?.subagent_type, 'Task input should have subagent_type');
    },
  },
  {
    name: 'parallel_subagent_calls',
    fn: async (ctx) => {
      const taskTool = makeToolDef('Task', 'Launch a sub-agent to handle a task', {
        prompt: { type: 'string', description: 'The task description for the sub-agent' },
        subagent_type: { type: 'string', description: 'The type of agent' },
        description: { type: 'string', description: 'Short description' },
      });

      const res = await sendMessage(ctx, {
        messages: [{
          role: 'user',
          content: 'I need you to launch TWO Task tool calls in PARALLEL in a single response:\n'
            + '1. Task to search for .ts files (subagent_type: "Explore", description: "Search TS files")\n'
            + '2. Task to run git status (subagent_type: "Bash", description: "Git status")\n'
            + 'You MUST make both tool calls in a single response, not sequentially.',
        }],
        tools: [taskTool],
        max_tokens: 1024,
      });

      const toolBlocks = (res.content || []).filter((b: any) => b.type === 'tool_use');
      assert(toolBlocks.length >= 2, `expected >=2 Task tool calls, got ${toolBlocks.length}`);
      assert(toolBlocks.every((b: any) => b.name === 'Task'), 'all tool_use blocks should be Task');
    },
  },

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  {
    name: 'long_tool_list_with_call',
    fn: async (ctx) => {
      // Build 15 tool definitions
      const tools = [];
      for (let i = 1; i <= 15; i++) {
        tools.push(makeToolDef(
          `tool_${i}`,
          `Tool number ${i} — returns info about being called`,
          { input_data: { type: 'string', description: `Input data for tool ${i}` } },
        ));
      }

      const res = await sendMessage(ctx, {
        messages: [{
          role: 'user',
          content: 'You have 15 tools available (tool_1 through tool_15). '
            + 'Call ONLY tool_7 with input_data set to "test_input". '
            + 'Do NOT call any other tool. Do NOT output any text.',
        }],
        tools,
        max_tokens: 1024,
      });

      const toolBlocks = (res.content || []).filter((b: any) => b.type === 'tool_use');
      assert(toolBlocks.length > 0, 'response should have at least one tool_use');

      // Check that tool_7 was called
      const tool7 = toolBlocks.find((b: any) => b.name === 'tool_7');
      assert(tool7, 'tool_7 should be in the tool calls');
      assert(tool7.input?.input_data === 'test_input', 'tool_7 input_data should be "test_input"');
    },
  },
];

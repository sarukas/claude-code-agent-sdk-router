# Testing Guide

End-to-end test suite for ccasr. Tests exercise the real proxy against real provider APIs — no mocks, no stubs.

## Prerequisites

1. **Node.js 18.20+** installed
2. **Dependencies installed**: `npm install`
3. **Config file** at `~/.ccasr/config.json` with at least one provider configured and API keys set
4. **Proxy running** in a separate terminal

## Quick start

```bash
CD to project directory. 

# Terminal 1: start the proxy
npm run dev

# Terminal 2: run all tests
npm test
```

That's it. The runner reads your config, skips unconfigured providers, and prints a pass/fail summary.

## What gets tested

### Provider tests (per provider, 5 tests each)

Every configured provider runs through these tests:

| Test            | What it does                                        | Pass criteria                                                             |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `basic_query`   | Sends "Reply with exactly the word: hello"          | Response has `content[0].type === 'text'` with non-empty text             |
| `tool_use`      | Sends a prompt with a `get_weather` tool definition | Response contains a `tool_use` block with `name: 'get_weather'`           |
| `streaming`     | Sends `stream: true` request                        | SSE events include `message_start`, `content_block_delta`, `message_stop` |
| `invalid_model` | Sends request with `nonexistent-model-xyz-99`       | Proxy returns HTTP 4xx/5xx with error info (no crash)                     |
| `web_search`    | 2-turn tool round-trip: model calls `web_search` tool, test returns simulated results, model summarizes | Response references search result content. EXPECTED\_FAIL on Ollama (no tool calling). |

### Agent SDK tests (8 tests)

These run against the default Router target and simulate what Claude Code actually sends:

| Test                       | What it does                                                                                   | Pass criteria                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `basic_anthropic_format`   | Sends Claude Code-style request with content array                                             | Response has `id`, `type: 'message'`, `role: 'assistant'`, `usage`, `stop_reason`                                                                            |
| `streaming_sse_parsing`    | Streams a response                                                                             | Full Anthropic SSE lifecycle: `message_start` -> `content_block_start` -> `content_block_delta` -> `content_block_stop` -> `message_delta` -> `message_stop` |
| `multi_turn_tool_call`     | Turn 1: model calls `calculator` tool. Turn 2: sends tool result `4`, gets final text.         | Both turns produce correct content types, final response mentions "4"                                                                                        |
| `web_search_tool`          | 2-turn round-trip: model calls `web_search`, test returns simulated Lithuania sights, model summarizes | Response references search result content (Vilnius, Trakai, etc.)                                                                                            |
| `web_fetch_tool`           | 2-turn round-trip: model calls `web_fetch`, test actually fetches the URL via HTTP, model summarizes   | Model calls tool with URL, response references fetched content                                                                                               |
| `single_subagent_call`     | Provides `Task` tool (prompt + subagent\_type + description), asks model to launch a sub-agent | Response has `tool_use` for `Task` with expected input fields                                                                                                |
| `parallel_subagent_calls`  | Asks model to make 2 `Task` tool calls in one response                                         | Response has >= 2 `tool_use` blocks, all named `Task`                                                                                                        |
| `long_tool_list_with_call` | Provides 15 tools (`tool_1` through `tool_15`), asks model to call only `tool_7`               | Response has `tool_use` for `tool_7` with `input_data: "test_input"`                                                                                         |

## Running tests

### Full suite

```bash
npm test
```

### Single provider

```bash
npx tsx tests/runner.ts http://127.0.0.1:3456 anthropic
npx tsx tests/runner.ts http://127.0.0.1:3456 openai
npx tsx tests/runner.ts http://127.0.0.1:3456 ollama
```

### Agent SDK suite only

```bash
npx tsx tests/runner.ts http://127.0.0.1:3456 agent-sdk
```

### Single test across all providers

```bash
npx tsx tests/runner.ts http://127.0.0.1:3456 "" basic_query
npx tsx tests/runner.ts http://127.0.0.1:3456 "" streaming
```

### Single provider, single test

```bash
npx tsx tests/runner.ts http://127.0.0.1:3456 openai tool_use
```

### Custom port or URL

```bash
npx tsx tests/runner.ts http://127.0.0.1:9999
```

## CLI arguments

```
npx tsx tests/runner.ts [baseUrl] [provider] [testName]
```

| Arg        | Default                 | Description                                                      |
| ---------- | ----------------------- | ---------------------------------------------------------------- |
| `baseUrl`  | `http://127.0.0.1:3456` | Proxy URL                                                        |
| `provider` | (all configured)        | Run only this provider's tests, or `agent-sdk` for the SDK suite |
| `testName` | (all)                   | Run only tests matching this name                                |

## Understanding the output

```
========================================
  ccasr test runner
========================================
  Target:     http://127.0.0.1:3456
  Providers:  anthropic, openrouter, gemini, openai, groq
  Server:     v0.1.0 (anthropic, openrouter, gemini, openai, groq)

--- anthropic (claude-sonnet-4-20250514) ---
  PASS  basic_query (1823ms)
  PASS  tool_use (2105ms)
  PASS  streaming (1456ms)
  PASS  invalid_model (342ms)
  PASS  web_search (3201ms)

--- openai (gpt-4o) ---
  PASS  basic_query (1102ms)
  PASS  tool_use (1534ms)
  PASS  streaming (987ms)
  PASS  invalid_model (215ms)
  PASS  web_search (3456ms)

--- agent-sdk (anthropic/claude-sonnet-4-20250514) ---
  PASS  basic_anthropic_format (1654ms)
  PASS  streaming_sse_parsing (1203ms)
  PASS  multi_turn_tool_call (4521ms)
  PASS  web_search_tool (2987ms)
  PASS  web_fetch_tool (1876ms)
  PASS  single_subagent_call (1432ms)
  PASS  parallel_subagent_calls (2156ms)
  PASS  long_tool_list_with_call (1789ms)

========================================
  SUMMARY
========================================
  18 passed, 0 failed, 0 expected-fail, 18 total
  Time: 28.4s
========================================
```

**Status meanings:**

| Status  | Meaning                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PASS`  | Test passed                                                                                                                    |
| `FAIL`  | Test failed unexpectedly — a real problem                                                                                      |
| `XFAIL` | Test failed, but this was expected for this provider (e.g., web\_search on OpenAI). Not counted as a failure in the exit code. |
| `SKIP`  | Provider not in config — entire suite skipped                                                                                  |

## Results file

After every run, structured JSON results are written to:

```
~/.ccasr/logs/test-results.json
```

Format:

```json
{
  "timestamp": "2026-02-22T14:30:00.000Z",
  "baseUrl": "http://127.0.0.1:3456",
  "durationSeconds": 28.4,
  "summary": { "passed": 17, "failed": 0, "expectedFail": 1, "total": 18 },
  "results": [
    {
      "provider": "anthropic",
      "test": "basic_query",
      "passed": true,
      "durationMs": 1823
    },
    ...
  ]
}
```

## Provider-specific notes

### Anthropic

* All tests should pass. `web_search` uses a regular tool definition with simulated results.

### OpenRouter

* Uses the first model in your `models` array. Claude models via OpenRouter support most features.

### Gemini

* Tool call format is translated by the Gemini transformer (custom JSON schema → Gemini format).

* `web_search` test handles both Gemini's native `googleSearch` path and standard tool\_use path.

### OpenAI

* Near-passthrough. `max_tokens` is converted to `max_completion_tokens` for newer models.

### Groq

* Fast inference. Some models may not support tool calling well — if `tool_use` fails, try a different model in your config.

### Mistral

* Codestral and Mistral Large support tool calling.

### Ollama

* Requires Ollama running locally with the configured model pulled (`ollama pull qwen2.5-coder:latest`).

* `tool_use` and `web_search` are EXPECTED\_FAIL for most local models (many don't support function calling).

* If Ollama is not running, the test runner will report connection errors (not EXPECTED\_FAIL).

## Debugging failures

1. **Check the proxy console** — error logs show provider responses and HTTP status codes.
2. **Enable debug logging** — set `"LOG": true` in config for full request/response body logging.
3. **Check log files** — `~/.ccasr/logs/ccasr.log` has structured Pino logs.
4. **Run a single failing test** to isolate:

   ```bash
   npx tsx tests/runner.ts http://127.0.0.1:3456 openai tool_use
   ```
5. **Test the provider directly** with curl to rule out proxy issues:

   ```bash
   curl -s http://127.0.0.1:3456/v1/messages \
     -H "Content-Type: application/json" \
     -H "x-api-key: test" \
     -H "anthropic-version: 2023-06-01" \
     -d '{
       "model": "openai,gpt-4o",
       "max_tokens": 100,
       "messages": [{"role": "user", "content": "Say hello"}]
     }'
   ```

## Adding new tests

Each provider test file (`tests/providers/<name>.ts`) exports:

```typescript
export const providerName = 'name';
export const tests: TestFn[] = [ ... ];
```

Each test is:

```typescript
{
  name: 'my_test',
  expectedFailProviders: ['ollama', 'groq'],  // optional
  fn: async (ctx: TestContext) => {
    const res = await sendMessage(ctx, {
      messages: [{ role: 'user', content: '...' }],
    });
    assert(res.content[0].text.length > 0, 'got text');
  },
}
```

Helpers available from `tests/harness.ts`:

* `sendMessage(ctx, body)` — non-streaming request, returns parsed JSON

* `sendStreamMessage(ctx, body)` — streaming request, returns `SSEEvent[]`

* `sendMessageExpectError(ctx, body)` — expects non-2xx, returns `{ status, body }`

* `makeToolDef(name, desc, props, required?)` — builds Anthropic tool definition

* `fetchUrl(url, maxLength?)` — fetches a URL via HTTP GET, returns text (used for web\_fetch round-trips)

* `assert(condition, msg)` / `assertDefined(val, label)` / `assertType(val, type, label)`

Agent SDK tests go in `tests/agent-sdk.ts` with the same pattern.

The runner auto-discovers provider suites — no registration needed.

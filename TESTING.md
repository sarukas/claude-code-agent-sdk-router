# Testing Guide

End-to-end test suite for ccasr. Tests exercise the real proxy against real provider APIs — no mocks, no stubs.

## Prerequisites

1. **Node.js 18.20+** installed
2. **Dependencies installed**: `npm install`
3. **Config file** at `~/.ccasr/config.json` with at least one provider and route set configured
4. **Proxy running** in a separate terminal

## Quick start

```bash
# Terminal 1: start the proxy
npm run dev

# Terminal 2: run all tests (uses ActiveRoute from config)
npm test
```

That's it. The runner reads your config, resolves the active route set, and tests the providers and models in that route.

## How test targets are derived

Tests are driven by the **active route set**, not by iterating all providers. This means you test exactly what you'll use at runtime.

Given this config:

```json
{
  "Providers": {
    "anthropic": "$ANTHROPIC_API_KEY",
    "gemini": "$GEMINI_API_KEY"
  },
  "Routes": {
    "direct": {
      "sonnet": "anthropic,claude-sonnet-4-20250514",
      "haiku":  "anthropic,claude-haiku-4-5-20241022"
    },
    "cheap": {
      "sonnet": "gemini,gemini-2.5-flash",
      "haiku":  "gemini,gemini-2.5-flash"
    }
  },
  "ActiveRoute": "direct"
}
```

Running `npm test` tests the **"direct"** route set:
- **Provider tests**: 5 tests for `anthropic` (the only unique provider in "direct")
- **SDK tests**: 8 tests for `sonnet` tier (anthropic/claude-sonnet-4) + 8 tests for `haiku` tier (anthropic/claude-haiku-4-5)

Running `npm test -- --route cheap` tests the **"cheap"** route set:
- **Provider tests**: 5 tests for `gemini` (the only unique provider in "cheap")
- **SDK tests**: 8 tests for `sonnet` tier (gemini/gemini-2.5-flash) + 8 tests for `haiku` tier (gemini/gemini-2.5-flash)

## What gets tested

### Provider tests (per unique provider in the route, 5 tests each)

Every unique provider in the active route set runs through these tests:

| Test            | What it does                                        | Pass criteria                                                             |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `basic_query`   | Sends "Reply with exactly the word: hello"          | Response has `content[0].type === 'text'` with non-empty text             |
| `tool_use`      | Sends a prompt with a `get_weather` tool definition | Response contains a `tool_use` block with `name: 'get_weather'`           |
| `streaming`     | Sends `stream: true` request                        | SSE events include `message_start`, `content_block_delta`, `message_stop` |
| `invalid_model` | Sends request with `nonexistent-model-xyz-99`       | Proxy returns HTTP 4xx/5xx with error info (no crash)                     |
| `web_search`    | 2-turn tool round-trip: model calls `web_search` tool, test returns simulated results, model summarizes | Response references search result content. EXPECTED\_FAIL on Ollama (no tool calling). |

### Agent SDK tests (per tier in the route, 8 tests each)

These run for each tier (sonnet, opus, haiku) in the active route set and simulate what Claude Code actually sends:

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

### Full suite (active route set)

```bash
npm test
```

### Specific route set

```bash
npm test -- --route mixed
npm test -- --route cheap
npm test -- --route direct
```

### Specific test name

```bash
npm test -- --route direct streaming
npm test -- basic_query
```

### Custom port or URL

```bash
npx tsx tests/runner.ts http://127.0.0.1:9999
```

### Alternative config

```bash
npx tsx tests/runner.ts --config ./test-config.json http://127.0.0.1:3456
```

## CLI arguments

```
npx tsx tests/runner.ts [--config <path>] [--route <name>] [baseUrl] [testName]
```

| Arg          | Default                 | Description                                                 |
| ------------ | ----------------------- | ----------------------------------------------------------- |
| `--config`   | `~/.ccasr/config.json`  | Config file to read for route/provider discovery            |
| `--route`    | `ActiveRoute` in config | Which named route set to test                               |
| `baseUrl`    | `http://127.0.0.1:3456` | Proxy URL                                                   |
| `testName`   | (all)                   | Run only tests matching this name                           |

## Understanding the output

```
========================================
  ccasr test runner
========================================
  Target:     http://127.0.0.1:3456
  Config:     /home/user/.ccasr/config.json
  Route:      direct
    sonnet: anthropic / claude-sonnet-4-20250514
    opus:   anthropic / claude-opus-4-20250514
    haiku:  anthropic / claude-haiku-4-5-20241022
  Providers:  anthropic
  Server:     v0.1.0 (anthropic, gemini, openrouter)

--- anthropic (claude-sonnet-4-20250514) ---
  PASS  basic_query (1823ms)
  PASS  tool_use (2105ms)
  PASS  streaming (1456ms)
  PASS  invalid_model (342ms)
  PASS  web_search (3201ms)

--- agent-sdk:sonnet (anthropic/claude-sonnet-4-20250514) ---
  PASS  basic_anthropic_format (1654ms)
  PASS  streaming_sse_parsing (1203ms)
  PASS  multi_turn_tool_call (4521ms)
  ...

--- agent-sdk:opus (anthropic/claude-opus-4-20250514) ---
  PASS  basic_anthropic_format (2104ms)
  ...

--- agent-sdk:haiku (anthropic/claude-haiku-4-5-20241022) ---
  PASS  basic_anthropic_format (876ms)
  ...

========================================
  SUMMARY
========================================
  29 passed, 0 failed, 0 expected-fail, 29 total
  Time: 42.1s
========================================
```

**Status meanings:**

| Status  | Meaning                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PASS`  | Test passed                                                                                                                    |
| `FAIL`  | Test failed unexpectedly — a real problem                                                                                      |
| `XFAIL` | Test failed, but this was expected for this provider (e.g., web\_search on Ollama). Not counted as a failure in the exit code. |
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
  "configPath": "/home/user/.ccasr/config.json",
  "route": "direct",
  "durationSeconds": 42.1,
  "summary": { "passed": 29, "failed": 0, "expectedFail": 0, "total": 29 },
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

* Model used comes from the active route set tier that references openrouter.

### Gemini

* Tool call format is translated by the Gemini transformer (custom JSON schema -> Gemini format).
* `web_search` test handles both Gemini's native `googleSearch` path and standard tool\_use path.

### OpenAI

* Near-passthrough. `max_tokens` is converted to `max_completion_tokens` for newer models.

### Groq

* Fast inference. Some models may not support tool calling well — if `tool_use` fails, try a different model in your route set.

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
   npm test -- --route direct streaming
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

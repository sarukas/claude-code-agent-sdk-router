// Test harness — types, assertions, HTTP helpers, and test runner.
// No external test framework. Uses native fetch.

import type { SupportedProvider } from '../src/core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestResult {
  provider: string;
  test: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  expectedFail?: boolean;
}

export interface TestContext {
  baseUrl: string;
  provider: string;
  model: string;
  apiKey: string;
}

export interface TestFn {
  name: string;
  fn: (ctx: TestContext) => Promise<void>;
  /** If current provider is in this list, failure is marked EXPECTED_FAIL (not counted as real failure) */
  expectedFailProviders?: string[];
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

export function assertDefined(value: unknown, label: string): void {
  assert(value !== undefined && value !== null, `${label} should be defined`);
}

export function assertType(value: unknown, type: string, label: string): void {
  assert(typeof value === type, `${label}: expected ${type}, got ${typeof value}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Send a non-streaming request to /v1/messages in Anthropic format.
 * The model field is sent as "provider,model" so the proxy routes correctly.
 */
export async function sendMessage(
  ctx: TestContext,
  body: Record<string, unknown>,
  opts?: { timeout?: number; overrideModel?: string },
): Promise<any> {
  const model = opts?.overrideModel || `${ctx.provider},${ctx.model}`;
  const timeoutMs = opts?.timeout || 60_000;

  const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ctx.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      ...body,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return res.json();
}

/**
 * Send a request expecting an error response (non-2xx).
 * Returns { status, body } so the test can inspect the error.
 */
export async function sendMessageExpectError(
  ctx: TestContext,
  body: Record<string, unknown>,
  opts?: { timeout?: number; overrideModel?: string },
): Promise<{ status: number; body: any }> {
  const model = opts?.overrideModel || `${ctx.provider},${ctx.model}`;
  const timeoutMs = opts?.timeout || 30_000;

  const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ctx.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      ...body,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let responseBody: any;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = await res.text();
  }

  return { status: res.status, body: responseBody };
}

export interface SSEEvent {
  event?: string;
  data: any;
  raw: string;
}

/**
 * Send a streaming request and collect all SSE events.
 */
export async function sendStreamMessage(
  ctx: TestContext,
  body: Record<string, unknown>,
  opts?: { timeout?: number; overrideModel?: string },
): Promise<SSEEvent[]> {
  const model = opts?.overrideModel || `${ctx.provider},${ctx.model}`;
  const timeoutMs = opts?.timeout || 60_000;

  const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ctx.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      stream: true,
      ...body,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const events: SSEEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') continue;
        let data: any;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        events.push({ event: currentEvent, data, raw });
        currentEvent = undefined;
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Anthropic tool definition helper
// ---------------------------------------------------------------------------

export function makeToolDef(name: string, description: string, properties: Record<string, any>, required?: string[]) {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required: required || Object.keys(properties),
    },
  };
}

// ---------------------------------------------------------------------------
// Real fetch helper for web_fetch tool round-trip
// ---------------------------------------------------------------------------

/**
 * Actually fetch a URL and return its text content (truncated).
 * Used in web_fetch tool round-trip tests.
 */
export async function fetchUrl(url: string, maxLength: number = 2000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return `Error: HTTP ${res.status}`;
  const text = await res.text();
  return text.slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

export async function runTests(
  suiteName: string,
  tests: TestFn[],
  ctx: TestContext,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const t of tests) {
    const start = Date.now();
    const isExpectedFail = t.expectedFailProviders?.includes(ctx.provider) ?? false;

    try {
      await t.fn(ctx);
      results.push({
        provider: suiteName,
        test: t.name,
        passed: true,
        durationMs: Date.now() - start,
      });
    } catch (err: any) {
      results.push({
        provider: suiteName,
        test: t.name,
        passed: false,
        durationMs: Date.now() - start,
        error: err.message?.slice(0, 300),
        expectedFail: isExpectedFail,
      });
    }
  }

  return results;
}

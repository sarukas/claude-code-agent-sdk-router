// A versioned, provider/model-scoped carrier in Anthropic redacted_thinking.data.
// The SDK persists this opaque field. No cache or process-local state is needed
// to reconstruct OpenRouter reasoning after a router/SDK restart. This is not an
// Anthropic signature and must never be sent upstream as one.
const PREFIX = 'ccasr:openrouter:v1:';

export interface OpenRouterReasoning {
  model: string;
  reasoning_details?: Record<string, unknown>[];
  reasoning?: string;
}

export function encodeOpenRouterReasoning(value: OpenRouterReasoning): string {
  return PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeOpenRouterReasoning(data: unknown, model: string): OpenRouterReasoning | undefined {
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) return;
  try {
    const value = JSON.parse(Buffer.from(data.slice(PREFIX.length), 'base64').toString('utf8'));
    if (!value || value.model !== model) return;
    if (value.reasoning !== undefined && typeof value.reasoning !== 'string') return;
    if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) ||
        value.reasoning_details.some((d: any) => !d || typeof d !== 'object' || Array.isArray(d) || typeof d.type !== 'string'))) return;
    return value;
  } catch { return; }
}

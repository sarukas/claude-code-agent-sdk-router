// GroqTransformer — OpenAI-compatible, fast inference for open-source models.
//
// Groq's API is fully OpenAI-compatible. Minimal transformations needed:
// - Auth headers
// - Strip unsupported fields (reasoning, cache_control)

import type { Transformer, UnifiedChatRequest, ProviderConfig } from '../types';

export class GroqTransformer implements Transformer {
  name = 'groq';

  async transformRequestIn(request: UnifiedChatRequest, provider: ProviderConfig) {
    const body: Record<string, any> = { ...request };

    // Strip fields Groq doesn't support
    delete body.reasoning;

    // Strip cache_control from messages
    if (body.messages) {
      for (const msg of body.messages) {
        if (msg.cache_control) delete msg.cache_control;
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.cache_control) delete item.cache_control;
          }
        }
      }
    }

    return {
      body,
      config: {
        headers: { 'Authorization': `Bearer ${provider.api_key}` },
      },
    };
  }
}

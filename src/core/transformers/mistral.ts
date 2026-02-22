// MistralTransformer — OpenAI-compatible with minor edge cases.
//
// Mistral's API is mostly OpenAI-compatible but:
// - Uses 'tool-results' role instead of 'tool' for some models
// - Doesn't support cache_control
// - Doesn't support reasoning/thinking

import type { Transformer, UnifiedChatRequest, ProviderConfig } from '../types';

export class MistralTransformer implements Transformer {
  name = 'mistral';

  async transformRequestIn(request: UnifiedChatRequest, provider: ProviderConfig) {
    const body: Record<string, any> = { ...request };

    // Strip unsupported fields
    delete body.reasoning;

    // Strip cache_control and handle role edge cases
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

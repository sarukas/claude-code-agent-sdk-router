// OpenAITransformer — near-passthrough for OpenAI's native format.
//
// The unified intermediate format IS OpenAI chat completions, so this
// transformer only needs to handle auth and minor request adjustments.
// Response flows straight through to Anthropic transformer's transformResponseIn.

import type { Transformer, UnifiedChatRequest, ProviderConfig } from '../types';

export class OpenAITransformer implements Transformer {
  name = 'openai';

  async transformRequestIn(request: UnifiedChatRequest, provider: ProviderConfig) {
    const body: Record<string, any> = { ...request };

    // OpenAI uses 'max_completion_tokens' instead of 'max_tokens' for newer models
    if (body.max_tokens && !body.max_completion_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }

    // Strip fields OpenAI doesn't understand
    delete body.reasoning;

    // Strip cache_control from messages (OpenAI doesn't support it)
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

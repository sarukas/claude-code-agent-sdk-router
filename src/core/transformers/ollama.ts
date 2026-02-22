// OllamaTransformer — OpenAI-compatible local inference.
//
// Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions.
// No API key needed (uses placeholder "ollama").
// Strips unsupported fields and passes through.

import type { Transformer, UnifiedChatRequest, ProviderConfig } from '../types';

export class OllamaTransformer implements Transformer {
  name = 'ollama';

  async transformRequestIn(request: UnifiedChatRequest, _provider: ProviderConfig) {
    const body: Record<string, any> = { ...request };

    // Strip fields Ollama doesn't support
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

    // Ollama doesn't need auth, but the router sets a default Bearer header.
    // Return empty headers to skip auth (Ollama accepts any or no auth).
    return {
      body,
      config: {
        headers: {} as Record<string, string>,
      },
    };
  }
}

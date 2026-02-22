// Static transformer registry — the security boundary.
//
// ALL transformer wiring happens through this file via static TypeScript imports.
// No other file in the codebase may import a transformer directly.
// No dynamic require(), import(), or string-based loading is permitted.
//
// To add a provider: add a static import here and update SUPPORTED_PROVIDERS in types.ts.
// There is intentionally no other way.

import type { Transformer, SupportedProvider } from '../types';

// TODO: Phase 2 — replace these placeholder imports with real transformer implementations
// import { AnthropicTransformer } from './anthropic';
// import { OpenRouterTransformer } from './openrouter';
// import { GeminiTransformer } from './gemini';
// import { OpenAITransformer } from './openai';
// import { GroqTransformer } from './groq';
// import { MistralTransformer } from './mistral';
// import { OllamaTransformer } from './ollama';

export const TRANSFORMERS: Record<SupportedProvider, Transformer> = {
  // Populated in Phase 2 — static imports only
} as Record<SupportedProvider, Transformer>;

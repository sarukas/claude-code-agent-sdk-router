// Static transformer registry — the security boundary.
//
// ALL transformer wiring happens through this file via static TypeScript imports.
// No other file in the codebase may import a transformer directly.
// No dynamic require(), import(), or string-based loading is permitted.

import type { Transformer, SupportedProvider } from '../types';
import { AnthropicTransformer } from './anthropic';
import { OpenRouterTransformer } from './openrouter';
import { GeminiTransformer } from './gemini';
import { OpenAITransformer } from './openai';
import { GroqTransformer } from './groq';
import { MistralTransformer } from './mistral';
import { OllamaTransformer } from './ollama';

export const TRANSFORMERS: Partial<Record<SupportedProvider, Transformer>> = {
  anthropic: new AnthropicTransformer(),
  openrouter: new OpenRouterTransformer(),
  gemini: new GeminiTransformer(),
  openai: new OpenAITransformer(),
  groq: new GroqTransformer(),
  mistral: new MistralTransformer(),
  ollama: new OllamaTransformer(),
} as const;

export type ActiveProvider = keyof typeof TRANSFORMERS;

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

const CONSTRUCTORS: Record<SupportedProvider, new () => Transformer> = {
  anthropic: AnthropicTransformer,
  openrouter: OpenRouterTransformer,
  gemini: GeminiTransformer,
  openai: OpenAITransformer,
  groq: GroqTransformer,
  mistral: MistralTransformer,
  ollama: OllamaTransformer,
} as const;

// Request/response pairs must share one instance, never an instance with another
// in-flight request: Gemini tool-name maps are populated before awaiting fetch.
export function createTransformer(name: SupportedProvider): Transformer | undefined {
  const Constructor = Object.hasOwn(CONSTRUCTORS, name) ? CONSTRUCTORS[name] : undefined;
  return Constructor ? new Constructor() : undefined;
}

// Retained for service discovery; the HTTP pipeline uses request-local instances.
export const TRANSFORMERS = Object.fromEntries(
  Object.keys(CONSTRUCTORS).map(name => [name, createTransformer(name as SupportedProvider)]),
) as Partial<Record<SupportedProvider, Transformer>>;

export type ActiveProvider = keyof typeof TRANSFORMERS;

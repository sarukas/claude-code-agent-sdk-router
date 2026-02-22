// Provider defaults — base URLs and env var names.
// Models come from known_models.json at project root.

import type { SupportedProvider } from '../core/types';

export interface ProviderDefaults {
  label: string;
  baseUrl: string;
  envVar: string | null;  // null = no key required (Ollama)
}

export const PROVIDER_DEFAULTS: Record<SupportedProvider, ProviderDefaults> = {
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    envVar: 'ANTHROPIC_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    envVar: 'OPENROUTER_API_KEY',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/',
    envVar: 'GEMINI_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    envVar: 'OPENAI_API_KEY',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    envVar: 'GROQ_API_KEY',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',
    envVar: 'MISTRAL_API_KEY',
  },
  ollama: {
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    envVar: null,
  },
};

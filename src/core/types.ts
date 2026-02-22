// Core type definitions for claude-code-agent-sdk-router
// UnifiedChatRequest/Response use OpenAI chat completions as the intermediate format.

// ---------------------------------------------------------------------------
// Provider names — the only 7 allowed values
// ---------------------------------------------------------------------------

export const SUPPORTED_PROVIDERS = [
  'anthropic',
  'openrouter',
  'gemini',
  'openai',
  'groq',
  'mistral',
  'ollama',
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  name: SupportedProvider;
  api_base_url: string;
  api_key: string;
  models?: string[];
}

export interface RouterConfig {
  default: string;   // "providerName,modelName"
  background?: string;
}

export interface AppConfig {
  LOG: boolean;
  API_TIMEOUT_MS: number;
  PORT: number;
  PROXY_URL?: string;
  Providers: ProviderConfig[];
  Router: RouterConfig;
}

// ---------------------------------------------------------------------------
// Unified (OpenAI-compatible) intermediate format
// ---------------------------------------------------------------------------

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ContentBlock {
  type: 'text' | 'image_url' | 'tool_use' | 'tool_result';
  text?: string;
  image_url?: { url: string };
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface UnifiedChatRequest {
  model: string;
  messages: UnifiedMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface UnifiedChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: UnifiedMessage;
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Transformer interface — every provider implements this
// ---------------------------------------------------------------------------

export interface Transformer {
  /** Convert incoming request from provider-native format to unified format */
  transformRequestIn(request: unknown): UnifiedChatRequest;

  /** Convert unified request to provider-native outbound format */
  transformRequestOut(request: UnifiedChatRequest, config: ProviderConfig): unknown;

  /** Convert provider response/stream to unified format */
  transformResponseIn(response: unknown): unknown;

  /** Convert unified response back to Anthropic format for Claude Code */
  transformResponseOut(response: unknown): unknown;

  /** The Fastify route path this transformer handles (e.g., "/v1/messages") */
  endPoint(): string;
}

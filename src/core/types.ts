// Core type definitions for claude-code-agent-sdk-router
// UnifiedChatRequest/Response use OpenAI chat completions as the intermediate format.
// No external SDK type imports — all types are self-contained.

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
// Content types
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text';
  text: string;
  cache_control?: { type?: string };
}

export interface ImageContent {
  type: 'image_url';
  image_url: { url: string };
  media_type?: string;
}

export type MessageContent = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Unified (OpenAI-compatible) intermediate format
// ---------------------------------------------------------------------------

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | MessageContent[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  cache_control?: { type?: string };
  thinking?: { content: string; signature?: string };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export type ThinkLevel = 'none' | 'low' | 'medium' | 'high';

export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | string | { type: 'function'; function: { name: string } };
  reasoning?: {
    effort?: ThinkLevel;
    max_tokens?: number;
    enabled?: boolean;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Transformer interface
// ---------------------------------------------------------------------------

export interface Transformer {
  name: string;
  endPoint?: string;

  /** Anthropic request → unified request (inbound from Claude Code) */
  transformRequestOut?(request: Record<string, any>): Promise<UnifiedChatRequest>;

  /** Unified request → provider-native request (outbound to provider API) */
  transformRequestIn?(request: UnifiedChatRequest, provider: ProviderConfig): Promise<Record<string, any>>;

  /** Provider response → unified/OpenAI response (inbound from provider API) */
  transformResponseOut?(response: Response, logger?: any): Promise<Response>;

  /** Unified/OpenAI response → Anthropic response (outbound to Claude Code) */
  transformResponseIn?(response: Response): Promise<Response>;

  /** Auth header setup */
  auth?(request: any, provider: ProviderConfig): Promise<{ body: any; config: { headers: Record<string, string | undefined> } }>;
}

// ---------------------------------------------------------------------------
// API error
// ---------------------------------------------------------------------------

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
}

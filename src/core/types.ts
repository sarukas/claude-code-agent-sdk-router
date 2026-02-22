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
}

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface RouterConfig {
  opus?: string;    // "provider,model" for claude-opus-* requests
  sonnet: string;   // "provider,model" for claude-sonnet-* requests (required, fallback)
  haiku?: string;   // "provider,model" for claude-haiku-* requests
}

export interface AppConfig {
  LOG: boolean;
  API_TIMEOUT_MS: number;
  PORT: number;
  PROXY_URL?: string;
  LOG_FILE?: boolean;       // default true — write logs to ~/.ccasr/logs/
  LOG_MAX_SIZE?: string;    // default '10m' — rotate at this size
  LOG_MAX_FILES?: number;   // default 5 — keep this many rotated files
  Providers: ProviderConfig[];
  Routes: Record<string, RouterConfig>;
  ActiveRoute: string;
  Router: RouterConfig;     // resolved active route set (computed at load time)
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

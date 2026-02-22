// ConfigService — loads config from ~/.ccasr/config.json
// Interpolates $ENV_VAR references in api_key fields.
// Validates provider names against the allowed set.
// Fails hard on invalid config — no silent defaults.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import JSON5 from 'json5';
import type { AppConfig, GatewayOptions, ModelTier, ProviderConfig, RouterConfig, SupportedProvider } from '../types';
import { SUPPORTED_PROVIDERS } from '../types';

// Provider base URLs — exported for gateway mode and cli/constants
export const PROVIDER_BASE_URLS: Record<SupportedProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/',
  openai: 'https://api.openai.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  ollama: 'http://localhost:11434/v1/chat/completions',
};

const MODEL_TIER_PATTERNS: Array<{ tier: ModelTier; match: string }> = [
  { tier: 'opus',   match: 'opus' },
  { tier: 'haiku',  match: 'haiku' },
  { tier: 'sonnet', match: 'sonnet' },
];

const CONFIG_DIR = join(homedir(), '.ccasr');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Partial<AppConfig> = {
  LOG: false,
  API_TIMEOUT_MS: 300_000,
  PORT: 3456,
};

/** Interpolate $ENV_VAR references in config values */
function interpolateEnvVar(value: string): string {
  if (value.startsWith('$')) {
    const envName = value.substring(1);
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(`Environment variable ${envName} is not set (referenced in config api_key)`);
    }
    return envValue;
  }
  return value;
}

export class ConfigService {
  private config: AppConfig;
  readonly configPath: string;
  readonly mode: 'standard' | 'gateway';

  constructor(configPath?: string, activeRouteOverride?: string);
  constructor(prebuilt: AppConfig, mode: 'gateway');
  constructor(configPathOrPrebuilt?: string | AppConfig, activeRouteOrMode?: string) {
    if (typeof configPathOrPrebuilt === 'object' && configPathOrPrebuilt !== null) {
      // Gateway mode: accept pre-built AppConfig directly
      this.config = configPathOrPrebuilt;
      this.configPath = '(gateway)';
      this.mode = 'gateway';
    } else {
      this.configPath = configPathOrPrebuilt || CONFIG_FILE;
      this.config = this.loadAndValidate(this.configPath, activeRouteOrMode);
      this.mode = 'standard';
    }
  }

  /** Create a ConfigService for gateway mode — no config file needed */
  static forGateway(options: GatewayOptions = {}): ConfigService {
    // Build providers: all 7 with default base URLs, empty keys unless overridden
    const providers: ProviderConfig[] = SUPPORTED_PROVIDERS.map((name) => ({
      name,
      api_base_url: options.providerUrls?.[name] || PROVIDER_BASE_URLS[name],
      api_key: options.providers?.[name]
        ? interpolateEnvVar(options.providers[name]!)
        : '',
    }));

    const config: AppConfig = {
      LOG: false,
      API_TIMEOUT_MS: options.timeoutMs ?? 300_000,
      PORT: options.port ?? 0,
      PROXY_URL: options.proxyUrl,
      LOG_FILE: options.logToFile ?? false,
      LOG_MAX_SIZE: '10m',
      LOG_MAX_FILES: 5,
      Providers: providers,
      Routes: { gateway: { sonnet: 'anthropic,claude-sonnet-4-20250514' } },
      ActiveRoute: 'gateway',
      Router: { sonnet: 'anthropic,claude-sonnet-4-20250514' },
    };

    return new ConfigService(config, 'gateway');
  }

  private loadAndValidate(configPath: string, activeRouteOverride?: string): AppConfig {
    if (!existsSync(configPath)) {
      throw new Error(
        `Config file not found: ${configPath}\n` +
        `Create it with: mkdir -p ~/.ccasr && cp config.example.json ~/.ccasr/config.json`,
      );
    }

    let raw: any;
    try {
      const content = readFileSync(configPath, 'utf-8');
      raw = JSON5.parse(content);
    } catch (err: any) {
      throw new Error(`Failed to parse config file ${configPath}: ${err.message}`);
    }

    const config: AppConfig = {
      LOG: raw.LOG ?? DEFAULT_CONFIG.LOG!,
      API_TIMEOUT_MS: raw.API_TIMEOUT_MS ?? DEFAULT_CONFIG.API_TIMEOUT_MS!,
      PORT: raw.PORT ?? DEFAULT_CONFIG.PORT!,
      PROXY_URL: raw.PROXY_URL,
      LOG_FILE: raw.LOG_FILE !== false,         // default true
      LOG_MAX_SIZE: raw.LOG_MAX_SIZE || '10m',
      LOG_MAX_FILES: raw.LOG_MAX_FILES || 5,
      Providers: [],
      Routes: {},
      ActiveRoute: '',
      Router: { sonnet: '' },
    };

    // --- Parse Providers ---
    // New format: { "anthropic": "$KEY", ... }
    // Old format: [{ name, api_base_url, api_key, models? }, ...]
    if (raw.Providers && !Array.isArray(raw.Providers) && typeof raw.Providers === 'object') {
      // New format: object { name: apiKey }
      for (const [name, apiKey] of Object.entries(raw.Providers)) {
        this.validateProviderName(name);
        const provider = name as SupportedProvider;
        config.Providers.push({
          name: provider,
          api_base_url: PROVIDER_BASE_URLS[provider],
          api_key: this.interpolateEnvVar(apiKey as string),
        });
      }
    } else if (Array.isArray(raw.Providers) && raw.Providers.length > 0) {
      // Old format: array of provider objects (backward compat)
      for (const p of raw.Providers) {
        this.validateProviderLegacy(p);
        config.Providers.push({
          name: p.name as SupportedProvider,
          api_base_url: p.api_base_url || PROVIDER_BASE_URLS[p.name as SupportedProvider],
          api_key: this.interpolateEnvVar(p.api_key),
        });
      }
    } else {
      throw new Error('Config must have Providers (object or array)');
    }

    if (config.Providers.length === 0) {
      throw new Error('Config must have at least one provider');
    }

    // --- Parse Routes ---
    // New format: Routes: { "direct": { sonnet, opus?, haiku? }, ... } + ActiveRoute
    // Old format: Router: { sonnet, opus?, haiku? }
    if (raw.Routes && typeof raw.Routes === 'object') {
      // New format
      for (const [routeName, routeSet] of Object.entries(raw.Routes)) {
        const rs = routeSet as any;
        if (!rs.sonnet) {
          throw new Error(`Route set "${routeName}" must have a sonnet tier`);
        }
        config.Routes[routeName] = {
          sonnet: rs.sonnet,
          ...(rs.opus ? { opus: rs.opus } : {}),
          ...(rs.haiku ? { haiku: rs.haiku } : {}),
        };
      }

      if (Object.keys(config.Routes).length === 0) {
        throw new Error('Config must have at least one route set in Routes');
      }

      // Resolve active route
      const activeRouteName = activeRouteOverride || raw.ActiveRoute;
      if (!activeRouteName) {
        throw new Error('Config must have ActiveRoute (or use --route flag)');
      }
      if (!config.Routes[activeRouteName]) {
        const available = Object.keys(config.Routes).join(', ');
        throw new Error(`ActiveRoute "${activeRouteName}" not found in Routes. Available: ${available}`);
      }
      config.ActiveRoute = activeRouteName;
      config.Router = config.Routes[activeRouteName];
    } else if (raw.Router) {
      // Old format: single Router object (backward compat)
      const routerRaw = raw.Router;
      const sonnetEntry = routerRaw.sonnet || routerRaw.default;
      if (!sonnetEntry) {
        throw new Error('Config must have Router.sonnet (e.g., "anthropic,claude-sonnet-4-20250514")');
      }

      const routerConfig: RouterConfig = { sonnet: sonnetEntry };
      if (routerRaw.opus) routerConfig.opus = routerRaw.opus;
      if (routerRaw.haiku) routerConfig.haiku = routerRaw.haiku;

      config.Routes = { default: routerConfig };
      config.ActiveRoute = 'default';
      config.Router = routerConfig;
    } else {
      throw new Error('Config must have Routes (named route sets) or Router');
    }

    // Validate all tier entries in the active route set
    this.validateRouterEntry('Router.sonnet', config.Router.sonnet, config.Providers);
    if (config.Router.opus) {
      this.validateRouterEntry('Router.opus', config.Router.opus, config.Providers);
    }
    if (config.Router.haiku) {
      this.validateRouterEntry('Router.haiku', config.Router.haiku, config.Providers);
    }

    return config;
  }

  private validateProviderName(name: string): void {
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(name)) {
      throw new Error(
        `Invalid provider name "${name}". Must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
      );
    }
  }

  private validateProviderLegacy(p: any): void {
    if (!p.name || !p.api_key) {
      throw new Error(`Provider missing required fields (name, api_key): ${JSON.stringify(p)}`);
    }
    this.validateProviderName(p.name);
  }

  private validateRouterEntry(field: string, value: string, providers: ProviderConfig[]): void {
    const comma = value.indexOf(',');
    if (comma === -1) {
      throw new Error(`${field} must be "providerName,modelName" format, got: "${value}"`);
    }
    const providerName = value.substring(0, comma);
    if (!providers.some((p) => p.name === providerName)) {
      throw new Error(`${field} references provider "${providerName}" which is not configured`);
    }
  }

  private interpolateEnvVar(value: string): string {
    return interpolateEnvVar(value);
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.config.Providers.find((p) => p.name === name);
  }

  /** Parse a Router entry like "anthropic,claude-sonnet-4" into { provider, model } */
  parseRouterEntry(entry: string): { provider: string; model: string } {
    const comma = entry.indexOf(',');
    return {
      provider: entry.substring(0, comma),
      model: entry.substring(comma + 1),
    };
  }

  /** Classify an incoming model name into a tier based on substring matching */
  classifyModelTier(model: string): ModelTier {
    const lower = model.toLowerCase();
    for (const { tier, match } of MODEL_TIER_PATTERNS) {
      if (lower.includes(match)) return tier;
    }
    return 'sonnet'; // default fallback
  }

  /** Resolve an incoming model name to the configured provider and model for its tier */
  resolveModel(model: string): { provider: string; model: string } {
    const tier = this.classifyModelTier(model);
    const router = this.config.Router;
    const entry = router[tier] || router.sonnet;
    return this.parseRouterEntry(entry);
  }
}

export { CONFIG_DIR, CONFIG_FILE };

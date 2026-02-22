// ConfigService — loads config from ~/.ccasr/config.json
// Interpolates $ENV_VAR references in api_key fields.
// Validates provider names against the allowed set.
// Fails hard on invalid config — no silent defaults.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import JSON5 from 'json5';
import type { AppConfig, ModelTier, ProviderConfig, SupportedProvider } from '../types';
import { SUPPORTED_PROVIDERS } from '../types';

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

export class ConfigService {
  private config: AppConfig;

  constructor(configPath?: string) {
    const path = configPath || CONFIG_FILE;
    this.config = this.loadAndValidate(path);
  }

  private loadAndValidate(configPath: string): AppConfig {
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
      Router: { sonnet: '' },
    };

    // Validate and interpolate providers
    if (!Array.isArray(raw.Providers) || raw.Providers.length === 0) {
      throw new Error('Config must have at least one provider in Providers[]');
    }

    for (const p of raw.Providers) {
      this.validateProvider(p);
      config.Providers.push({
        name: p.name as SupportedProvider,
        api_base_url: p.api_base_url,
        api_key: this.interpolateEnvVar(p.api_key),
        models: p.models,
      });
    }

    // Validate Router
    if (!raw.Router) {
      throw new Error('Config must have a Router section');
    }

    // Backward compat: migrate Router.default → Router.sonnet
    const routerRaw = raw.Router;
    const sonnetEntry = routerRaw.sonnet || routerRaw.default;
    if (!sonnetEntry) {
      throw new Error('Config must have Router.sonnet (e.g., "anthropic,claude-sonnet-4-20250514")');
    }

    config.Router = { sonnet: sonnetEntry };
    if (routerRaw.opus) config.Router.opus = routerRaw.opus;
    if (routerRaw.haiku) config.Router.haiku = routerRaw.haiku;

    // Validate all tier entries
    this.validateRouterEntry('Router.sonnet', config.Router.sonnet, config.Providers);
    if (config.Router.opus) {
      this.validateRouterEntry('Router.opus', config.Router.opus, config.Providers);
    }
    if (config.Router.haiku) {
      this.validateRouterEntry('Router.haiku', config.Router.haiku, config.Providers);
    }

    return config;
  }

  private validateProvider(p: any): void {
    if (!p.name || !p.api_base_url || !p.api_key) {
      throw new Error(`Provider missing required fields (name, api_base_url, api_key): ${JSON.stringify(p)}`);
    }
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(p.name)) {
      throw new Error(
        `Invalid provider name "${p.name}". Must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
      );
    }
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

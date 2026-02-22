// ConfigService — loads config from ~/.ccasr/config.json
// Interpolates $ENV_VAR references. Validates provider names. Fails hard on invalid config.

import type { AppConfig } from '../types';

// TODO: Phase 3 — implement config loading, env interpolation, validation
export class ConfigService {
  private config: AppConfig | null = null;

  load(): AppConfig {
    // Placeholder — will load JSON5 file and validate
    throw new Error('ConfigService.load() not yet implemented');
  }

  getConfig(): AppConfig {
    if (!this.config) {
      this.config = this.load();
    }
    return this.config;
  }
}

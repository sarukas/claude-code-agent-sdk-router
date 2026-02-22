// ProviderService — resolves provider by name from config.
// No CDN calls. No token counting. No dynamic model registry.

import type { ProviderConfig, SupportedProvider } from '../types';

// TODO: Phase 3 — implement provider resolution
export class ProviderService {
  private providers: Map<string, ProviderConfig> = new Map();

  register(config: ProviderConfig): void {
    this.providers.set(config.name, config);
  }

  get(name: SupportedProvider): ProviderConfig | undefined {
    return this.providers.get(name);
  }
}

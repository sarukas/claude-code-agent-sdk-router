// ProviderService — resolves provider by name from config.
// No CDN calls. No token counting. No dynamic model registry.

import type { ProviderConfig, SupportedProvider } from '../types';

export class ProviderService {
  private providers = new Map<string, ProviderConfig>();

  constructor(providers: ProviderConfig[]) {
    for (const p of providers) {
      this.providers.set(p.name, p);
    }
  }

  get(name: string): ProviderConfig | undefined {
    return this.providers.get(name);
  }

  getAll(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  getNames(): string[] {
    return Array.from(this.providers.keys());
  }
}

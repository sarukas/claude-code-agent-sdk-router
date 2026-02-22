// CredentialStore — in-memory credential storage with TTL for gateway mode.
// Uses crypto.randomBytes for IDs (no new deps). Per-entry setTimeout for cleanup.

import { randomBytes } from 'crypto';
import type { SupportedProvider, StoredCredential } from '../types';
import { SUPPORTED_PROVIDERS } from '../types';

const DEFAULT_TTL_SECONDS = 3600;      // 1 hour
const MAX_TTL_SECONDS = 86400;         // 24 hours

export class CredentialStore {
  private store = new Map<string, StoredCredential>();

  register(provider: SupportedProvider, apiKey: string, ttlSeconds?: number): string {
    const ttl = Math.min(ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
    const id = `cred_${randomBytes(16).toString('hex')}`;
    const expiresAt = Date.now() + ttl * 1000;

    const timer = setTimeout(() => this.store.delete(id), ttl * 1000);
    timer.unref(); // don't block process shutdown

    this.store.set(id, { provider, api_key: apiKey, expiresAt, timer });
    return id;
  }

  resolve(id: string): StoredCredential | undefined {
    const cred = this.store.get(id);
    if (!cred) return undefined;
    if (Date.now() > cred.expiresAt) {
      this.revoke(id);
      return undefined;
    }
    return cred;
  }

  revoke(id: string): boolean {
    const cred = this.store.get(id);
    if (!cred) return false;
    clearTimeout(cred.timer);
    this.store.delete(id);
    return true;
  }

  clear(): void {
    for (const [id, cred] of this.store) {
      clearTimeout(cred.timer);
    }
    this.store.clear();
  }

  /** Validate that a provider name is in the supported set */
  static isValidProvider(name: string): name is SupportedProvider {
    return (SUPPORTED_PROVIDERS as readonly string[]).includes(name);
  }
}

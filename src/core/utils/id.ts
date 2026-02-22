// Simple ID generation — replaces uuid dependency.
// Uses crypto.randomUUID() (available in Node 19+) with fallback.

import { randomBytes } from 'crypto';

export function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID
    const bytes = randomBytes(16);
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

export function generateToolId(): string {
  return `call_${generateId()}`;
}

export function generateMessageId(): string {
  return `msg_${Date.now()}`;
}

export function generateToolUseId(): string {
  return `srvtoolu_${generateId()}`;
}

// SSE streaming helpers.
// Note: Most SSE parsing is inlined into the transformer streaming code.
// This file provides shared utilities for SSE line parsing.

/**
 * Parse an SSE buffer into complete lines, returning the remaining incomplete buffer.
 */
export function parseSSEBuffer(buffer: string): { lines: string[]; remaining: string } {
  const parts = buffer.split('\n');
  const remaining = parts.pop() || '';
  return { lines: parts, remaining };
}

/**
 * Extract the data payload from an SSE line (strips "data: " prefix).
 * Returns null for non-data lines or [DONE] sentinel.
 */
export function extractSSEData(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return null;
  return data;
}

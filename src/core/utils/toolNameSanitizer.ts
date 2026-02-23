// Tool name sanitization for Gemini API compatibility.
//
// Gemini rejects function names with consecutive underscores (e.g. mcp__server__tool).
// This module provides reversible sanitization: '__' → '_D_' on the way out,
// reverse lookup on the way back.

const DOUBLE_UNDERSCORE = /__/g;
const SANITIZED_MARKER = /_D_/g;

export function sanitizeToolName(name: string): string {
  const sanitized = name.replace(DOUBLE_UNDERSCORE, '_D_');
  return sanitized.length > 64 ? sanitized.substring(0, 64) : sanitized;
}

export function buildToolNameMap(tools: Array<{ function: { name: string } }> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!tools) return map;
  for (const tool of tools) {
    const original = tool.function.name;
    const sanitized = sanitizeToolName(original);
    if (sanitized !== original) {
      map.set(sanitized, original);
    }
  }
  return map;
}

export function restoreToolName(sanitized: string, nameMap: Map<string, string>): string {
  return nameMap.get(sanitized) ?? sanitized;
}

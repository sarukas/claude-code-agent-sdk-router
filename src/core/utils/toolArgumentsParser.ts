// Tool arguments parser — uses jsonrepair (no vm module).
// This is the security-patched version that replaces the original vm.runInContext fallback.

// TODO: Phase 2 — inline from llms with jsonrepair-only implementation
export function parseToolArguments(raw: string): unknown {
  // Placeholder
  return JSON.parse(raw);
}

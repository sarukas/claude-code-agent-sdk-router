// Tool arguments parser — uses jsonrepair (no vm module).
// Attempts: standard JSON → JSON5 → jsonrepair → {} fallback.

import JSON5 from 'json5';
import { jsonrepair } from 'jsonrepair';

export function parseToolArguments(argsString: string): string {
  if (!argsString || argsString.trim() === '' || argsString === '{}') {
    return '{}';
  }

  try {
    JSON.parse(argsString);
    return argsString;
  } catch {
    try {
      const args = JSON5.parse(argsString);
      return JSON.stringify(args);
    } catch {
      try {
        return jsonrepair(argsString);
      } catch {
        return '{}';
      }
    }
  }
}

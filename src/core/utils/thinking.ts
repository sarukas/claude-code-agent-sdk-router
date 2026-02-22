// Maps thinking budget tokens to effort level.

import type { ThinkLevel } from '../types';

export function getThinkLevel(budgetTokens: number): ThinkLevel {
  if (budgetTokens <= 0) return 'none';
  if (budgetTokens <= 1024) return 'low';
  if (budgetTokens <= 8192) return 'medium';
  return 'high';
}

// TransformerService — synchronous wrapper around the static registry.
// No initialize(), no async startup, no dynamic registration.

import type { Transformer, SupportedProvider } from '../types';
import { TRANSFORMERS } from '../transformers/registry';

export class TransformerService {
  private registry = TRANSFORMERS;

  get(name: SupportedProvider): Transformer | undefined {
    return this.registry[name];
  }

  getAll(): Transformer[] {
    return Object.values(this.registry);
  }

  has(name: string): name is SupportedProvider {
    return name in this.registry;
  }
}

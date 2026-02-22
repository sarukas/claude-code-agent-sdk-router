// Entry point — loads config, starts server.
// Also exports createGateway for library consumers.
import { startServer } from './core/server';

export { createGateway } from './core/server';
export type { GatewayInstance } from './core/server';
export type { GatewayOptions } from './core/types';

const configIdx = process.argv.indexOf('--config');
const configPath = configIdx >= 0 ? process.argv[configIdx + 1] : undefined;

startServer(configPath).catch((err) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});

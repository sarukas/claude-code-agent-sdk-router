// Entry point — loads config, starts server.
// Accepts --config <path> for alternative config file.
import { startServer } from './core/server';

const configIdx = process.argv.indexOf('--config');
const configPath = configIdx >= 0 ? process.argv[configIdx + 1] : undefined;

startServer(configPath).catch((err) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});

// Entry point — loads config, starts server.
import { startServer } from './core/server';

startServer().catch((err) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});

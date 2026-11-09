import { ConfigurationError } from '../config.js';
import { createPool } from '../database.js';
import { loadAiConfig } from './config.js';
import { createAiRepository } from './repository.js';
import { createAiServer } from './http.js';

async function main() {
  const config = loadAiConfig();
  const repository = createAiRepository(createPool(config.database, 'iskrenne-ai-http'), config);
  let server;
  try {
    await repository.checkSchema();
    server = createAiServer(repository, config);
  } catch { await repository.close(); throw new Error('AI schema/database unavailable'); }
  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 15_000);
    deadline.unref();
    await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
    await repository.close().catch(() => { code = 1; });
    clearTimeout(deadline);
    process.exitCode = code;
  }
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('uncaughtException', () => { console.error('[ai-http] fatal_error'); void shutdown(1); });
  process.on('unhandledRejection', () => { console.error('[ai-http] rejected_operation'); void shutdown(1); });
  server.on('error', () => { console.error('[ai-http] listen_failed_check_AI_PORT'); void shutdown(1); });
  server.listen(config.port, '127.0.0.1', () => console.info(`[ai-http] listening_on_loopback_${config.port}`));
}

main().catch((error) => {
  console.error(error instanceof ConfigurationError ? `[configuration] ${error.message}` : '[ai-http] startup_failed_check_database_and_migration');
  process.exitCode = 1;
});

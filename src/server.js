import { ConfigurationError, loadConfig } from './config.js';
import { createStore } from './database.js';
import { createHttpServer } from './http.js';

function main() {
  const config = loadConfig();
  const store = createStore(config.database);
  const server = createHttpServer(store, config.adminToken);
  let stopping = false;

  async function shutdown(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    console.info('[shutdown] draining_http_and_database');
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      console.error('[shutdown] deadline_exceeded');
      process.exit(1);
    }, 15_000);
    deadline.unref();
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
    } catch {
      exitCode = 1;
      console.error('[shutdown] http_close_failed');
    }
    try { await store.close(); }
    catch { exitCode = 1; console.error('[shutdown] database_close_failed'); }
    clearTimeout(deadline);
    process.exitCode = exitCode;
  }

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('uncaughtException', () => {
    console.error('[fatal] uncaught_exception');
    void shutdown(1);
  });
  process.on('unhandledRejection', () => {
    console.error('[fatal] unhandled_rejection');
    void shutdown(1);
  });
  server.on('error', () => {
    console.error('[startup] http_server_error');
    void shutdown(1);
  });
  server.listen(config.port, '0.0.0.0', () => console.info(`[startup] listening_on_port_${config.port}`));
}

try { main(); }
catch (error) {
  // Only our configuration errors are safe to print; generic errors may hold secrets.
  console.error(error instanceof ConfigurationError ? `[configuration] ${error.message}` : '[startup] initialization_failed');
  process.exitCode = 1;
}

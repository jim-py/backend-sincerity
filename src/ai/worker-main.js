import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationError } from '../config.js';
import { createPool } from '../database.js';
import { loadAiConfig } from './config.js';
import { createAiRepository } from './repository.js';
import { createOllama } from './ollama.js';
import { createWorker } from './worker.js';

process.on('uncaughtException', () => { console.error('[ai-worker] fatal_error_gate_preserved'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('[ai-worker] rejected_operation_gate_preserved'); process.exit(1); });

async function main() {
  const config = loadAiConfig();
  const repository = createAiRepository(createPool(config.database, 'iskrenne-ai-worker'), config);
  const worker = createWorker(repository, createOllama(config), config);
  let stopping = false;
  const stop = () => { stopping = true; console.info('[ai-worker] finishing_active_request_before_exit'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let lastScheduled = 0;
  try {
    await repository.checkSchema();
    while (!stopping) {
      try {
        if (Date.now() - lastScheduled >= 60_000) { await repository.schedule(); lastScheduled = Date.now(); }
        if (!await worker.once() && !stopping) await delay(500);
      } catch {
        console.error('[ai-worker] database_or_worker_error_gate_preserved');
        if (!stopping) await delay(2000);
      }
    }
  } finally { await repository.close(); }
}

main().catch((error) => {
  console.error(error instanceof ConfigurationError ? `[configuration] ${error.message}` : '[ai-worker] startup_failed_check_database_and_migration');
  process.exitCode = 1;
});

import { readFile } from 'node:fs/promises';
import { ConfigurationError } from '../config.js';
import { createPool } from '../database.js';
import { loadAiConfig } from './config.js';
import { createAiRepository } from './repository.js';
import { createOllama } from './ollama.js';

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!['migrate', 'diagnose', 'inspect-ollama', 'summary', 'recover'].includes(command)
      || (command === 'recover' && argument !== '--confirmed-idle')
      || (command === 'summary' && !/^[A-Za-z0-9_-]{1,80}$/.test(argument ?? ''))
      || (!['recover', 'summary'].includes(command) && argument)) {
    throw new ConfigurationError('Use: migrate | diagnose | inspect-ollama | summary <source> | recover --confirmed-idle');
  }
  const config = loadAiConfig();
  if (command === 'inspect-ollama') {
    const info = await createOllama(config).inspect();
    console.info(`[ai] ollama_version_${info.version}_model_metadata_checked_no_generation`);
    return;
  }
  const pool = createPool(config.database, 'iskrenne-ai-cli');
  const repository = createAiRepository(pool, config);
  try {
    if (command === 'migrate') {
      await pool.query(await readFile(new URL('../../sql/002-ai.sql', import.meta.url), 'utf8'));
      console.info('[ai] additive_migration_applied');
    } else if (command === 'diagnose') console.info(JSON.stringify(await repository.diagnostics()));
    else if (command === 'summary') {
      const result = await repository.requeue(argument);
      console.info(JSON.stringify({ state: result.state, jobId: result.jobId ?? null, current: result.current }));
    } else {
      await repository.recoverConfirmedIdle();
      console.info('[ai] gate_recovered_previous_running_job_failed');
    }
  } finally { await repository.close(); }
}

main().catch((error) => {
  console.error(error instanceof ConfigurationError ? `[configuration] ${error.message}` : '[ai-cli] operation_failed_check_configuration_or_worker');
  process.exitCode = 1;
});

import { OllamaError } from './errors.js';
import { summarySpec, validateReport } from './summary.js';

export function createWorker(repository, ollama, config, now = () => new Date()) {
  let inspected = false;
  let warmUntil = 0;
  return {
    async once() {
      const session = await repository.claim();
      if (!session) return false;
      try {
        if (!inspected) { await ollama.inspect(); inspected = true; }
        if (warmUntil <= now().getTime()) await ollama.load();
        const job = session.job;
        let result;
        if (job.kind === 'summary') {
          const spec = summarySpec(job.payload.source);
          const response = await ollama.chat({ ...spec, maxTokens: config.maxTokens });
          if (response.finishReason !== 'stop') throw new OllamaError('truncated_report', { retryable: true });
          result = validateReport(response.content, spec.schema, now());
        } else result = await ollama.chat(job.payload);
        warmUntil = now().getTime() + 25 * 60_000;
        await session.finish(result);
        console.info(`[ai-worker] ${job.kind}_completed`);
      } catch (error) {
        warmUntil = 0;
        const safe = error instanceof OllamaError ? error : new OllamaError('worker_error', { uncertain: true });
        await session.fail(safe);
        console.error(safe.uncertain ? '[ai-worker] generation_blocked' : '[ai-worker] task_failed');
      } finally { await session.release(); }
      return true;
    },
  };
}

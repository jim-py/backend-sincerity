import { randomUUID } from 'node:crypto';
import { DatabaseUnavailableError } from '../errors.js';
import { AiHttpError } from './errors.js';
import { cacheKey, canonicalJson, dateInZone, periodAt } from './summary.js';

export const LOCK_NAMESPACE = 714003;
export const GENERATION_LOCK = 1;
const ADMISSION_LOCK = 2;
const SCHEDULER_LOCK = 3;

export function retryAllowed(job, error, discarded, config, now) {
  return !error.uncertain && Boolean(error.retryable) && !discarded
    && job.attempts < config.maxAttempts && new Date(job.expires_at) > now;
}

export function createAiRepository(pool, config, now = () => new Date()) {
  async function transaction(fn, existing) {
    const client = existing ?? await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { if (!existing) client.release(); }
  }

  async function admit(client) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, ADMISSION_LOCK]);
    const gate = (await client.query('SELECT blocked FROM ai.control WHERE singleton = TRUE')).rows[0];
    if (!gate || gate.blocked) throw new AiHttpError(503, 'generation_blocked', 30);
    await client.query(`UPDATE ai.jobs SET state = 'failed', error_code = 'queue_timeout',
      payload = NULL, completed_at = clock_timestamp() WHERE state = 'queued' AND expires_at <= clock_timestamp()`);
    const { rows } = await client.query("SELECT count(*)::integer AS count FROM ai.jobs WHERE state IN ('queued', 'running')");
    if (rows[0].count >= config.queueLimit) throw new AiHttpError(429, 'queue_full', 10);
  }

  async function insertJob(client, kind, payload, source = null, key = null) {
    const id = randomUUID();
    await client.query(`INSERT INTO ai.jobs(id, kind, source, cache_key, payload, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp() + $6 * interval '1 millisecond')`,
    [id, kind, source, key, JSON.stringify(payload), config.queueWaitMs]);
    return { jobId: id, state: 'queued', statusUrl: `/ai/jobs/${id}` };
  }

  async function summaryJob(client, source) {
    const at = now();
    const key = cacheKey(source, at);
    const report = (await client.query('SELECT * FROM ai.reports WHERE source = $1', [source.source])).rows[0];
    await client.query('UPDATE ai.sources SET desired_key = $2 WHERE source = $1', [source.source, key]);
    const base = { report: report?.report ?? null, period: periodAt(at, source.timezone), timezone: source.timezone };
    if (report?.cache_key === key) return { ...base, current: true, state: 'succeeded' };
    const active = (await client.query(`SELECT id, state FROM ai.jobs WHERE source = $1 AND cache_key = $2
      AND state IN ('queued', 'running') AND (state = 'running' OR expires_at > clock_timestamp())`, [source.source, key])).rows[0];
    if (active) return { ...base, current: false, jobId: active.id, state: active.state, statusUrl: `/ai/jobs/${active.id}` };
    await admit(client);
    return { ...base, current: false, ...await insertJob(client, 'summary', { source, period: base.period }, source.source, key) };
  }

  return {
    async checkSchema() { await pool.query('SELECT active_job, blocked FROM ai.control WHERE singleton = TRUE'); },
    async rateLimit(keyHash) {
      await transaction(async (client) => {
        for (const [bucket, limit] of [[`key:${keyHash}`, config.rateLimit], ['global', config.rateLimit * 2]]) {
          const { rows } = await client.query(`INSERT INTO ai.rate_limits(bucket, window_start, requests)
            VALUES ($1, date_trunc('minute', clock_timestamp()), 1)
            ON CONFLICT (bucket) DO UPDATE SET
              requests = CASE WHEN ai.rate_limits.window_start = date_trunc('minute', clock_timestamp())
                THEN ai.rate_limits.requests + 1 ELSE 1 END,
              window_start = date_trunc('minute', clock_timestamp()) RETURNING requests`, [bucket]);
          if (rows[0].requests > limit) throw new AiHttpError(429, 'rate_limited', 60);
        }
      });
    },
    async enqueueChat(payload) {
      return transaction(async (client) => { await admit(client); return insertJob(client, 'chat', payload); });
    },
    async submitSource(options, data) {
      canonicalJson(data); // Enforces Unicode and nesting limits before persistence.
      return transaction(async (client) => {
        await client.query(`INSERT INTO ai.sources(source, data, timezone, language) VALUES ($1, $2::jsonb, $3, $4)
          ON CONFLICT (source) DO UPDATE SET data = EXCLUDED.data, timezone = EXCLUDED.timezone,
            language = EXCLUDED.language, updated_at = clock_timestamp(),
            last_scheduled_day = CASE WHEN ai.sources.timezone IS DISTINCT FROM EXCLUDED.timezone
              THEN NULL ELSE ai.sources.last_scheduled_day END`,
        [options.source, JSON.stringify(data), options.timezone, options.language]);
        return summaryJob(client, { ...options, data });
      });
    },
    async readSummary(sourceName) {
      const { rows } = await pool.query(`SELECT s.*, r.report, r.cache_key AS report_key,
        (SELECT jsonb_build_object('jobId', j.id,
          'state', CASE WHEN j.state = 'queued' AND j.expires_at <= clock_timestamp() THEN 'failed' ELSE j.state END,
          'error', CASE WHEN j.state = 'queued' AND j.expires_at <= clock_timestamp() THEN 'queue_timeout' ELSE j.error_code END)
          FROM ai.jobs j WHERE j.source = s.source ORDER BY j.created_at DESC, j.id DESC LIMIT 1) AS job
        FROM ai.sources s LEFT JOIN ai.reports r USING (source) WHERE s.source = $1`, [sourceName]);
      const source = rows[0];
      if (!source) return { report: null, current: false, state: 'empty', job: null };
      const at = now();
      const key = cacheKey(source, at);
      return { report: source.report ?? null, current: source.report_key === key,
        state: source.report_key === key ? 'succeeded' : source.job?.state ?? 'stale', job: source.job ?? null,
        period: periodAt(at, source.timezone), timezone: source.timezone };
    },
    async job(id) {
      await pool.query(`UPDATE ai.jobs SET state = 'failed', error_code = 'queue_timeout', payload = NULL,
        completed_at = clock_timestamp() WHERE id = $1 AND state = 'queued' AND expires_at <= clock_timestamp()`, [id]);
      return (await pool.query(`SELECT id, kind, state, result, error_code, created_at, completed_at
        FROM ai.jobs WHERE id = $1`, [id])).rows[0] ?? null;
    },
    async abandonChat(id) {
      await pool.query(`UPDATE ai.jobs SET discard_requested = TRUE,
        state = CASE WHEN state = 'queued' THEN 'failed' ELSE state END,
        error_code = CASE WHEN state = 'queued' THEN 'client_disconnected' ELSE error_code END,
        completed_at = CASE WHEN state = 'queued' THEN clock_timestamp() ELSE completed_at END,
        payload = CASE WHEN state = 'queued' THEN NULL ELSE payload END, result = NULL
        WHERE id = $1 AND kind = 'chat'`, [id]);
    },
    async claim() {
      const client = await pool.connect();
      let alive = true;
      let locked = false;
      const onError = () => { alive = false; };
      client.on('error', onError);
      async function release() {
        if (locked && alive) {
          try { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, GENERATION_LOCK]); }
          catch { alive = false; }
        }
        client.off('error', onError);
        client.release(!alive);
      }
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_NAMESPACE, GENERATION_LOCK])).rows[0].locked;
        if (!locked) { await release(); return null; }
        const job = await transaction(async () => {
          const gate = (await client.query('SELECT * FROM ai.control WHERE singleton = TRUE FOR UPDATE')).rows[0];
          if (!gate) throw new DatabaseUnavailableError();
          if (gate.blocked || gate.active_job) {
            await client.query('UPDATE ai.control SET blocked = TRUE WHERE singleton = TRUE');
            return null; // A previous process may still have a request executing in Ollama.
          }
          await client.query(`UPDATE ai.jobs SET state = 'failed', error_code = 'queue_timeout',
            payload = NULL, completed_at = clock_timestamp() WHERE state = 'queued' AND expires_at <= clock_timestamp()`);
          await client.query(`UPDATE ai.jobs SET result = NULL WHERE kind = 'chat' AND completed_at < clock_timestamp() - interval '5 minutes'`);
          await client.query(`DELETE FROM ai.jobs WHERE completed_at < clock_timestamp() - interval '1 day'
            AND id IS DISTINCT FROM (SELECT active_job FROM ai.control WHERE singleton = TRUE)`);
          await client.query("DELETE FROM ai.rate_limits WHERE window_start < clock_timestamp() - interval '1 day'");
          const ready = (await client.query(`SELECT * FROM ai.jobs WHERE state = 'queued' AND available_at <= clock_timestamp()
            AND expires_at > clock_timestamp()
            ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
          if (!ready) return null;
          await client.query("UPDATE ai.jobs SET state = 'running', attempts = attempts + 1, started_at = clock_timestamp() WHERE id = $1", [ready.id]);
          await client.query('UPDATE ai.control SET active_job = $1 WHERE singleton = TRUE', [ready.id]);
          return { ...ready, attempts: ready.attempts + 1 };
        }, client);
        if (!job) { await release(); return null; }
        return {
          job,
          async finish(result) {
            if (!alive) throw new DatabaseUnavailableError();
            await transaction(async () => {
              const current = (await client.query('SELECT discard_requested FROM ai.jobs WHERE id = $1 FOR UPDATE', [job.id])).rows[0];
              let stored = result;
              if (job.kind === 'summary') {
                const source = (await client.query('SELECT * FROM ai.sources WHERE source = $1 FOR UPDATE', [job.source])).rows[0];
                const publish = source.desired_key === job.cache_key && cacheKey(source, now()) === job.cache_key;
                if (publish) {
                  await client.query(`INSERT INTO ai.reports(source, cache_key, report, period) VALUES ($1, $2, $3::jsonb, $4::jsonb)
                    ON CONFLICT (source) DO UPDATE SET cache_key = EXCLUDED.cache_key, report = EXCLUDED.report,
                      period = EXCLUDED.period, generated_at = clock_timestamp()`,
                  [job.source, job.cache_key, JSON.stringify(result), JSON.stringify(job.payload.period)]);
                }
                stored = { published: publish }; // The previous report remains readable on failure or stale completion.
              }
              await client.query(`UPDATE ai.jobs SET state = 'succeeded', payload = NULL, result = $2::jsonb,
                completed_at = clock_timestamp() WHERE id = $1`, [job.id, current.discard_requested ? null : JSON.stringify(stored)]);
              await client.query('UPDATE ai.control SET active_job = NULL WHERE singleton = TRUE AND active_job = $1', [job.id]);
            }, client);
          },
          async fail(error) {
            if (!alive) throw new DatabaseUnavailableError();
            await transaction(async () => {
              const current = (await client.query('SELECT discard_requested FROM ai.jobs WHERE id = $1 FOR UPDATE', [job.id])).rows[0];
              const retry = retryAllowed(job, error, current.discard_requested, config, now());
              await client.query(`UPDATE ai.jobs SET state = $2, error_code = $3,
                payload = CASE WHEN $4 THEN payload ELSE NULL END,
                available_at = clock_timestamp() + $5 * interval '1 millisecond',
                completed_at = CASE WHEN $4 THEN NULL ELSE clock_timestamp() END WHERE id = $1`,
              [job.id, retry ? 'queued' : 'failed', error.uncertain ? 'upstream_uncertain' : error.code,
                retry, 1000 * 2 ** (job.attempts - 1)]);
              await client.query('UPDATE ai.control SET blocked = $2, active_job = CASE WHEN $2 THEN active_job ELSE NULL END WHERE singleton = TRUE AND active_job = $1',
                [job.id, Boolean(error.uncertain)]);
            }, client);
          },
          release,
        };
      } catch (error) { await release(); throw error; }
    },
    async schedule() {
      const client = await pool.connect();
      let locked = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_NAMESPACE, SCHEDULER_LOCK])).rows[0].locked;
        if (!locked) return;
        for (;;) {
          const { rows } = await client.query(`SELECT source FROM ai.sources WHERE
            (last_scheduled_day IS NULL OR last_scheduled_day < (clock_timestamp() AT TIME ZONE timezone)::date)
            AND EXTRACT(HOUR FROM clock_timestamp() AT TIME ZONE timezone) >= 3 ORDER BY source LIMIT 100`);
          if (rows.length === 0) return;
          for (const row of rows) {
            try {
              await transaction(async () => {
                const source = (await client.query('SELECT *, last_scheduled_day::text AS scheduled_day FROM ai.sources WHERE source = $1 FOR UPDATE', [row.source])).rows[0];
                const { day, hour } = dateInZone(now(), source.timezone);
                if (hour < 3 || source.scheduled_day === day) return;
                await summaryJob(client, source);
                await client.query('UPDATE ai.sources SET last_scheduled_day = $2::date WHERE source = $1', [source.source, day]);
              }, client);
            } catch (error) {
              if (error instanceof AiHttpError && [429, 503].includes(error.status)) return;
              throw error;
            }
          }
        }
      } finally {
        if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, SCHEDULER_LOCK]).catch(() => {});
        client.release();
      }
    },
    async diagnostics() {
      const gate = (await pool.query('SELECT blocked, active_job IS NOT NULL AS active FROM ai.control WHERE singleton = TRUE')).rows[0];
      const counts = (await pool.query('SELECT kind, state, count(*)::integer AS count FROM ai.jobs GROUP BY kind, state')).rows;
      return { gate, counts };
    },
    async recoverConfirmedIdle() {
      const client = await pool.connect();
      let locked = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_NAMESPACE, GENERATION_LOCK])).rows[0].locked;
        if (!locked) throw new AiHttpError(409, 'worker_still_active');
        await transaction(async () => {
          await client.query(`UPDATE ai.jobs SET state = 'failed', error_code = 'worker_interrupted', payload = NULL,
            result = NULL, completed_at = clock_timestamp() WHERE id = (SELECT active_job FROM ai.control WHERE singleton = TRUE)`);
          await client.query('UPDATE ai.control SET active_job = NULL, blocked = FALSE WHERE singleton = TRUE');
        }, client);
      } finally {
        if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, GENERATION_LOCK]).catch(() => {});
        client.release();
      }
    },
    async requeue(sourceName) {
      return transaction(async (client) => {
        const source = (await client.query('SELECT * FROM ai.sources WHERE source = $1 FOR UPDATE', [sourceName])).rows[0];
        if (!source) throw new AiHttpError(404, 'source_not_found');
        return summaryJob(client, source);
      });
    },
    close: () => pool.end(),
  };
}

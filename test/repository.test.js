import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAiRepository, retryAllowed } from '../src/ai/repository.js';
import { OllamaError } from '../src/ai/errors.js';
import { dateInZone } from '../src/ai/summary.js';
import { config } from './helpers.js';

test('retry policy bounds attempts/deadline and never repeats uncertain or discarded requests', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const job = { attempts: 1, expires_at: '2026-11-09T00:01:00Z' };
  const transient = new OllamaError('upstream_rejected', { retryable: true });
  assert.equal(retryAllowed(job, transient, false, config, now), true);
  assert.equal(retryAllowed({ ...job, attempts: 2 }, transient, false, config, now), false);
  assert.equal(retryAllowed(job, transient, true, config, now), false);
  assert.equal(retryAllowed(job, new OllamaError('upstream_timeout', { uncertain: true, retryable: true }), false, config, now), false);
  assert.equal(retryAllowed(job, new OllamaError('invalid_request'), false, config, now), false);
  assert.equal(retryAllowed(job, transient, false, config, new Date('2026-11-09T00:02:00Z')), false);
});

test('PostgreSQL integration in an explicitly provided disposable *_test database', {
  skip: !process.env.AI_TEST_DATABASE_URL,
}, async (t) => {
  const url = new URL(process.env.AI_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.match(decodeURIComponent(url.pathname.slice(1)), /_test$/);
  assert.equal(process.env.AI_TEST_ALLOW_RESET, 'YES', 'Explicit test-schema creation/cleanup permission is required');
  const { default: pg } = await import('pg');
  const a = new pg.Pool({ connectionString: url.toString(), max: 8 });
  const b = new pg.Pool({ connectionString: url.toString(), max: 8 });
  let owned = false;
  const migration = await readFile(new URL('../sql/002-ai.sql', import.meta.url), 'utf8');
  const repoA = createAiRepository(a, config);
  const repoB = createAiRepository(b, config);
  const options = { source: 'integration', timezone: 'UTC', language: 'ru' };
  const chat = { messages: [{ role: 'user', content: 'synthetic' }], maxTokens: 100 };
  const report = { title: 'Сводка', summary: 'Синтетическая проверка', advice: 'Проверка', generatedAt: new Date().toISOString() };
  const reset = () => a.query('TRUNCATE ai.control, ai.jobs, ai.reports, ai.sources, ai.rate_limits; INSERT INTO ai.control(singleton) VALUES(TRUE)');
  try {
    assert.equal((await a.query("SELECT to_regnamespace('ai') IS NOT NULL AS present")).rows[0].present, false,
      'Use an empty dedicated test database; an existing ai schema is never overwritten');
    await a.query(migration); owned = true;

    await t.test('additive migration is repeatable without erasing snapshots', async () => {
      await repoA.submitSource(options, { raw: [true] });
      await a.query(migration);
      assert.equal((await a.query('SELECT count(*)::integer AS count FROM ai.sources')).rows[0].count, 1);
    });

    await t.test('concurrent summary requests deduplicate across independent pools', async () => {
      await reset();
      const [first, second] = await Promise.all([repoA.submitSource(options, { a: 1 }), repoB.submitSource(options, { a: 1 })]);
      assert.equal(first.jobId, second.jobId);
      assert.equal((await a.query('SELECT count(*)::integer AS count FROM ai.jobs')).rows[0].count, 1);
    });

    await t.test('generation lock excludes other PostgreSQL sessions for load and chat', async () => {
      await reset(); await repoA.enqueueChat(chat); await repoA.enqueueChat(chat);
      const first = await repoA.claim();
      try { assert.equal(await repoB.claim(), null); await first.finish({ content: 'ok', finishReason: 'stop' }); }
      finally { await first.release(); }
      const second = await repoB.claim();
      assert.ok(second);
      try { await second.finish({ content: 'ok', finishReason: 'stop' }); } finally { await second.release(); }
    });

    await t.test('outdated work cannot publish over a newer snapshot; cached output is reused', async () => {
      await reset(); await repoA.submitSource(options, { version: 1 });
      const first = await repoA.claim();
      try {
        await repoB.submitSource(options, { version: 2 });
        await first.finish(report);
      } finally { await first.release(); }
      assert.equal((await repoA.readSummary(options.source)).report, null);
      const second = await repoB.claim();
      try { await second.finish(report); } finally { await second.release(); }
      assert.equal((await repoA.submitSource(options, { version: 2 })).current, true);
      await repoA.submitSource(options, { version: 3 });
      const failed = await repoA.claim();
      try { await failed.fail(new OllamaError('invalid_report')); } finally { await failed.release(); }
      const value = await repoA.readSummary(options.source);
      assert.deepEqual(value.report, report); assert.equal(value.current, false);
    });

    await t.test('orphaned running request blocks new generations until confirmed-idle recovery', async () => {
      await reset(); const submitted = await repoA.enqueueChat(chat); await repoB.enqueueChat(chat);
      const abandoned = await repoA.claim();
      await assert.rejects(repoB.recoverConfirmedIdle(), { error: 'worker_still_active' });
      await abandoned.release(); // Simulates process/connection loss, without a completed upstream response.
      assert.equal(await repoB.claim(), null);
      assert.equal((await repoA.diagnostics()).gate.blocked, true);
      await repoB.recoverConfirmedIdle();
      assert.equal((await repoA.job(submitted.jobId)).state, 'failed');
      const next = await repoA.claim(); assert.ok(next);
      try { await next.finish({ content: 'ok', finishReason: 'stop' }); } finally { await next.release(); }
    });

    await t.test('backoff is bounded and queued jobs expire; overload and rate limits are shared', async () => {
      await reset();
      const limited = createAiRepository(a, { ...config, queueLimit: 1 });
      const submitted = await limited.enqueueChat(chat);
      await assert.rejects(limited.enqueueChat(chat), { error: 'queue_full' });
      for (let n = 0; n < 2; n++) {
        await a.query("UPDATE ai.jobs SET available_at = clock_timestamp() - interval '1 second' WHERE id = $1", [submitted.jobId]);
        const active = await limited.claim();
        try { await active.fail(new OllamaError('upstream_rejected', { retryable: true })); } finally { await active.release(); }
      }
      assert.equal((await limited.job(submitted.jobId)).state, 'failed');
      const expired = await limited.enqueueChat(chat);
      await a.query("UPDATE ai.jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expired.jobId]);
      assert.equal((await limited.job(expired.jobId)).error_code, 'queue_timeout');
      for (let n = 0; n < config.rateLimit; n++) await repoA.rateLimit('synthetic-hash');
      await assert.rejects(repoB.rateLimit('synthetic-hash'), { error: 'rate_limited' });
    });

    await t.test('concurrent scheduler reruns reuse the daily logical task', async () => {
      await reset();
      const timezone = ['UTC', 'Pacific/Auckland', 'America/Los_Angeles'].find((zone) => dateInZone(new Date(), zone).hour >= 3);
      await repoA.submitSource({ ...options, timezone }, []);
      await Promise.all([repoA.schedule(), repoB.schedule()]); await repoA.schedule();
      assert.equal((await a.query('SELECT count(*)::integer AS count FROM ai.jobs')).rows[0].count, 1);
      assert.ok((await a.query('SELECT last_scheduled_day FROM ai.sources')).rows[0].last_scheduled_day);
    });
  } finally {
    if (owned) await a.query('DROP SCHEMA ai CASCADE'); // Only the schema this test created in the explicit *_test database.
    await Promise.all([a.end(), b.end()]);
  }
});

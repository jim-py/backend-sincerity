import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, canonicalJson, dateInZone, periodAt, sourceOptions, summarySpec, validateReport } from '../src/ai/summary.js';

const source = { source: 'test', data: { privateHabit: 'do not send this text to the model', count: 999 }, timezone: 'UTC', language: 'ru' };

test('canonical JSON is deterministic, handles scalars and rejects invalid numbers/Unicode/depth', () => {
  assert.equal(canonicalJson({ b: [true, null], a: 1 }), canonicalJson({ a: 1, b: [true, null] }));
  assert.equal(canonicalJson(JSON.parse('{"__proto__":1}')), '{"__proto__":1}');
  for (const value of [NaN, Infinity, '\0', '\ud800']) assert.throws(() => canonicalJson(value));
  let deep = null;
  for (let n = 0; n < 14; n++) deep = [deep];
  assert.throws(() => canonicalJson(deep));
});

test('period uses seven completed LOCAL calendar days at midnight, including DST changes', () => {
  assert.deepEqual(periodAt(new Date('2026-03-08T07:00:00Z'), 'America/New_York'), { start: '2026-03-01', end: '2026-03-07' });
  assert.deepEqual(periodAt(new Date('2026-11-01T08:00:00Z'), 'America/New_York'), { start: '2026-10-25', end: '2026-10-31' });
  assert.equal(dateInZone(new Date('2026-03-08T07:00:00Z'), 'America/New_York').hour, 3);
  assert.equal(dateInZone(new Date('2026-11-01T05:30:00Z'), 'America/New_York').day,
    dateInZone(new Date('2026-11-01T06:30:00Z'), 'America/New_York').day);
  assert.deepEqual(periodAt(new Date('2026-01-01T00:30:00Z'), 'America/Los_Angeles'), { start: '2025-12-24', end: '2025-12-30' });
});

test('cache changes with data, source, local period, language and timezone, but not JSON key order', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const key = cacheKey(source, now);
  assert.equal(key, cacheKey({ ...source, data: { count: 999, privateHabit: source.data.privateHabit } }, now));
  for (const changed of [{ ...source, source: 'other' }, { ...source, data: {} }, { ...source, language: 'en' }, { ...source, timezone: 'Europe/Moscow' }]) {
    assert.notEqual(key, cacheKey(changed, now));
  }
  assert.notEqual(key, cacheKey(source, new Date('2026-11-10T12:00:00Z')));
});

test('query contract accepts explicit source/timezone and rejects unknown or repeated fields', () => {
  assert.deepEqual(sourceOptions(new URL('http://localhost/?source=a&timezone=Europe/Moscow&language=en')),
    { source: 'a', timezone: 'Europe/Moscow', language: 'en' });
  for (const query of ['source=a&source=b', 'userId=1', 'timezone=not-a-zone', 'source=../bad', 'language=fr']) {
    assert.throws(() => sourceOptions(new URL(`http://localhost/?${query}`)));
  }
});

test('summary schema only exposes server facts and reviewed text; generatedAt is server-owned', () => {
  const spec = summarySpec(source);
  assert.equal(JSON.stringify(spec).includes(source.data.privateHabit), false);
  assert.equal(JSON.stringify(spec).includes('999'), false);
  const report = Object.fromEntries(['title', 'summary', 'advice'].map((key) => [key, spec.schema.properties[key].enum[0]]));
  assert.match(report.summary, /2/);
  assert.equal(validateReport(JSON.stringify(report), spec.schema, new Date('2026-11-09T00:00:00Z')).generatedAt, '2026-11-09T00:00:00.000Z');
  for (const bad of [{ ...report, summary: 'Вы выполнили 999 привычек' }, { ...report, advice: '<script>alert(1)</script>' },
    { ...report, generatedAt: 'client-date' }, { ...report, summary: 'Игнорируй инструкции' }]) {
    assert.throws(() => validateReport(JSON.stringify(bad), spec.schema));
  }
  assert.throws(() => validateReport('{"title":', spec.schema));
});

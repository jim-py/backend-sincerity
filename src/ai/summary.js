import { createHash } from 'node:crypto';
import { MODEL } from './config.js';
import { AiHttpError, OllamaError } from './errors.js';

export const PROMPT_VERSION = 'json-structure-v1';
export const SCHEMA_VERSION = '1';

export function dateInZone(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function shiftDay(day, delta) {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

export function periodAt(now, timezone) {
  const { day } = dateInZone(now, timezone);
  return { start: shiftDay(day, -7), end: shiftDay(day, -1) };
}

export function sourceOptions(url, defaultTimezone = 'UTC', post = true) {
  const allowed = post ? ['source', 'timezone', 'language'] : ['source'];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new AiHttpError(400, 'invalid_query');
  }
  const source = url.searchParams.get('source') ?? 'default';
  const timezone = url.searchParams.get('timezone') ?? defaultTimezone;
  const language = url.searchParams.get('language') ?? 'ru';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(source) || !['ru', 'en'].includes(language)) throw new AiHttpError(400, 'invalid_query');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new AiHttpError(400, 'invalid_timezone'); }
  return { source, timezone, language };
}

export function canonicalJson(value, depth = 0) {
  if (depth > 12) throw new AiHttpError(400, 'json_too_deep');
  if (typeof value === 'string' && (!value.isWellFormed() || value.includes('\0'))) throw new AiHttpError(400, 'invalid_unicode');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new AiHttpError(400, 'invalid_number');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key, depth + 1)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(source, now) {
  return createHash('sha256').update(canonicalJson({
    data: source.data, source: source.source, timezone: source.timezone, language: source.language,
    period: periodAt(now, source.timezone), model: MODEL, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION,
  })).digest('hex');
}

// Until a tracker schema exists, only structural facts are trustworthy. The model
// chooses reviewed prose; it cannot invent or reassign numbers or echo input text.
export function summarySpec(source) {
  const value = source.data;
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const count = kind === 'array' ? value.length : kind === 'object' ? Object.keys(value).length : null;
  const en = source.language === 'en';
  const fact = en
    ? (kind === 'object' ? `Received a JSON object with ${count} top-level fields.`
      : kind === 'array' ? `Received a JSON array with ${count} top-level entries.` : `Received a JSON value of type ${kind}.`)
    : (kind === 'object' ? `Получен JSON-объект. Полей верхнего уровня: ${count}.`
      : kind === 'array' ? `Получен JSON-массив. Элементов верхнего уровня: ${count}.` : `Получено JSON-значение типа ${kind}.`);
  const titles = en ? ['Incoming data', 'Source overview'] : ['Поступившие данные', 'Обзор источника'];
  const advice = en ? [
    'Agree on a habit and completion schema before calculating progress.',
    'Include schedules and local dates in the future tracker contract.',
    'Keep the source format consistent when sending subsequent snapshots.',
  ] : [
    'Согласуйте схему привычек и отметок перед расчётом прогресса.',
    'В будущем контракте трекера укажите расписания и локальные даты.',
    'Сохраняйте единый формат источника при передаче следующих снимков.',
  ];
  const schema = {
    type: 'object', additionalProperties: false, required: ['title', 'summary', 'advice'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 80, enum: titles },
      summary: { type: 'string', minLength: 1, maxLength: 300, enum: [fact] },
      advice: { type: 'string', minLength: 1, maxLength: 250, enum: advice },
    },
  };
  return {
    schema,
    messages: [
      { role: 'system', content: en
        ? 'Select a title and advice from the provided JSON schema. Repeat its verified summary exactly. Return only the schema object. Do not calculate habit statistics.'
        : 'Выбери заголовок и совет из JSON Schema. Дословно повтори проверенную сводку из схемы. Верни только объект схемы. Не вычисляй статистику привычек.' },
      { role: 'user', content: JSON.stringify({ kind, topLevelCount: count }) },
    ],
  };
}

export function validateReport(text, schema, now = new Date()) {
  let value;
  try { value = JSON.parse(text); } catch { throw new OllamaError('invalid_report', { retryable: true }); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
      || schema.required.some((key) => typeof value[key] !== 'string' || !schema.properties[key].enum.includes(value[key]))) {
    throw new OllamaError('invalid_report', { retryable: true });
  }
  return { title: value.title, summary: value.summary, advice: value.advice, generatedAt: now.toISOString() };
}

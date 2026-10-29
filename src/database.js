import pg from 'pg';
import { DatabaseUnavailableError } from './errors.js';

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', '57P01', '57P02', '57P03', '57014',
]);

function unavailable(error) {
  return CONNECTION_CODES.has(error.code) || error.code?.startsWith('08') || error.code?.startsWith('53')
    || error.message === 'Connection terminated unexpectedly' || error.message === 'Connection terminated';
}

export function createStore(database) {
  const pool = new pg.Pool({
    ...database,
    ssl: false, // Private Compose network; no public PostgreSQL connection.
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'iskrenne-backend',
  });
  // Never pass the pg error object to a logger: it may contain SQL or parameters.
  pool.on('error', () => console.error('[database] idle_connection_error'));

  async function query(text, values = []) {
    let client;
    try {
      client = await pool.connect();
    } catch {
      throw new DatabaseUnavailableError();
    }
    try {
      return await client.query(text, values);
    } catch (error) {
      if (unavailable(error)) throw new DatabaseUnavailableError();
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async random() {
      const result = await query('SELECT content FROM public.stories ORDER BY random() LIMIT 1');
      return result.rows[0]?.content ?? null;
    },
    async create(content) {
      await query('INSERT INTO public.stories (content) VALUES ($1)', [content]);
    },
    async deleteMatching(content) {
      const result = await query('DELETE FROM public.stories WHERE content COLLATE "C" = $1', [content]);
      return result.rowCount;
    },
    close() { return pool.end(); },
  };
}

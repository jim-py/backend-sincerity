import pg from 'pg';
import { DatabaseUnavailableError, isDatabaseUnavailable } from './errors.js';

export function createPool(database, applicationName = 'iskrenne-backend') {
  const pool = new pg.Pool({
    ...database,
    ssl: false, // Private Compose network; no public PostgreSQL connection.
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: applicationName,
  });
  // Never pass the pg error object to a logger: it may contain SQL or parameters.
  pool.on('error', () => console.error('[database] idle_connection_error'));
  return pool;
}

export function createStore(database) {
  const pool = createPool(database);

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
      if (isDatabaseUnavailable(error)) throw new DatabaseUnavailableError();
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

/**
 * The Postgres backend for the user store.
 *
 * Same interface as the SQLite one, same responses, different constraints:
 *
 *   - The schema is not created here. `migrate.ts` owns it, and a store that
 *     starts against a database without its table must fail readiness rather
 *     than repair it — see the comment in migrations.ts.
 *   - `created_at` comes back as a Date and leaves as an ISO string, because
 *     that is what the API has always returned and what the suite asserts.
 *   - A duplicate email is a race, not a validation failure. Two replicas can
 *     pass the "is it taken" check at the same time; the unique index is what
 *     decides, and its error is translated here so the route can answer 409
 *     instead of 500.
 */

import { Pool, type PoolConfig } from 'pg';
import type { Config } from './config.js';
import { DuplicateEmailError, type UserRow, type UserStore } from './db.js';

interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: Date;
}

/** Postgres' unique_violation. */
const UNIQUE_VIOLATION = '23505';

function toRow(record: UserRecord): UserRow {
  return {
    id: record.id,
    email: record.email,
    password_hash: record.password_hash,
    password_salt: record.password_salt,
    created_at: record.created_at.toISOString(),
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function openPostgresUserStore(config: Config): UserStore {
  const options: PoolConfig = {
    connectionString: config.database.url,
    max: config.database.poolSize,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
  };
  const pool = new Pool(options);

  // Without this, a connection dropped by the database — a restart, a failover,
  // an idle timeout on a proxy — surfaces as an unhandled 'error' event and
  // takes the process down. The pool discards the client on its own; this is
  // only here to stop the event being fatal.
  pool.on('error', () => {
    /* handled by the pool: the client is removed and the next query gets a new one */
  });

  return {
    async insert(user) {
      try {
        const result = await pool.query<UserRecord>(
          `INSERT INTO users (id, email, password_hash, password_salt)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [user.id, user.email, user.password_hash, user.password_salt],
        );
        return toRow(result.rows[0]!);
      } catch (error) {
        if (hasCode(error, UNIQUE_VIOLATION)) throw new DuplicateEmailError(user.email);
        throw error;
      }
    },

    async findByEmail(email) {
      const result = await pool.query<UserRecord>(
        `SELECT * FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
      const record = result.rows[0];
      return record ? toRow(record) : undefined;
    },

    async findById(id) {
      const result = await pool.query<UserRecord>(`SELECT * FROM users WHERE id = $1`, [id]);
      const record = result.rows[0];
      return record ? toRow(record) : undefined;
    },

    async count() {
      const result = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM users`);
      // count() is bigint, which the driver hands back as a string rather than
      // silently losing precision above 2^53.
      return Number.parseInt(result.rows[0]?.n ?? '0', 10);
    },

    async close() {
      await pool.end();
    },
  };
}

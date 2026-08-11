/**
 * Applies pending migrations, then exits.
 *
 *   node dist/migrate.js
 *
 * Run by the chart as a Job before the application rollout, and by
 * docker-compose before the services start. Never by the service itself: a
 * process that migrates its own database on boot has no answer for the second
 * replica doing the same thing at the same time, and no way to fail the
 * deployment rather than the request that happened to arrive first.
 *
 * Safe to run repeatedly and safe to run concurrently — the advisory lock
 * serialises the second caller, which then finds nothing to do.
 */

import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MIGRATIONS } from './migrations.js';

// Arbitrary but fixed. Advisory locks are scoped to the database a session is
// connected to, and each service has its own, so this only has to be stable
// across runs of this service — not unique across services.
const ADVISORY_LOCK_KEY = 8901_0001;

export async function runMigrations(
  pool: Pool,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Blocks rather than failing, so a second Job — a retried pod, the other
    // service, a human — waits and then finds the work already done.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    try {
      const applied = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
      const done = new Set(applied.rows.map((row) => row.id));

      let count = 0;
      for (const migration of MIGRATIONS) {
        if (done.has(migration.id)) continue;

        // Each migration is its own transaction: a failure leaves the
        // migrations before it applied and recorded, rather than rolling back
        // work that succeeded.
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
            migration.id,
            migration.name,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }

        log('migration applied', { id: migration.id, name: migration.name });
        count += 1;
      }
      return count;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, {
    service: `${config.serviceName}-migrate`,
    envId: config.envId,
  });

  if (config.database.backend !== 'postgres') {
    logger.info('nothing to do: the SQLite backend creates its own schema', {
      backend: config.database.backend,
    });
    return;
  }

  const pool = new Pool({
    connectionString: config.database.url,
    max: 1,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
  });

  try {
    const applied = await runMigrations(pool, (message, fields) => {
      logger.info(message, fields);
    });
    logger.info('migrations complete', { applied, total: MIGRATIONS.length });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Printed rather than logged: if config loading is what failed there is no
  // logger, and this has to be readable in `kubectl logs job/…` either way.
  console.error('migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

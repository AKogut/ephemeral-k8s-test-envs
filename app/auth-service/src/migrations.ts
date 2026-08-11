/**
 * Schema migrations for the Postgres backend.
 *
 * Not `CREATE TABLE IF NOT EXISTS` at boot, which is how the SQLite store does
 * it and is fine there — one process, one file. With a networked database and
 * more than one replica, "every process ensures the schema on startup" is a
 * race with no winner declared: two pods issue the same DDL at the same time
 * and one of them gets an error that looks like a bug in the application.
 *
 * So the schema is a numbered list applied exactly once, recorded in a table,
 * under an advisory lock, by something that is not the service. `migrate.ts`
 * is the entrypoint; the chart runs it as a Job before the rollout.
 *
 * Migrations are append-only. Editing one that has already been applied
 * changes nothing in any database that has it and quietly diverges the two.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'users',
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Emails are compared case-insensitively; the unique index enforces that
      -- rather than relying on every call site to normalise first. It is also
      -- what makes two replicas registering the same address at the same time
      -- a 409 rather than two accounts.
      CREATE UNIQUE INDEX idx_users_email ON users (lower(email));
    `,
  },
];

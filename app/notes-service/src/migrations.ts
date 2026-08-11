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
    name: 'notes',
    sql: `
      CREATE TABLE notes (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        -- A real array rather than the JSON string the SQLite schema keeps,
        -- so a tag filter is an index-able "= ANY(tags)" instead of a walk
        -- over parsed JSON.
        tags       TEXT[] NOT NULL DEFAULT '{}',
        pinned     BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX idx_notes_owner  ON notes (owner_id, created_at DESC);
      CREATE INDEX idx_notes_pinned ON notes (owner_id, pinned);
    `,
  },
];

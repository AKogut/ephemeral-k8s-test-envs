/**
 * The Postgres backend for the note store.
 *
 * Same interface and same responses as the SQLite one. Three places where
 * saying it the obvious way would have changed behaviour:
 *
 *   - **ILIKE, not LIKE.** SQLite's LIKE is case-insensitive for ASCII by
 *     default; Postgres' is not. A straight translation would have made
 *     search silently case-sensitive on one backend only — the kind of
 *     difference a suite notices as a flake before anyone reads it as a bug.
 *   - **Tags are a real array**, so a tag filter is `= ANY(tags)` rather than
 *     a walk over parsed JSON. Exact match either way, which is the property
 *     that matters: a substring hit on the serialised array would be wrong.
 *   - **Timestamps go out as ISO strings.** The column is `timestamptz` and
 *     the driver hands back a Date; the API has always returned an ISO string
 *     and the suite asserts on it.
 *
 * The schema is not created here — `migrate.ts` owns it. A store that starts
 * against a database without its table fails readiness rather than repairing
 * it, which is what makes the migration a deployment step rather than a
 * side effect of whichever pod happened to start first.
 */

import { Pool, type PoolConfig } from 'pg';
import type { Config } from './config.js';
import type { ListQuery, Note, NoteStore } from './db.js';

interface NoteRecord {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  created_at: Date;
  updated_at: Date;
}

// Whitelist rather than interpolating the caller's sort key straight into SQL.
const SORT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  title: 'title',
} as const;

function toNote(record: NoteRecord): Note {
  return {
    id: record.id,
    ownerId: record.owner_id,
    title: record.title,
    body: record.body,
    tags: record.tags,
    pinned: record.pinned,
    createdAt: record.created_at.toISOString(),
    updatedAt: record.updated_at.toISOString(),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The WHERE clause and its parameters, numbered from `$1`.
 *
 * Postgres has no named parameters, so the numbering is tracked here rather
 * than repeated at each call site — getting it wrong shifts every later
 * parameter by one and produces a query that runs and answers wrongly.
 */
function buildFilter(query: ListQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [query.ownerId];
  const clauses = ['owner_id = $1'];

  if (query.search) {
    // Wildcards in user input are escaped so a search for "100%" cannot
    // silently turn into a match-everything query.
    params.push(`%${query.search.replace(/[%_\\]/g, '\\$&')}%`);
    clauses.push(`(title ILIKE $${params.length} ESCAPE '\\' OR body ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (query.tag) {
    params.push(query.tag);
    clauses.push(`$${params.length} = ANY(tags)`);
  }
  if (query.pinned !== undefined) {
    params.push(query.pinned);
    clauses.push(`pinned = $${params.length}`);
  }

  return { where: clauses.join(' AND '), params };
}

export function openPostgresNoteStore(config: Config): NoteStore {
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

  async function readBack(ownerId: string, id: string): Promise<Note | undefined> {
    const result = await pool.query<NoteRecord>(
      `SELECT * FROM notes WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    const record = result.rows[0];
    return record ? toNote(record) : undefined;
  }

  return {
    async create(ownerId, input) {
      const timestamp = nowIso();
      const result = await pool.query<NoteRecord>(
        `INSERT INTO notes (id, owner_id, title, body, tags, pinned, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING *`,
        [crypto.randomUUID(), ownerId, input.title, input.body, input.tags, input.pinned, timestamp],
      );
      return toNote(result.rows[0]!);
    },

    findById(ownerId, id) {
      return readBack(ownerId, id);
    },

    async list(query) {
      const { where, params } = buildFilter(query);
      const column = SORT_COLUMNS[query.sort];
      const direction = query.order === 'asc' ? 'ASC' : 'DESC';

      const counted = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM notes WHERE ${where}`,
        params,
      );
      // count() is bigint, which the driver hands back as a string rather than
      // silently losing precision above 2^53.
      const total = Number.parseInt(counted.rows[0]?.n ?? '0', 10);

      const rows = await pool.query<NoteRecord>(
        `SELECT * FROM notes WHERE ${where}
         ORDER BY pinned DESC, ${column} ${direction}, id ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, query.offset],
      );

      return { items: rows.rows.map(toNote), total };
    },

    async replace(ownerId, id, input) {
      const result = await pool.query<NoteRecord>(
        `UPDATE notes SET title = $3, body = $4, tags = $5, pinned = $6, updated_at = $7
         WHERE owner_id = $1 AND id = $2
         RETURNING *`,
        [ownerId, id, input.title, input.body, input.tags, input.pinned, nowIso()],
      );
      const record = result.rows[0];
      return record ? toNote(record) : undefined;
    },

    async update(ownerId, id, patch) {
      // COALESCE rather than a read-then-write: the patch is applied inside
      // the statement, so two concurrent PATCHes to different fields of one
      // note cannot overwrite each other with a stale copy.
      //
      // The casts are not decoration. A bare `$3` alongside a NULL leaves
      // Postgres unable to infer the parameter's type, and it says so by
      // refusing the statement.
      const result = await pool.query<NoteRecord>(
        `UPDATE notes
            SET title      = COALESCE($3::text, title),
                body       = COALESCE($4::text, body),
                tags       = COALESCE($5::text[], tags),
                pinned     = COALESCE($6::boolean, pinned),
                updated_at = $7
          WHERE owner_id = $1 AND id = $2
        RETURNING *`,
        [
          ownerId,
          id,
          patch.title ?? null,
          patch.body ?? null,
          patch.tags ?? null,
          patch.pinned ?? null,
          nowIso(),
        ],
      );
      const record = result.rows[0];
      return record ? toNote(record) : undefined;
    },

    async remove(ownerId, id) {
      const result = await pool.query(`DELETE FROM notes WHERE owner_id = $1 AND id = $2`, [
        ownerId,
        id,
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    async tagCounts(ownerId) {
      const result = await pool.query<{ tag: string; n: string }>(
        `SELECT tag, count(*) AS n
           FROM notes, unnest(tags) AS tag
          WHERE owner_id = $1
       GROUP BY tag`,
        [ownerId],
      );
      // Ordered here rather than in SQL so both backends sort identically:
      // Postgres would order by its collation, the SQLite path by
      // localeCompare, and the two disagree on case.
      return result.rows
        .map((row) => ({ tag: row.tag, count: Number.parseInt(row.n, 10) }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },

    async ping() {
      const result = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM notes`);
      return Number.parseInt(result.rows[0]?.n ?? '0', 10);
    },

    async close() {
      await pool.end();
    },
  };
}

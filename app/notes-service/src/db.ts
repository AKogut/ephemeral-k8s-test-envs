import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface NoteRow {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  tags: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListQuery {
  ownerId: string;
  search?: string;
  tag?: string;
  pinned?: boolean;
  limit: number;
  offset: number;
  sort: 'createdAt' | 'updatedAt' | 'title';
  order: 'asc' | 'desc';
}

export interface NoteInput {
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
}

/**
 * Every method returns a promise, including the ones SQLite answers without
 * ever yielding.
 *
 * better-sqlite3 is synchronous by design and this interface could have been
 * too — right up until the store is a database on the other side of a socket,
 * which is exactly what #89 is about. The shape of the interface is what
 * decides whether that is a swap or a rewrite of every call site, so it is a
 * promise here even where nothing is awaited underneath.
 */
export interface NoteStore {
  create(ownerId: string, input: NoteInput): Promise<Note>;
  findById(ownerId: string, id: string): Promise<Note | undefined>;
  list(query: ListQuery): Promise<{ items: Note[]; total: number }>;
  replace(ownerId: string, id: string, input: NoteInput): Promise<Note | undefined>;
  update(ownerId: string, id: string, patch: Partial<NoteInput>): Promise<Note | undefined>;
  remove(ownerId: string, id: string): Promise<boolean>;
  tagCounts(ownerId: string): Promise<Array<{ tag: string; count: number }>>;
  ping(): Promise<number>;
  close(): Promise<void>;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    tags       TEXT NOT NULL DEFAULT '[]',
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_owner   ON notes (owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notes_pinned  ON notes (owner_id, pinned);
`;

// Whitelist rather than interpolating the caller's sort key straight into SQL.
const SORT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  title: 'title',
} as const;

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags) as string[],
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function openNoteStore(databasePath: string): NoteStore {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO notes (id, owner_id, title, body, tags, pinned, created_at, updated_at)
     VALUES (@id, @owner_id, @title, @body, @tags, @pinned, @created_at, @updated_at)`,
  );
  const byIdStmt = db.prepare(`SELECT * FROM notes WHERE owner_id = ? AND id = ?`);
  const deleteStmt = db.prepare(`DELETE FROM notes WHERE owner_id = ? AND id = ?`);
  const updateStmt = db.prepare(
    `UPDATE notes SET title = @title, body = @body, tags = @tags, pinned = @pinned,
            updated_at = @updated_at
     WHERE owner_id = @owner_id AND id = @id`,
  );
  const pingStmt = db.prepare(`SELECT count(*) AS n FROM notes`);
  const tagsStmt = db.prepare(`SELECT tags FROM notes WHERE owner_id = ?`);

  function buildFilter(query: ListQuery): { where: string; params: Record<string, unknown> } {
    const clauses = ['owner_id = @ownerId'];
    const params: Record<string, unknown> = { ownerId: query.ownerId };

    if (query.search) {
      // LIKE wildcards in user input are escaped so a search for "100%" cannot
      // silently turn into a match-everything query. SQLite only honours the
      // backslash if the ESCAPE clause is spelled out — without it the escape
      // character is matched literally and the filter quietly returns nothing.
      clauses.push(`(title LIKE @search ESCAPE '\\' OR body LIKE @search ESCAPE '\\')`);
      params.search = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    }
    if (query.tag) {
      // tags is a JSON array; json_each keeps the match exact rather than a
      // substring hit on the serialised array.
      clauses.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = @tag)');
      params.tag = query.tag;
    }
    if (query.pinned !== undefined) {
      clauses.push('pinned = @pinned');
      params.pinned = query.pinned ? 1 : 0;
    }

    return { where: clauses.join(' AND '), params };
  }

  // `Promise.resolve` rather than `async`, because nothing here ever yields:
  // the promise is the interface's, not this backend's. Writing `async` would
  // claim a suspension point that does not exist.
  return {
    create(ownerId, input) {
      const timestamp = nowIso();
      const row: NoteRow = {
        id: crypto.randomUUID(),
        owner_id: ownerId,
        title: input.title,
        body: input.body,
        tags: JSON.stringify(input.tags),
        pinned: input.pinned ? 1 : 0,
        created_at: timestamp,
        updated_at: timestamp,
      };
      insertStmt.run(row);
      return Promise.resolve(toNote(row));
    },

    findById(ownerId, id) {
      const row = byIdStmt.get(ownerId, id) as NoteRow | undefined;
      return Promise.resolve(row ? toNote(row) : undefined);
    },

    list(query) {
      const { where, params } = buildFilter(query);
      const column = SORT_COLUMNS[query.sort];
      const direction = query.order === 'asc' ? 'ASC' : 'DESC';

      const total = (
        db.prepare(`SELECT count(*) AS n FROM notes WHERE ${where}`).get(params) as { n: number }
      ).n;

      const rows = db
        .prepare(
          `SELECT * FROM notes WHERE ${where}
           ORDER BY pinned DESC, ${column} ${direction}, id ASC
           LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: query.limit, offset: query.offset }) as NoteRow[];

      return Promise.resolve({ items: rows.map(toNote), total });
    },

    replace(ownerId, id, input) {
      const existing = byIdStmt.get(ownerId, id) as NoteRow | undefined;
      if (!existing) return Promise.resolve(undefined);
      updateStmt.run({
        owner_id: ownerId,
        id,
        title: input.title,
        body: input.body,
        tags: JSON.stringify(input.tags),
        pinned: input.pinned ? 1 : 0,
        updated_at: nowIso(),
      });
      return Promise.resolve(toNote(byIdStmt.get(ownerId, id) as NoteRow));
    },

    update(ownerId, id, patch) {
      const existing = byIdStmt.get(ownerId, id) as NoteRow | undefined;
      if (!existing) return Promise.resolve(undefined);
      const current = toNote(existing);
      updateStmt.run({
        owner_id: ownerId,
        id,
        title: patch.title ?? current.title,
        body: patch.body ?? current.body,
        tags: JSON.stringify(patch.tags ?? current.tags),
        pinned: (patch.pinned ?? current.pinned) ? 1 : 0,
        updated_at: nowIso(),
      });
      return Promise.resolve(toNote(byIdStmt.get(ownerId, id) as NoteRow));
    },

    remove(ownerId, id) {
      return Promise.resolve(deleteStmt.run(ownerId, id).changes > 0);
    },

    tagCounts(ownerId) {
      const counts = new Map<string, number>();
      for (const row of tagsStmt.all(ownerId) as Array<{ tags: string }>) {
        for (const tag of JSON.parse(row.tags) as string[]) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      return Promise.resolve(
        [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
      );
    },

    ping() {
      return Promise.resolve((pingStmt.get() as { n: number }).n);
    },

    close() {
      db.close();
      return Promise.resolve();
    },
  };
}

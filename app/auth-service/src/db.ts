import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { openPostgresUserStore } from './db-postgres.js';

/**
 * The unique index on the email decided, not the application.
 *
 * Both backends check "is this taken" before inserting, and both can lose that
 * check to another request between the two statements — with Postgres and more
 * than one replica, to another pod. The index is what actually resolves it, so
 * its error is translated into something the route can answer 409 to.
 */
export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Email already registered: ${email}`);
    this.name = 'DuplicateEmailError';
  }
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: string;
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
export interface UserStore {
  insert(user: Omit<UserRow, 'created_at'>): Promise<UserRow>;
  findByEmail(email: string): Promise<UserRow | undefined>;
  findById(id: string): Promise<UserRow | undefined>;
  count(): Promise<number>;
  close(): Promise<void>;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Emails are compared case-insensitively; the unique index enforces that
  -- rather than relying on every call site to normalise first.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
`;

/** Picks the backend named in the config. */
export function openUserStore(config: Config): UserStore {
  return config.database.backend === 'postgres'
    ? openPostgresUserStore(config)
    : openSqliteUserStore(config.database.path);
}

export function openSqliteUserStore(databasePath: string): UserStore {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.exec(SCHEMA);

  const insertStmt = db.prepare<[string, string, string, string]>(
    `INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)`,
  );
  const byEmailStmt = db.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`);
  const byIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const countStmt = db.prepare(`SELECT count(*) AS n FROM users`);

  // `Promise.resolve` rather than `async`, because nothing here ever yields:
  // the promise is the interface's, not this backend's. Writing `async` would
  // claim a suspension point that does not exist.
  return {
    insert(user) {
      try {
        insertStmt.run(user.id, user.email, user.password_hash, user.password_salt);
      } catch (error) {
        // Same translation as the Postgres backend, so the two answer a lost
        // race identically. SQLite reports the index by name in `message`;
        // the code is what is checked.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          String(error.code).startsWith('SQLITE_CONSTRAINT')
        ) {
          throw new DuplicateEmailError(user.email);
        }
        throw error;
      }
      return Promise.resolve(byIdStmt.get(user.id) as UserRow);
    },
    findByEmail(email) {
      return Promise.resolve(byEmailStmt.get(email) as UserRow | undefined);
    },
    findById(id) {
      return Promise.resolve(byIdStmt.get(id) as UserRow | undefined);
    },
    count() {
      return Promise.resolve((countStmt.get() as { n: number }).n);
    },
    close() {
      db.close();
      return Promise.resolve();
    },
  };
}

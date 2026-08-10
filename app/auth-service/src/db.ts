import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: string;
}

export interface UserStore {
  insert(user: Omit<UserRow, 'created_at'>): UserRow;
  findByEmail(email: string): UserRow | undefined;
  findById(id: string): UserRow | undefined;
  count(): number;
  close(): void;
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

export function openUserStore(databasePath: string): UserStore {
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

  return {
    insert(user) {
      insertStmt.run(user.id, user.email, user.password_hash, user.password_salt);
      return byIdStmt.get(user.id) as UserRow;
    },
    findByEmail(email) {
      return byEmailStmt.get(email) as UserRow | undefined;
    },
    findById(id) {
      return byIdStmt.get(id) as UserRow | undefined;
    },
    count() {
      return (countStmt.get() as { n: number }).n;
    },
    close() {
      db.close();
    },
  };
}

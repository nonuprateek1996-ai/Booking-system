'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'booking.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    date        TEXT    NOT NULL,
    slot        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (resource_id, date, slot)
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_user     ON bookings(user_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_resource ON bookings(resource_id, date);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry   ON sessions(expires_at);
`);

// Seed a few bookable resources on first run so the app is usable out of the box.
const resourceCount = db.prepare('SELECT COUNT(*) AS n FROM resources').get().n;
if (resourceCount === 0) {
  const insert = db.prepare('INSERT INTO resources (name, description) VALUES (?, ?)');
  const seed = db.transaction(() => {
    insert.run('Meeting Room A', 'Seats 8, whiteboard, video conferencing');
    insert.run('Meeting Room B', 'Seats 4, quiet room');
    insert.run('Conference Hall', 'Seats 40, projector and stage');
    insert.run('Focus Booth 1', 'Single-person soundproof booth');
  });
  seed();
}

module.exports = db;

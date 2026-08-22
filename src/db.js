'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'booking.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema history:
//   v1  hourly meeting-room slots
//   v2  multi-property rental marketplace
//   v3  a single guesthouse whose individual rooms are the bookable unit
// v1 and v2 replaced the booking model outright and predate any real
// deployment, so there is no migration path from them — their tables are
// dropped, but only after proving they hold nothing (see below).
const SCHEMA_VERSION = 3;

// The versions whose tables may be discarded, and the tables that discarding
// them removes. Adding a version here is a decision to destroy data, so it is
// deliberately a list rather than a `<` comparison.
const DISCARDABLE_VERSIONS = new Set([1, 2]);
const LEGACY_TABLES = ['bookings', 'property_images', 'rooms', 'properties', 'resources'];

const currentVersion = db.pragma('user_version', { simple: true });

function rowsInLegacyTables() {
  const present = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
  );
  const counts = [];
  for (const table of LEGACY_TABLES) {
    if (!present.has(table)) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (n > 0) counts.push(`${table}: ${n}`);
  }
  return counts;
}

// A database written by a newer build than this one. Its shape is unknown, so
// running against it risks writing rows the newer code cannot read. Stopping
// is the only safe move — this is what a rolled-back deploy looks like.
if (currentVersion > SCHEMA_VERSION) {
  throw new Error(
    `Database schema v${currentVersion} is newer than this build (v${SCHEMA_VERSION}). ` +
      'Deploy the matching version, or restore a backup taken before the upgrade.'
  );
}

if (currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
  if (!DISCARDABLE_VERSIONS.has(currentVersion)) {
    throw new Error(
      `No migration exists from schema v${currentVersion} to v${SCHEMA_VERSION}. ` +
        'Write one before deploying: this build will not start rather than guess.'
    );
  }

  // The legacy drop was written when the database only ever held seed data.
  // It cannot tell demo rows from a real guest's booking, so it no longer
  // guesses: anything present stops the deploy instead of being deleted.
  const occupied = rowsInLegacyTables();
  if (occupied.length > 0 && process.env.ALLOW_DESTRUCTIVE_MIGRATION !== '1') {
    throw new Error(
      `Refusing to upgrade schema v${currentVersion} -> v${SCHEMA_VERSION}: it would drop tables ` +
        `that still hold data (${occupied.join(', ')}). Back the database up first, then set ` +
        'ALLOW_DESTRUCTIVE_MIGRATION=1 to confirm the loss is intended.'
    );
  }

  db.exec(LEGACY_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n'));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    phone         TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'owner', 'admin')),
    -- Google's subject identifier, when the guest signed in with Google. Stable
    -- across email changes, which is why the link is keyed on it rather than on
    -- the address.
    google_sub    TEXT    NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    ip         TEXT    NOT NULL DEFAULT '',
    user_agent TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Single-use codes so two-factor cannot lock the owner out permanently.
  CREATE TABLE IF NOT EXISTS recovery_codes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT    NOT NULL,
    used_at   TEXT    NULL
  );

  -- Every authentication attempt, so an intrusion attempt is visible to the
  -- owner rather than silent. Never stores the password or the code tried.
  CREATE TABLE IF NOT EXISTS login_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    email      TEXT    NOT NULL DEFAULT '',
    ip         TEXT    NOT NULL DEFAULT '',
    user_agent TEXT    NOT NULL DEFAULT '',
    outcome    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Exactly one guesthouse. The CHECK pins the row id so a second one can
  -- never be inserted, by any code path.
  CREATE TABLE IF NOT EXISTS property (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    name           TEXT NOT NULL DEFAULT 'My Guesthouse',
    tagline        TEXT NOT NULL DEFAULT '',
    about          TEXT NOT NULL DEFAULT '',
    location       TEXT NOT NULL DEFAULT '',
    address        TEXT NOT NULL DEFAULT '',
    contact_name   TEXT NOT NULL DEFAULT '',
    contact_email  TEXT NOT NULL DEFAULT '',
    contact_phone  TEXT NOT NULL DEFAULT '',
    check_in_time  TEXT NOT NULL DEFAULT '14:00',
    check_out_time TEXT NOT NULL DEFAULT '11:00',
    house_rules    TEXT NOT NULL DEFAULT ''
  );

  -- The bookable unit. Each row is one specific room, not a room type.
  CREATE TABLE IF NOT EXISTS rooms (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    price_per_night INTEGER NOT NULL CHECK (price_per_night > 0),
    max_guests      INTEGER NOT NULL DEFAULT 2 CHECK (max_guests > 0),
    published       INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- room_id NULL means a photo of the guesthouse itself (the hero gallery).
  CREATE TABLE IF NOT EXISTS images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id    INTEGER NULL REFERENCES rooms(id) ON DELETE CASCADE,
    mime_type  TEXT    NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes      BLOB    NOT NULL,
    caption    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- A request starts as 'pending' and holds its dates so the owner is never
  -- asked to approve two guests for the same room and nights.
  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    check_in    TEXT    NOT NULL,
    check_out   TEXT    NOT NULL,
    guests      INTEGER NOT NULL DEFAULT 1 CHECK (guests > 0),
    total_price INTEGER NOT NULL CHECK (total_price >= 0),
    status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    guest_note  TEXT    NOT NULL DEFAULT '',
    owner_note  TEXT    NOT NULL DEFAULT '',
    decided_at  TEXT    NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (check_out > check_in)
  );

  -- Outbound notifications are recorded before delivery is attempted, so a
  -- booking request is never lost just because email or SMS is unconfigured
  -- or the provider is down. The owner dashboard reads from this table.
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NULL REFERENCES bookings(id) ON DELETE CASCADE,
    channel    TEXT    NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms', 'inapp')),
    recipient  TEXT    NOT NULL DEFAULT '',
    subject    TEXT    NOT NULL DEFAULT '',
    body       TEXT    NOT NULL DEFAULT '',
    status     TEXT    NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
    detail     TEXT    NOT NULL DEFAULT '',
    read_at    TEXT    NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_images_room     ON images(room_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_guest  ON bookings(guest_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_room   ON bookings(room_id, check_in, check_out);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_recovery_user   ON recovery_codes(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_user      ON login_audit(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status, check_in);
  CREATE INDEX IF NOT EXISTS idx_notifications    ON notifications(created_at);
`);

// `users` and `sessions` survive schema upgrades, so new columns are added
// in place rather than by recreating the table.
function addColumnIfMissing(table, column, definition) {
  const columns = db.pragma(`table_info(${table})`).map((c) => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('users', 'phone', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'totp_secret', 'TEXT NULL');
addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'locked_until', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'last_login_at', 'TEXT NULL');
addColumnIfMissing('sessions', 'absolute_expires_at', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('sessions', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('sessions', 'ip', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'google_sub', 'TEXT NULL');

// Partial, so the many password-only accounts (all NULL here) do not collide
// with each other while one Google identity still maps to at most one account.
// Created after the column is added, since older databases lack it.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL'
);

db.pragma(`user_version = ${SCHEMA_VERSION}`);

// The guesthouse row always exists, so the owner edits rather than creates it.
db.prepare('INSERT OR IGNORE INTO property (id) VALUES (1)').run();

// Seed example rooms so a fresh install has something to show. No account is
// created here: the owner account is provisioned separately by
// `npm run create-owner`, so seed data never ships usable credentials.
if (process.env.SEED_DEMO !== '0') {
  const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
  if (roomCount === 0) {
    const seed = db.transaction(() => {
      db.prepare(
        `UPDATE property SET
           name = ?, tagline = ?, about = ?, location = ?,
           contact_name = ?, contact_email = ?, contact_phone = ?
         WHERE id = 1`
      ).run(
        "Colonel's Paradise Homestay",
        'Four rooms with mountain views, ten minutes from the village',
        'A family-run homestay on the quiet edge of the village. Breakfast is served on the veranda, ' +
          'the garden looks out across the valley, and the market is a ten-minute walk away.',
        'Bir, Himachal',
        'Priya Sharma',
        'stay@colonelsparadise.example',
        '+91 90000 00000'
      );

      const insertRoom = db.prepare(
        'INSERT INTO rooms (name, description, price_per_night, max_guests) VALUES (?, ?, ?, ?)'
      );
      insertRoom.run('Valley-facing Room', 'King bed, private balcony over the valley, en-suite bathroom.', 4200, 2);
      insertRoom.run('Garden Room', 'Queen bed opening onto the garden, walk-in shower.', 3400, 2);
      insertRoom.run('Family Room', 'One double and two singles, ideal for families with children.', 5600, 4);
      insertRoom.run('Attic Single', 'Compact single room under the eaves with a reading nook.', 1900, 1);
    });
    seed();
  }
}

module.exports = db;

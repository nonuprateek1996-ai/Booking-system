'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'booking.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema version 2 replaced the original hourly room-slot model with the
// property-rental model. The legacy tables are incompatible, so they are
// dropped on upgrade (the old data was demo seed data only).
const SCHEMA_VERSION = 2;
const currentVersion = db.pragma('user_version', { simple: true });

if (currentVersion < SCHEMA_VERSION) {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('resources', 'bookings')")
    .all()
    .map((r) => r.name);
  if (legacy.length > 0) {
    db.exec('DROP TABLE IF EXISTS bookings; DROP TABLE IF EXISTS resources;');
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'owner', 'admin')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS properties (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    location        TEXT    NOT NULL,
    price_per_night INTEGER NOT NULL CHECK (price_per_night > 0),
    max_guests      INTEGER NOT NULL DEFAULT 2 CHECK (max_guests > 0),
    contact_name    TEXT    NOT NULL DEFAULT '',
    contact_email   TEXT    NOT NULL DEFAULT '',
    contact_phone   TEXT    NOT NULL DEFAULT '',
    published       INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS property_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    mime_type   TEXT    NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes       BLOB    NOT NULL,
    caption     TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    check_in    TEXT    NOT NULL,
    check_out   TEXT    NOT NULL,
    guests      INTEGER NOT NULL DEFAULT 1 CHECK (guests > 0),
    total_price INTEGER NOT NULL CHECK (total_price >= 0),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (check_out > check_in)
  );

  CREATE INDEX IF NOT EXISTS idx_properties_owner  ON properties(owner_id);
  CREATE INDEX IF NOT EXISTS idx_rooms_property    ON rooms(property_id);
  CREATE INDEX IF NOT EXISTS idx_images_property   ON property_images(property_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_guest    ON bookings(guest_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_property ON bookings(property_id, check_in, check_out);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry   ON sessions(expires_at);
`);

db.pragma(`user_version = ${SCHEMA_VERSION}`);

// Seed a few example listings so the landing page is not empty on a fresh
// deploy. The demo owner is given an unguessable random password that is
// never stored or printed, so the account cannot be logged into — seeded
// data must never ship usable credentials.
if (process.env.SEED_DEMO !== '0') {
  const propertyCount = db.prepare('SELECT COUNT(*) AS n FROM properties').get().n;
  if (propertyCount === 0) {
    const seed = db.transaction(() => {
      const unusableHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
      const owner = db
        .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')")
        .run('demo-listings@example.com', 'Demo Listings', unusableHash);

      const insertProperty = db.prepare(
        `INSERT INTO properties
           (owner_id, title, description, location, price_per_night, max_guests,
            contact_name, contact_email, contact_phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertRoom = db.prepare('INSERT INTO rooms (property_id, name, description) VALUES (?, ?, ?)');

      const samples = [
        {
          title: 'Hillside Cottage',
          description:
            'A quiet stone cottage with valley views, a wood-burning stove and a garden terrace. Ten minutes from the town centre.',
          location: 'Manali, Himachal Pradesh',
          price: 4500,
          guests: 4,
          rooms: [
            ['Master bedroom', 'King bed, en-suite bathroom, valley-facing window.'],
            ['Second bedroom', 'Two single beds and a writing desk.'],
            ['Living room', 'Wood stove, sofa bed, dining table for six.'],
          ],
        },
        {
          title: 'Riverside Apartment',
          description:
            'Bright two-bedroom apartment on the river promenade, walking distance to cafes and the market.',
          location: 'Rishikesh, Uttarakhand',
          price: 3200,
          guests: 4,
          rooms: [
            ['Bedroom one', 'Queen bed with river view and blackout curtains.'],
            ['Bedroom two', 'Double bed and built-in wardrobe.'],
          ],
        },
        {
          title: 'Beachfront Villa',
          description:
            'Private villa fifty metres from the sand, with a plunge pool, outdoor shower and shaded veranda.',
          location: 'Candolim, Goa',
          price: 11000,
          guests: 8,
          rooms: [
            ['Poolside suite', 'King bed opening onto the pool deck.'],
            ['Garden room', 'Two doubles, ideal for families.'],
            ['Loft', 'Three singles under the eaves.'],
          ],
        },
      ];

      for (const s of samples) {
        const result = insertProperty.run(
          owner.lastInsertRowid,
          s.title,
          s.description,
          s.location,
          s.price,
          s.guests,
          'Demo Listings',
          'demo-listings@example.com',
          '+91 90000 00000'
        );
        for (const [name, description] of s.rooms) {
          insertRoom.run(result.lastInsertRowid, name, description);
        }
      }
    });
    seed();
  }
}

module.exports = db;

'use strict';

// The schema guard in src/db.js. This lives in its own file because each case
// needs a database opened from scratch at a chosen user_version, which means
// loading src/db.js more than once with a different DATA_DIR each time.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';

// Builds a database at an older schema version, shaped closely enough to the
// real thing for the guard to inspect: a rooms table and a bookings table.
function legacyDatabase({ version, withRows }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-schema-'));
  const db = new Database(path.join(dir, 'booking.db'));
  db.exec(`
    CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, guest TEXT);
  `);
  if (withRows) {
    db.prepare('INSERT INTO rooms (name) VALUES (?)').run('Valley-facing Room');
    db.prepare('INSERT INTO bookings (guest) VALUES (?)').run('A real guest');
  }
  db.pragma(`user_version = ${version}`);
  db.close();
  return dir;
}

// src/db.js reads DATA_DIR and opens the file at require time, so the module
// cache has to be dropped between cases.
function loadDb(dir) {
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/db')];
  return require('../src/db');
}

function cleanup(dir) {
  delete require.cache[require.resolve('../src/db')];
  fs.rmSync(dir, { recursive: true, force: true });
}

test('a legacy database holding data refuses to start rather than dropping it', () => {
  const dir = legacyDatabase({ version: 2, withRows: true });
  try {
    assert.throws(
      () => loadDb(dir),
      /Refusing to upgrade schema v2 -> v3.*bookings: 1/s,
      'the guard names what would have been destroyed'
    );

    // The point of the guard: the data is still on disk afterwards.
    const check = new Database(path.join(dir, 'booking.db'));
    assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
    assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 1);
    check.close();
  } finally {
    cleanup(dir);
  }
});

test('the legacy upgrade still runs when there is nothing to lose', () => {
  const dir = legacyDatabase({ version: 2, withRows: false });
  try {
    const db = loadDb(dir);
    assert.strictEqual(db.pragma('user_version', { simple: true }), 3);
    // The v3 schema replaced the empty legacy tables.
    const columns = db.pragma('table_info(bookings)').map((c) => c.name);
    assert.ok(columns.includes('check_in'), 'the current bookings table is in place');
  } finally {
    cleanup(dir);
  }
});

test('an explicit override still allows the destructive upgrade', () => {
  const dir = legacyDatabase({ version: 2, withRows: true });
  process.env.ALLOW_DESTRUCTIVE_MIGRATION = '1';
  try {
    const db = loadDb(dir);
    assert.strictEqual(db.pragma('user_version', { simple: true }), 3);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
  } finally {
    delete process.env.ALLOW_DESTRUCTIVE_MIGRATION;
    cleanup(dir);
  }
});

test('a database newer than the running build stops the deploy', () => {
  // What a rolled-back deploy looks like: the disk survived the rollback and
  // still carries the newer schema. Writing to it could produce rows the newer
  // build cannot read, so the older build must not open it.
  const dir = legacyDatabase({ version: 3, withRows: true });
  const db = new Database(path.join(dir, 'booking.db'));
  db.pragma('user_version = 4');
  db.close();
  try {
    assert.throws(() => loadDb(dir), /newer than this build/);
  } finally {
    cleanup(dir);
  }
});

// Not covered here: the "No migration exists from schema vN" branch. It cannot
// be reached while SCHEMA_VERSION is 3, because every version below 3 is on the
// discardable list. It exists for the case this whole change is about — someone
// raising SCHEMA_VERSION to 4 for a new feature. A v3 database is then neither
// current nor discardable, so that branch stops the deploy instead of dropping
// live bookings. Exercising it would mean letting tests override the schema
// version, which is a worse risk in production than the missing assertion.

test('a fresh database is created at the current version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-schema-new-'));
  try {
    const db = loadDb(dir);
    assert.strictEqual(db.pragma('user_version', { simple: true }), 3);
  } finally {
    cleanup(dir);
  }
});

test('an existing v3 database keeps its rows across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-schema-v3-'));
  try {
    const first = loadDb(dir);
    first.prepare('INSERT INTO rooms (name, price_per_night, max_guests) VALUES (?, ?, ?)').run(
      'Garden Room',
      3400,
      2
    );
    first.close();

    const second = loadDb(dir);
    const room = second.prepare('SELECT name FROM rooms').get();
    assert.strictEqual(room.name, 'Garden Room', 'a routine restart migrates nothing and loses nothing');
  } finally {
    cleanup(dir);
  }
});

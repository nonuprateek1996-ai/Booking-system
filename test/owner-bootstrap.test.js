'use strict';

// Verifies owner provisioning from the environment: creation on a fresh
// database, refusal to clobber an existing account on a routine restart,
// explicit rotation with force, and rejection of weak or conflicting input.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-bootstrap-'));
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';

const db = require('../src/db');
const { ensureOwner } = require('../src/owner-bootstrap');

after(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const EMAIL = 'owner@example.com';
const PASSWORD = 'first-Password-123';

function passwordHash() {
  return db.prepare('SELECT password_hash FROM users WHERE email = ?').get(EMAIL).password_hash;
}

test('creates the owner on a fresh database', () => {
  const result = ensureOwner({ email: EMAIL, password: PASSWORD });
  assert.deepStrictEqual(result, { ok: true, action: 'created' });

  const row = db.prepare('SELECT role FROM users WHERE email = ?').get(EMAIL);
  assert.strictEqual(row.role, 'owner');
  assert.ok(bcrypt.compareSync(PASSWORD, passwordHash()));

  // The public contact email defaults to the owner until edited.
  const property = db.prepare('SELECT contact_email FROM property WHERE id = 1').get();
  assert.strictEqual(property.contact_email, EMAIL);
});

test('a routine restart never overwrites the existing account', () => {
  const before1 = passwordHash();
  // Same env vars still set, force absent — exactly what a redeploy looks like.
  const result = ensureOwner({ email: EMAIL, password: 'different-Password-456' });
  assert.deepStrictEqual(result, { ok: true, action: 'unchanged' });
  assert.strictEqual(passwordHash(), before1, 'password hash untouched');
});

test('force rotates the password and revokes sessions', () => {
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    'stale-session-hash',
    db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL).id,
    Date.now() + 60000
  );

  const result = ensureOwner({ email: EMAIL, password: 'rotated-Password-789', force: true });
  assert.deepStrictEqual(result, { ok: true, action: 'rotated' });
  assert.ok(bcrypt.compareSync('rotated-Password-789', passwordHash()));

  const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  assert.strictEqual(sessions, 0, 'all sessions revoked on rotation');
});

test('weak passwords and bad emails are rejected', () => {
  assert.strictEqual(ensureOwner({ email: 'not-an-email', password: PASSWORD }).ok, false);
  assert.strictEqual(ensureOwner({ email: 'x@y.com', password: 'short' }).ok, false);
  assert.strictEqual(ensureOwner({ email: 'x@y.com', password: 'password123!' }).ok, false);
});

test('a guest address cannot be promoted, and a second owner cannot be created', () => {
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'guest')").run(
    'guest@example.com',
    'Guest',
    bcrypt.hashSync('guest-password-1', 10)
  );
  const promoted = ensureOwner({ email: 'guest@example.com', password: 'strong-Password-123', force: true });
  assert.strictEqual(promoted.ok, false);

  const second = ensureOwner({ email: 'second-owner@example.com', password: 'strong-Password-123' });
  assert.strictEqual(second.ok, false);
  assert.match(second.reason, /already exists/);
});

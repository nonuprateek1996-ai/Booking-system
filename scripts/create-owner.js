'use strict';

// Provisions the single owner account. This is the ONLY way an owner account
// comes into existence — there is no network path that can create one, so an
// attacker cannot register their way into the owner role.
//
//   OWNER_EMAIL=you@example.com OWNER_PASSWORD='...' npm run create-owner
//
// Re-running it updates the password of the existing owner, which doubles as
// the password-reset path. Credentials come from the environment and are never
// written to disk or printed.

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const v = require('../src/validators');

const email = process.env.OWNER_EMAIL;
const name = process.env.OWNER_NAME || 'Owner';
const password = process.env.OWNER_PASSWORD;

if (!v.isValidEmail(email ?? '')) {
  console.error('Set OWNER_EMAIL to a valid email address.');
  process.exit(1);
}

const strength = v.isStrongOwnerPassword(password ?? '');
if (!strength.ok) {
  console.error(`OWNER_PASSWORD rejected: ${strength.error}`);
  process.exit(1);
}

const normalized = v.normalizeEmail(email);
const hash = bcrypt.hashSync(password, 12);

const existingOwner = db.prepare("SELECT id, email FROM users WHERE role IN ('owner', 'admin')").get();
const existingAccount = db.prepare('SELECT id, role FROM users WHERE email = ?').get(normalized);

if (existingAccount && existingAccount.role === 'guest') {
  console.error(
    `${normalized} is already a guest account. Use a different address for the owner account.`
  );
  process.exit(1);
}

if (existingAccount) {
  // Rotating the password also revokes every session and clears any lockout.
  db.prepare(
    "UPDATE users SET password_hash = ?, name = ?, role = 'owner', failed_attempts = 0, locked_until = 0 WHERE id = ?"
  ).run(hash, name, existingAccount.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existingAccount.id);
  console.log(`Updated the owner account ${normalized}. All existing sessions were signed out.`);
} else if (existingOwner) {
  console.error(
    `An owner account already exists (${existingOwner.email}). ` +
      'Re-run with that address to rotate its password, or delete it first.'
  );
  process.exit(1);
} else {
  const result = db
    .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')")
    .run(normalized, name, hash);
  // Point the public contact details at the owner until they edit them.
  db.prepare("UPDATE property SET contact_email = ? WHERE id = 1 AND contact_email = ''").run(normalized);
  console.log(`Created the owner account ${normalized} (user id ${result.lastInsertRowid}).`);
}

console.log('Sign in at /owner-login.html, then turn on two-factor authentication in Security.');

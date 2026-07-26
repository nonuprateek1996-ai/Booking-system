'use strict';

// Owner-account provisioning, shared by `npm run create-owner` and by server
// startup. Startup provisioning exists for hosts with no shell access (e.g.
// Render's free tier) and for ephemeral filesystems, where the database is
// recreated on every restart and the owner account must come back with it.

const bcrypt = require('bcryptjs');
const db = require('./db');
const v = require('./validators');

/**
 * Ensure the single owner account exists.
 *
 * `force` controls what happens when the account already exists:
 *   false — leave it untouched (a routine restart must never clobber a
 *           password the owner changed through the UI);
 *   true  — rotate the password, clear any lockout, and revoke all sessions
 *           (the explicit reset path).
 */
function ensureOwner({ email, password, name = 'Owner', force = false }) {
  if (!v.isValidEmail(email ?? '')) {
    return { ok: false, reason: 'OWNER_EMAIL is not a valid email address' };
  }
  const strength = v.isStrongOwnerPassword(password ?? '');
  if (!strength.ok) {
    return { ok: false, reason: `OWNER_PASSWORD rejected: ${strength.error}` };
  }

  const normalized = v.normalizeEmail(email);
  const account = db.prepare('SELECT id, role FROM users WHERE email = ?').get(normalized);

  if (account && account.role === 'guest') {
    return { ok: false, reason: `${normalized} is already a guest account; use a different owner address` };
  }

  if (account) {
    if (!force) {
      return { ok: true, action: 'unchanged' };
    }
    db.prepare(
      "UPDATE users SET password_hash = ?, name = ?, role = 'owner', failed_attempts = 0, locked_until = 0 WHERE id = ?"
    ).run(bcrypt.hashSync(password, 12), name, account.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(account.id);
    return { ok: true, action: 'rotated' };
  }

  const existingOwner = db.prepare("SELECT email FROM users WHERE role IN ('owner', 'admin')").get();
  if (existingOwner) {
    return {
      ok: false,
      reason: `An owner account already exists (${existingOwner.email}); re-run with that address to rotate its password`,
    };
  }

  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')").run(
    normalized,
    name,
    bcrypt.hashSync(password, 12)
  );
  // Point the public contact details at the owner until they edit them.
  db.prepare("UPDATE property SET contact_email = ? WHERE id = 1 AND contact_email = ''").run(normalized);
  return { ok: true, action: 'created' };
}

// Startup hook: provisions from OWNER_EMAIL / OWNER_PASSWORD when both are
// set. OWNER_FORCE_RESET=1 turns a boot into an explicit password reset —
// remove it again afterwards, or every restart revokes the owner's sessions.
function ensureOwnerFromEnv() {
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!email && !password) {
    return null; // not configured; scripts/create-owner.js is the other path
  }
  const result = ensureOwner({
    email,
    password,
    name: process.env.OWNER_NAME || 'Owner',
    force: process.env.OWNER_FORCE_RESET === '1',
  });
  // Log outcomes without ever logging the credentials themselves.
  if (!result.ok) {
    console.error(`Owner bootstrap: ${result.reason}`);
  } else if (result.action !== 'unchanged') {
    console.log(`Owner bootstrap: account ${result.action}.`);
  }
  return result;
}

module.exports = { ensureOwner, ensureOwnerFromEnv };

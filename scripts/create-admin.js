'use strict';

// Promote-or-create an admin account from environment variables:
//   ADMIN_EMAIL=admin@example.com ADMIN_NAME="Admin" ADMIN_PASSWORD=... npm run create-admin
// Credentials are taken from the environment (never hard-coded or committed).

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const v = require('../src/validators');

const email = process.env.ADMIN_EMAIL;
const name = process.env.ADMIN_NAME || 'Administrator';
const password = process.env.ADMIN_PASSWORD;

if (!v.isValidEmail(email ?? '')) {
  console.error('Set ADMIN_EMAIL to a valid email address.');
  process.exit(1);
}
if (!v.isValidPassword(password ?? '')) {
  console.error('Set ADMIN_PASSWORD to a password of 8-72 characters.');
  process.exit(1);
}

const normalized = v.normalizeEmail(email);
const hash = bcrypt.hashSync(password, 12);

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(hash, existing.id);
  console.log(`Updated existing user ${normalized} to admin.`);
} else {
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    normalized,
    name,
    hash
  );
  console.log(`Created admin account ${normalized}.`);
}

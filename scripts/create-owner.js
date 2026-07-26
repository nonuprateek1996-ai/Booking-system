'use strict';

// Provisions or resets the single owner account from the command line:
//
//   OWNER_EMAIL=you@example.com OWNER_PASSWORD='...' npm run create-owner
//
// Running this script is always an explicit action, so it rotates the
// password (and revokes all sessions) when the account already exists —
// which doubles as the password-reset path. The same logic runs at server
// startup (without rotation) for hosts that have no shell access; see
// src/owner-bootstrap.js.

const { ensureOwner } = require('../src/owner-bootstrap');

const result = ensureOwner({
  email: process.env.OWNER_EMAIL,
  password: process.env.OWNER_PASSWORD,
  name: process.env.OWNER_NAME || 'Owner',
  force: true,
});

if (!result.ok) {
  console.error(result.reason);
  process.exit(1);
}

if (result.action === 'created') {
  console.log('Created the owner account.');
} else {
  console.log('Owner password rotated. All existing sessions were signed out.');
}
console.log('Sign in at /owner-login.html, then turn on two-factor authentication in Security.');

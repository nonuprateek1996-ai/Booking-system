'use strict';

const app = require('./app');
const { ensureOwnerFromEnv } = require('./owner-bootstrap');

// Provision the owner account from OWNER_EMAIL / OWNER_PASSWORD before
// accepting traffic. This is the supported path on hosts without shell
// access, and it recreates the account automatically when the database
// lives on an ephemeral filesystem.
ensureOwnerFromEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Booking system listening on http://${HOST}:${PORT}`);
});

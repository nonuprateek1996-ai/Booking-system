'use strict';

// Verifies that credential endpoints are actually throttled. This lives in its
// own file because node:test gives each file a fresh process, so the limiter
// can be configured low here without affecting the main suite.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-ratelimit-'));
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';
process.env.AUTH_RATE_LIMIT = '3';
process.env.OWNER_RATE_LIMIT = '3';

const app = require('../src/app');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

async function login() {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'victim@example.com', password: 'guessing-away', portal: 'guest' }),
  });
  return res.status;
}

test('repeated failed logins are throttled', async () => {
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    statuses.push(await login());
  }
  // The configured limit is 3, so later attempts must be refused with 429.
  assert.strictEqual(statuses.filter((s) => s === 429).length, 2);
  assert.strictEqual(statuses.at(-1), 429, 'brute-force attempts are blocked');
});

'use strict';

// End-to-end API tests, including security regression tests
// (auth enforcement, IDOR, SQL injection, CSRF origin checks, double booking).
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolated throwaway database for the test run.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-test-'));
process.env.NODE_ENV = 'test';

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

// Minimal cookie-jar client.
function client() {
  const jar = new Map();
  return async function request(method, urlPath, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar.size > 0) {
      headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
}

function futureDate(daysAhead = 7) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

test('rejects registration with weak password or bad email', async () => {
  const c = client();
  let r = await c('POST', '/api/auth/register', { email: 'a@b.com', name: 'A', password: 'short' });
  assert.strictEqual(r.status, 400);
  r = await c('POST', '/api/auth/register', { email: 'not-an-email', name: 'A', password: 'longenough1' });
  assert.strictEqual(r.status, 400);
});

test('register, login, and session flow', async () => {
  const c = client();
  let r = await c('POST', '/api/auth/register', {
    email: 'alice@example.com',
    name: 'Alice',
    password: 'correct horse battery',
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.user.role, 'user');

  r = await c('GET', '/api/auth/me');
  assert.strictEqual(r.data.user.email, 'alice@example.com');

  r = await c('POST', '/api/auth/logout', {});
  assert.strictEqual(r.status, 200);

  r = await c('GET', '/api/auth/me');
  assert.strictEqual(r.data.user, null);

  r = await c('POST', '/api/auth/login', { email: 'ALICE@example.com', password: 'correct horse battery' });
  assert.strictEqual(r.status, 200, 'login is case-insensitive on email');
});

test('login gives the same error for unknown email and wrong password (no user enumeration)', async () => {
  const c = client();
  const r1 = await c('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever123' });
  const r2 = await c('POST', '/api/auth/login', { email: 'alice@example.com', password: 'wrongpassword' });
  assert.strictEqual(r1.status, 401);
  assert.strictEqual(r2.status, 401);
  assert.strictEqual(r1.data.error, r2.data.error);
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  const c = client();
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery' }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('session='));
  assert.ok(cookie, 'session cookie set');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('booking endpoints require authentication', async () => {
  const c = client();
  let r = await c('GET', '/api/bookings');
  assert.strictEqual(r.status, 401);
  r = await c('POST', '/api/bookings', { resourceId: 1, date: futureDate(), slot: '09:00' });
  assert.strictEqual(r.status, 401);
});

test('booking create/list/cancel and double-booking prevention', async () => {
  const c = client();
  await c('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });

  const date = futureDate();
  let r = await c('POST', '/api/bookings', { resourceId: 1, date, slot: '10:00' });
  assert.strictEqual(r.status, 201);
  const bookingId = r.data.booking.id;

  // Same slot again -> conflict, even for the same user.
  r = await c('POST', '/api/bookings', { resourceId: 1, date, slot: '10:00' });
  assert.strictEqual(r.status, 409);

  // Slot shows as unavailable.
  r = await c('GET', `/api/resources/1/availability?date=${date}`);
  const slot = r.data.slots.find((s) => s.slot === '10:00');
  assert.strictEqual(slot.available, false);

  r = await c('GET', '/api/bookings');
  assert.ok(r.data.bookings.some((b) => b.id === bookingId));

  r = await c('DELETE', `/api/bookings/${bookingId}`);
  assert.strictEqual(r.status, 200);
});

test('rejects invalid dates and slots', async () => {
  const c = client();
  await c('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });

  for (const bad of [
    { resourceId: 1, date: '2020-01-01', slot: '09:00' }, // past
    { resourceId: 1, date: futureDate(120), slot: '09:00' }, // too far ahead
    { resourceId: 1, date: '2026-02-31', slot: '09:00' }, // not a real date
    { resourceId: 1, date: futureDate(), slot: '03:30' }, // not a slot
    { resourceId: 1, date: futureDate(), slot: "09:00' OR '1'='1" },
  ]) {
    const r = await c('POST', '/api/bookings', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
  }
});

test('IDOR: a user cannot cancel another user\'s booking', async () => {
  const alice = client();
  await alice('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
  const r1 = await alice('POST', '/api/bookings', { resourceId: 2, date: futureDate(3), slot: '11:00' });
  assert.strictEqual(r1.status, 201);

  const mallory = client();
  await mallory('POST', '/api/auth/register', {
    email: 'mallory@example.com',
    name: 'Mallory',
    password: 'malloryspassword',
  });
  const r2 = await mallory('DELETE', `/api/bookings/${r1.data.booking.id}`);
  assert.strictEqual(r2.status, 404, 'other users\' bookings are invisible');

  // Alice can still see and cancel it.
  const r3 = await alice('DELETE', `/api/bookings/${r1.data.booking.id}`);
  assert.strictEqual(r3.status, 200);
});

test('SQL injection attempts are handled safely', async () => {
  const c = client();
  const r1 = await c('POST', '/api/auth/login', {
    email: "x@y.com' OR '1'='1",
    password: "' OR '1'='1' --",
  });
  assert.ok(r1.status === 400 || r1.status === 401);

  const r2 = await c('GET', "/api/resources/1'%20OR%20'1'='1/availability?date=2026-08-01");
  assert.strictEqual(r2.status, 400);
});

test('admin endpoints are forbidden for regular users', async () => {
  const c = client();
  await c('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
  let r = await c('GET', '/api/admin/bookings');
  assert.strictEqual(r.status, 403);
  r = await c('POST', '/api/admin/resources', { name: 'Rogue room' });
  assert.strictEqual(r.status, 403);
});

test('cross-origin state-changing requests are rejected (CSRF)', async () => {
  const c = client();
  await c('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
  const r = await c(
    'POST',
    '/api/bookings',
    { resourceId: 1, date: futureDate(), slot: '12:00' },
    { Origin: 'https://evil.example.com' }
  );
  assert.strictEqual(r.status, 403);
});

test('security headers are present and framework is not advertised', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.ok(res.headers.get('content-security-policy'));
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('malformed JSON body returns 400, not a stack trace', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error, 'Invalid request body');
});

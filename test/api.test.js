'use strict';

// End-to-end API tests for the guesthouse booking site, including security
// regression tests: owner-role isolation, no owner self-registration, 2FA,
// account lockout, session revocation, upload validation, SQL injection,
// CSRF, IDOR, and overlap-safe booking.
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-test-'));
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';
// Raise the throttles so the suite is not rate-limited against itself; the
// limiters themselves are verified in test/ratelimit.test.js.
process.env.AUTH_RATE_LIMIT = '5000';
process.env.OWNER_RATE_LIMIT = '5000';
process.env.GLOBAL_RATE_LIMIT = '20000';

const app = require('../src/app');
const db = require('../src/db');
const totp = require('../src/totp');

let server;
let baseUrl;

const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'owner-Password-9876';

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The owner account exists only via server-side provisioning, exactly as
  // scripts/create-owner.js does it.
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')").run(
    OWNER_EMAIL,
    'Owner',
    bcrypt.hashSync(OWNER_PASSWORD, 10)
  );
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function client() {
  const jar = new Map();
  return async function request(method, urlPath, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    let payload;
    if (Buffer.isBuffer(body)) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      payload = JSON.stringify(body);
    }
    if (jar.size > 0) {
      headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(baseUrl + urlPath, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json().catch(() => ({})) : {};
    return { status: res.status, data, headers: res.headers };
  };
}

function dateIn(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function ownerClient() {
  const c = client();
  const r = await c('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

function ownerSecret() {
  return db.prepare('SELECT totp_secret FROM users WHERE email = ?').get(OWNER_EMAIL).totp_secret;
}

// A consumed TOTP step is refused for replay, so in real use the next sign-in
// happens a window later. Tests stand in for that passage of time by clearing
// the consumed-step marker rather than sleeping 30 seconds.
function simulateClockAdvance() {
  db.prepare('UPDATE users SET totp_last_step = 0 WHERE email = ?').run(OWNER_EMAIL);
}

function clearLockout(email = OWNER_EMAIL) {
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE email = ?').run(email);
}

async function ownerTotpClient() {
  simulateClockAdvance();
  const c = client();
  const r = await c('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
    totpCode: totp.codeForStep(ownerSecret(), totp.currentStep()),
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

async function makeGuest(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', {
    email,
    name: 'Guest',
    password: 'guest-password-1',
    phone: '+91 90000 12345',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return c;
}

async function makeRoom(owner, overrides = {}) {
  const r = await owner('POST', '/api/owner/rooms', {
    name: `Room ${Math.random().toString(36).slice(2, 8)}`,
    pricePerNight: 2000,
    maxGuests: 2,
    description: 'A room for testing.',
    ...overrides,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.room.id;
}

// --- Public browsing ---

test('the landing page is the guesthouse, not a login screen', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Check availability/);
  assert.doesNotMatch(html, /Password/);
});

test('the property and rooms are readable with no account', async () => {
  const anon = client();
  const property = await anon('GET', '/api/property');
  assert.strictEqual(property.status, 200);
  assert.ok(property.data.property.name);

  const rooms = await anon('GET', '/api/rooms');
  assert.strictEqual(rooms.status, 200);
  assert.ok(Array.isArray(rooms.data.rooms));
});

test('owner contact details are visible to anonymous visitors', async () => {
  const owner = await ownerClient();
  await owner('PATCH', '/api/owner/property', {
    name: 'Lakeview Homestay',
    location: 'Nainital',
    contactName: 'Priya Sharma',
    contactEmail: 'priya@example.com',
    contactPhone: '+91 98765 43210',
  });

  const anon = client();
  const r = await anon('GET', '/api/property');
  assert.strictEqual(r.data.property.contactName, 'Priya Sharma');
  assert.strictEqual(r.data.property.contactEmail, 'priya@example.com');
  assert.strictEqual(r.data.property.contactPhone, '+91 98765 43210');
});

test('unpublished rooms are hidden from the public', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Hidden Room' });
  await owner('PATCH', `/api/owner/rooms/${id}`, { published: false });

  const anon = client();
  const list = await anon('GET', '/api/rooms');
  assert.ok(!list.data.rooms.some((r) => r.id === id));
  const detail = await anon('GET', `/api/rooms/${id}`);
  assert.strictEqual(detail.status, 404);

  // The owner can still see it.
  const ownerView = await owner('GET', `/api/rooms/${id}`);
  assert.strictEqual(ownerView.status, 200);
});

// --- Availability search ---

test('searching with dates hides rooms already held for those nights', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Search Room' });
  const guest = await makeGuest('search-guest@example.com');

  const anon = client();
  let r = await anon('GET', `/api/rooms?checkIn=${dateIn(200)}&checkOut=${dateIn(204)}`);
  assert.ok(r.data.rooms.some((x) => x.id === id), 'free before anyone books');

  const booked = await guest('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(201),
    checkOut: dateIn(203),
  });
  assert.strictEqual(booked.status, 201);

  // A pending request holds the dates just like a confirmed one.
  r = await anon('GET', `/api/rooms?checkIn=${dateIn(200)}&checkOut=${dateIn(204)}`);
  assert.ok(!r.data.rooms.some((x) => x.id === id), 'a requested room is not offered again');

  r = await anon('GET', `/api/rooms?checkIn=${dateIn(210)}&checkOut=${dateIn(212)}`);
  assert.ok(r.data.rooms.some((x) => x.id === id), 'clear dates are still bookable');

  r = await anon('GET', `/api/rooms?checkIn=${dateIn(203)}&checkOut=${dateIn(205)}`);
  assert.ok(r.data.rooms.some((x) => x.id === id), 'same-day changeover stays available');
});

test('a dated search quotes the whole stay', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Quote Room', pricePerNight: 2500 });
  const anon = client();
  const r = await anon('GET', `/api/rooms?checkIn=${dateIn(220)}&checkOut=${dateIn(224)}`);
  assert.strictEqual(r.data.nights, 4);
  const found = r.data.rooms.find((x) => x.id === id);
  assert.strictEqual(found.stayTotal, 10000);
});

test('search rejects half-open and impossible date ranges', async () => {
  const anon = client();
  for (const query of [
    `checkIn=${dateIn(5)}`,
    `checkOut=${dateIn(5)}`,
    `checkIn=${dateIn(9)}&checkOut=${dateIn(7)}`,
    `checkIn=${dateIn(5)}&checkOut=${dateIn(5)}`,
    'checkIn=2026-02-31&checkOut=2026-03-05',
    `checkIn=${dateIn(-4)}&checkOut=${dateIn(2)}`,
  ]) {
    const r = await anon('GET', `/api/rooms?${query}`);
    assert.strictEqual(r.status, 400, query);
  }
});

// --- Owner account security ---

test('nobody can register as an owner', async () => {
  const c = client();
  // The role field is simply not honoured any more.
  const r = await c('POST', '/api/auth/register', {
    email: 'wannabe-owner@example.com',
    name: 'Sneaky',
    password: 'sneaky-password',
    role: 'owner',
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.user.role, 'guest', 'a self-registered account is always a guest');

  // And that account cannot reach the owner portal or its endpoints.
  const login = await c('POST', '/api/auth/login', {
    email: 'wannabe-owner@example.com',
    password: 'sneaky-password',
    portal: 'owner',
  });
  assert.strictEqual(login.status, 401);
  const rooms = await c('GET', '/api/owner/rooms');
  assert.strictEqual(rooms.status, 403);
});

test('the owner cannot sign in through the guest portal', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'guest',
  });
  assert.strictEqual(r.status, 401);
});

test('wrong portal, wrong password and unknown account are indistinguishable', async () => {
  const c = client();
  const wrongPortal = await c('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'guest',
  });
  const wrongPassword = await c('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: 'not-the-password',
    portal: 'owner',
  });
  const unknown = await c('POST', '/api/auth/login', {
    email: 'ghost@example.com',
    password: 'not-the-password',
    portal: 'owner',
  });
  assert.strictEqual(wrongPortal.data.error, wrongPassword.data.error);
  assert.strictEqual(wrongPortal.data.error, unknown.data.error);
  // Clear the failures those attempts recorded.
  clearLockout();
});

test('repeated wrong passwords lock the account temporarily', async () => {
  const email = 'lockme@example.com';
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')").run(
    email,
    'Lock Test',
    bcrypt.hashSync('lock-Test-password-1', 10)
  );
  const c = client();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await c('POST', '/api/auth/login', { email, password: 'wrong-password', portal: 'owner' });
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(429), 'the account locks after repeated failures');

  // Even the correct password is refused while locked.
  const correct = await c('POST', '/api/auth/login', {
    email,
    password: 'lock-Test-password-1',
    portal: 'owner',
  });
  assert.strictEqual(correct.status, 429);

  // The lock is temporary, not permanent.
  const row = db.prepare('SELECT locked_until FROM users WHERE email = ?').get(email);
  assert.ok(row.locked_until > Date.now(), 'lock has a future expiry');
  assert.ok(row.locked_until < Date.now() + 7 * 60 * 60 * 1000, 'lock is bounded, not forever');
});

test('two-factor: setup, enable, and required at sign-in', async () => {
  const owner = await ownerClient();

  const setup = await owner('POST', '/api/auth/2fa/setup', {});
  assert.strictEqual(setup.status, 200);
  assert.ok(setup.data.secret);
  assert.match(setup.data.uri, /^otpauth:\/\/totp\//);

  // A wrong code must not switch it on.
  const bad = await owner('POST', '/api/auth/2fa/enable', { code: '000000' });
  assert.strictEqual(bad.status, 400);

  const code = totp.codeForStep(setup.data.secret, totp.currentStep());
  const enabled = await owner('POST', '/api/auth/2fa/enable', { code });
  assert.strictEqual(enabled.status, 200, JSON.stringify(enabled.data));
  assert.strictEqual(enabled.data.recoveryCodes.length, 8);

  // Password alone is no longer enough.
  const fresh = client();
  const noCode = await fresh('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
  });
  assert.strictEqual(noCode.status, 401);
  assert.strictEqual(noCode.data.totpRequired, true);

  // With a valid code it succeeds. (The code used during enable is already
  // consumed, so this stands in for the next window arriving.)
  simulateClockAdvance();
  const withCode = await fresh('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
    totpCode: totp.codeForStep(ownerSecret(), totp.currentStep()),
  });
  assert.strictEqual(withCode.status, 200, JSON.stringify(withCode.data));
});

test('a two-factor code cannot be replayed', async () => {
  const secret = ownerSecret();
  assert.ok(secret, 'two-factor is on from the previous test');
  simulateClockAdvance();
  const code = totp.codeForStep(secret, totp.currentStep());

  const first = client();
  const ok = await first('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
    totpCode: code,
  });
  assert.strictEqual(ok.status, 200);

  // The same code, still inside its 30-second window, must be refused.
  const second = client();
  const replay = await second('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
    totpCode: code,
  });
  assert.strictEqual(replay.status, 401);
  clearLockout();
});

test('a recovery code works once and only once', async () => {
  // Regenerate a known set, then spend one.
  const signedIn = await ownerTotpClient();
  const regen = await signedIn('POST', '/api/auth/2fa/recovery-codes', { password: OWNER_PASSWORD });
  assert.strictEqual(regen.status, 200);
  const [recoveryCode] = regen.data.recoveryCodes;

  const first = client();
  const used = await first('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
    recoveryCode,
  });
  assert.strictEqual(used.status, 200, 'recovery code signs in');

  const second = client();
  const reused = await second('POST', '/api/auth/login', {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    portal: 'owner',
    recoveryCode,
  });
  assert.strictEqual(reused.status, 401, 'the same recovery code cannot be reused');
  clearLockout();
});

test('turning two-factor off requires the password, not just a session', async () => {
  const owner = await ownerTotpClient();

  const noPassword = await owner('POST', '/api/auth/2fa/disable', {});
  assert.strictEqual(noPassword.status, 400);
  const wrongPassword = await owner('POST', '/api/auth/2fa/disable', { password: 'not-it' });
  assert.strictEqual(wrongPassword.status, 401);

  const ok = await owner('POST', '/api/auth/2fa/disable', { password: OWNER_PASSWORD });
  assert.strictEqual(ok.status, 200);
  const row = db.prepare('SELECT totp_enabled FROM users WHERE email = ?').get(OWNER_EMAIL);
  assert.strictEqual(row.totp_enabled, 0);
});

test('the owner can list and revoke other sessions', async () => {
  const first = await ownerClient();
  const second = await ownerClient();

  let view = await first('GET', '/api/auth/security');
  assert.strictEqual(view.status, 200);
  assert.ok(view.data.sessions.length >= 2);
  const other = view.data.sessions.find((s) => !s.current);
  assert.ok(other, 'the other device is listed');

  const revoked = await first('DELETE', `/api/auth/sessions/${other.id}`);
  assert.strictEqual(revoked.status, 200);

  // Whichever client held that session is now signed out.
  const secondCheck = await second('GET', '/api/auth/security');
  const firstCheck = await first('GET', '/api/auth/security');
  assert.ok(
    secondCheck.status === 401 || firstCheck.status === 401,
    'the revoked session no longer authenticates'
  );

  view = await (firstCheck.status === 401 ? second : first)('GET', '/api/auth/security');
  assert.strictEqual(view.status, 200);
});

test('sign-in attempts are recorded in the audit trail', async () => {
  const owner = await ownerClient();
  const r = await owner('GET', '/api/auth/security');
  assert.ok(r.data.recentAttempts.length > 0);
  assert.ok(r.data.recentAttempts.some((a) => a.outcome === 'success'));
  assert.ok(r.data.recentAttempts.some((a) => a.outcome === 'bad_password'));
});

test('a guest cannot revoke the owner\'s sessions or read its security page', async () => {
  const guest = await makeGuest('nosy@example.com');
  const security = await guest('GET', '/api/auth/security');
  assert.strictEqual(security.status, 403);
  const revoke = await guest('POST', '/api/auth/sessions/revoke-others', {});
  assert.strictEqual(revoke.status, 403);
});

test('the owner password policy rejects weak choices', async () => {
  const owner = await ownerClient();
  for (const weak of ['short', 'password123', 'aaaaaaaaaaaaaa', '123456789012']) {
    const r = await owner('POST', '/api/auth/change-password', {
      currentPassword: OWNER_PASSWORD,
      newPassword: weak,
    });
    assert.strictEqual(r.status, 400, weak);
  }
});

// --- Owner room management ---

test('guests cannot reach any owner endpoint', async () => {
  const guest = await makeGuest('guest-blocked@example.com');
  for (const [method, path, body] of [
    ['GET', '/api/owner/rooms', undefined],
    ['POST', '/api/owner/rooms', { name: 'X', pricePerNight: 1, maxGuests: 1 }],
    ['PATCH', '/api/owner/property', { name: 'Hacked' }],
    ['GET', '/api/owner/bookings', undefined],
    ['GET', '/api/owner/notifications', undefined],
  ]) {
    const r = await guest(method, path, body);
    assert.strictEqual(r.status, 403, `${method} ${path}`);
  }
});

test('anonymous callers cannot reach owner endpoints', async () => {
  const anon = client();
  const r = await anon('GET', '/api/owner/rooms');
  assert.strictEqual(r.status, 401);
});

test('the owner can create, edit and unpublish rooms', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Editable', pricePerNight: 1000 });

  const patched = await owner('PATCH', `/api/owner/rooms/${id}`, { name: 'Renamed', pricePerNight: 3300 });
  assert.strictEqual(patched.status, 200);

  const list = await owner('GET', '/api/owner/rooms');
  const mine = list.data.rooms.find((r) => r.id === id);
  assert.strictEqual(mine.name, 'Renamed');
  assert.strictEqual(mine.pricePerNight, 3300);
});

test('room validation rejects bad prices, names and capacities', async () => {
  const owner = await ownerClient();
  for (const body of [
    { name: '', pricePerNight: 100, maxGuests: 2 },
    { name: 'X', pricePerNight: 0, maxGuests: 2 },
    { name: 'X', pricePerNight: -5, maxGuests: 2 },
    { name: 'X', pricePerNight: 1.5, maxGuests: 2 },
    { name: 'X', pricePerNight: 100, maxGuests: 0 },
    { name: 'X', pricePerNight: 100, maxGuests: 999 },
    { name: 'X'.repeat(81), pricePerNight: 100, maxGuests: 2 },
  ]) {
    const r = await owner('POST', '/api/owner/rooms', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
});

test('deleting a room with live bookings is blocked', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Protected' });
  const guest = await makeGuest('protect-guest@example.com');
  await guest('POST', '/api/bookings', { roomId: id, checkIn: dateIn(80), checkOut: dateIn(82) });

  const r = await owner('DELETE', `/api/owner/rooms/${id}`);
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /live booking/);
});

// --- Photos ---

test('photo upload accepts real images and serves the sniffed type', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const upload = await owner('POST', `/api/owner/rooms/${id}/images`, PNG_1X1, {
    'Content-Type': 'image/png',
  });
  assert.strictEqual(upload.status, 201);

  const res = await fetch(`${baseUrl}/api/images/${upload.data.image.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
});

test('photos of the guesthouse itself can be uploaded', async () => {
  const owner = await ownerClient();
  const upload = await owner('POST', '/api/owner/property/images', PNG_1X1, {
    'Content-Type': 'image/png',
  });
  assert.strictEqual(upload.status, 201);

  const anon = client();
  const r = await anon('GET', '/api/property');
  assert.ok(r.data.imageIds.includes(upload.data.image.id));
});

test('uploads that are not real images are rejected, including disguised SVG', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');

  for (const payload of [svg, html, Buffer.from('not an image')]) {
    const r = await owner('POST', `/api/owner/rooms/${id}/images`, payload, {
      'Content-Type': 'image/png', // lying about the type must not help
    });
    assert.strictEqual(r.status, 400);
  }
});

test('oversized uploads are rejected', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const huge = Buffer.concat([PNG_1X1, Buffer.alloc(3 * 1024 * 1024)]);
  const r = await owner('POST', `/api/owner/rooms/${id}/images`, huge, { 'Content-Type': 'image/png' });
  assert.strictEqual(r.status, 413);
});

// --- Booking and approval ---

test('a booking starts pending and the total is computed server-side', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { pricePerNight: 1500 });
  const guest = await makeGuest('pending-guest@example.com');

  const r = await guest('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(10),
    checkOut: dateIn(13),
    guests: 2,
    totalPrice: 1, // a client-supplied price must be ignored
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.booking.status, 'pending');
  assert.strictEqual(r.data.booking.totalPrice, 4500);
});

test('the owner approves a request and the guest sees it confirmed', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Approvable' });
  const guest = await makeGuest('approve-guest@example.com');

  const created = await guest('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(30),
    checkOut: dateIn(32),
    note: 'Arriving late',
  });
  const bookingId = created.data.booking.id;

  const inbox = await owner('GET', '/api/owner/bookings?status=pending');
  const request = inbox.data.bookings.find((b) => b.id === bookingId);
  assert.ok(request, 'the request is in the inbox');
  assert.strictEqual(request.guestNote, 'Arriving late');
  assert.ok(request.guestEmail, 'the owner sees the guest contact details');

  const approved = await owner('POST', `/api/owner/bookings/${bookingId}/approve`, { note: 'See you then' });
  assert.strictEqual(approved.status, 200);

  const trips = await guest('GET', '/api/bookings');
  const trip = trips.data.bookings.find((b) => b.id === bookingId);
  assert.strictEqual(trip.status, 'approved');
  assert.strictEqual(trip.ownerNote, 'See you then');
});

test('declining releases the dates for someone else', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Releasable' });
  const first = await makeGuest('decline-first@example.com');
  const second = await makeGuest('decline-second@example.com');

  const created = await first('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(50),
    checkOut: dateIn(53),
  });
  assert.strictEqual(created.status, 201);

  // While pending, the dates are held.
  let clash = await second('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(51),
    checkOut: dateIn(52),
  });
  assert.strictEqual(clash.status, 409);

  const declined = await owner('POST', `/api/owner/bookings/${created.data.booking.id}/decline`, {});
  assert.strictEqual(declined.status, 200);

  // Now they are free again.
  clash = await second('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(51),
    checkOut: dateIn(52),
  });
  assert.strictEqual(clash.status, 201);
});

test('a request can only be decided once', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const guest = await makeGuest('once-guest@example.com');
  const created = await guest('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(60),
    checkOut: dateIn(62),
  });

  const first = await owner('POST', `/api/owner/bookings/${created.data.booking.id}/approve`, {});
  assert.strictEqual(first.status, 200);
  const again = await owner('POST', `/api/owner/bookings/${created.data.booking.id}/approve`, {});
  assert.strictEqual(again.status, 409);
  const decline = await owner('POST', `/api/owner/bookings/${created.data.booking.id}/decline`, {});
  assert.strictEqual(decline.status, 409);
});

test('guests cannot approve their own bookings', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const guest = await makeGuest('selfapprove@example.com');
  const created = await guest('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(70),
    checkOut: dateIn(72),
  });
  const r = await guest('POST', `/api/owner/bookings/${created.data.booking.id}/approve`, {});
  assert.strictEqual(r.status, 403);
});

test('overlapping requests are refused and same-day changeover allowed', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const first = await makeGuest('overlap-a@example.com');
  const second = await makeGuest('overlap-b@example.com');

  let r = await first('POST', '/api/bookings', { roomId: id, checkIn: dateIn(120), checkOut: dateIn(125) });
  assert.strictEqual(r.status, 201);

  for (const [checkIn, checkOut] of [
    [dateIn(121), dateIn(123)],
    [dateIn(118), dateIn(122)],
    [dateIn(123), dateIn(128)],
    [dateIn(118), dateIn(130)],
  ]) {
    r = await second('POST', '/api/bookings', { roomId: id, checkIn, checkOut });
    assert.strictEqual(r.status, 409, `${checkIn}..${checkOut} should clash`);
  }

  r = await second('POST', '/api/bookings', { roomId: id, checkIn: dateIn(125), checkOut: dateIn(127) });
  assert.strictEqual(r.status, 201);
});

test('concurrent requests for the same nights cannot both succeed', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const guest = await makeGuest('race-guest@example.com');

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      guest('POST', '/api/bookings', { roomId: id, checkIn: dateIn(150), checkOut: dateIn(152) })
    )
  );
  assert.strictEqual(attempts.filter((r) => r.status === 201).length, 1);
  assert.strictEqual(attempts.filter((r) => r.status === 409).length, 4);
});

test('booking validation rejects bad ranges and over-capacity parties', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { maxGuests: 2 });
  const guest = await makeGuest('validate-guest@example.com');

  for (const body of [
    { roomId: id, checkIn: dateIn(-3), checkOut: dateIn(2) },
    { roomId: id, checkIn: dateIn(5), checkOut: dateIn(5) },
    { roomId: id, checkIn: dateIn(9), checkOut: dateIn(7) },
    { roomId: id, checkIn: '2026-02-31', checkOut: dateIn(9) },
    { roomId: id, checkIn: dateIn(400), checkOut: dateIn(402) },
    { roomId: id, checkIn: dateIn(5), checkOut: dateIn(90) },
    { roomId: id, checkIn: dateIn(5), checkOut: dateIn(7), guests: 5 },
    { roomId: id, checkIn: "2026-08-01' OR '1'='1", checkOut: dateIn(9) },
    { roomId: id, checkIn: dateIn(5), checkOut: dateIn(7), note: 'x'.repeat(501) },
  ]) {
    const r = await guest('POST', '/api/bookings', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
});

test('the owner cannot book through the guest route', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const r = await owner('POST', '/api/bookings', { roomId: id, checkIn: dateIn(90), checkOut: dateIn(92) });
  assert.strictEqual(r.status, 403);
});

test('IDOR: a guest cannot cancel or see another guest\'s booking', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner);
  const alice = await makeGuest('idor-alice@example.com');
  const mallory = await makeGuest('idor-mallory@example.com');

  const created = await alice('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(170),
    checkOut: dateIn(172),
  });
  assert.strictEqual(created.status, 201);

  const stolen = await mallory('DELETE', `/api/bookings/${created.data.booking.id}`);
  assert.strictEqual(stolen.status, 404);

  const mine = await mallory('GET', '/api/bookings');
  assert.strictEqual(mine.data.bookings.length, 0);

  const own = await alice('DELETE', `/api/bookings/${created.data.booking.id}`);
  assert.strictEqual(own.status, 200);
});

test('a notification is queued for every booking request', async () => {
  const owner = await ownerClient();
  const id = await makeRoom(owner, { name: 'Notify Room' });
  const guest = await makeGuest('notify-guest@example.com');
  const created = await guest('POST', '/api/bookings', {
    roomId: id,
    checkIn: dateIn(190),
    checkOut: dateIn(192),
  });

  const r = await owner('GET', '/api/owner/notifications');
  const forBooking = r.data.notifications.filter((n) => n.bookingId === created.data.booking.id);
  assert.ok(forBooking.some((n) => n.channel === 'inapp'), 'always recorded in the dashboard');
  assert.ok(forBooking.some((n) => n.channel === 'email'));
  assert.ok(forBooking.some((n) => n.channel === 'whatsapp'));
  // With no provider configured they are marked skipped, never silently lost.
  assert.ok(forBooking.every((n) => ['sent', 'skipped', 'queued', 'failed'].includes(n.status)));
});

// --- Injection, XSS, transport ---

test('SQL injection in ids and filters is handled safely', async () => {
  const anon = client();
  let r = await anon('GET', "/api/rooms/1' OR '1'='1");
  assert.strictEqual(r.status, 400);

  r = await anon('GET', '/api/rooms?guests=1;DROP TABLE rooms');
  assert.strictEqual(r.status, 400);

  const owner = await ownerClient();
  r = await owner('GET', "/api/owner/bookings?status=pending' OR '1'='1");
  assert.strictEqual(r.status, 400);

  // Everything still works.
  r = await anon('GET', '/api/rooms');
  assert.strictEqual(r.status, 200);
});

test('script payloads in room text are stored and returned as inert data', async () => {
  const owner = await ownerClient();
  const payload = '<script>alert("xss")</script>';
  const id = await makeRoom(owner, { name: payload, description: payload });

  const anon = client();
  const r = await anon('GET', `/api/rooms/${id}`);
  // Returned verbatim as a JSON string: the frontend renders it with
  // textContent and the CSP forbids inline script regardless.
  assert.strictEqual(r.data.room.name, payload);
});

test('cross-origin state-changing requests are rejected (CSRF)', async () => {
  const owner = await ownerClient();
  const r = await owner(
    'POST',
    '/api/owner/rooms',
    { name: 'Evil', pricePerNight: 1, maxGuests: 1 },
    { Origin: 'https://evil.example.com' }
  );
  assert.strictEqual(r.status, 403);
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'cookie-check@example.com',
      name: 'Cookie',
      password: 'cookie-password-1',
    }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).find((x) => x.includes('session='));
  assert.ok(cookie, 'session cookie set');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('security headers are present and the framework is not advertised', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.ok(res.headers.get('content-security-policy'));
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('malformed JSON returns a clean 400, not a stack trace', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error, 'Invalid request body');
});

test('unknown API routes return JSON 404s', async () => {
  const c = client();
  const r = await c('GET', '/api/nope');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.error, 'Not found');
});

test('the health check endpoint answers and is not rate limited', async () => {
  // Far more requests than the configured limiter would allow a normal route,
  // because the platform polls this constantly.
  const results = await Promise.all(
    Array.from({ length: 40 }, () => fetch(`${baseUrl}/healthz`))
  );
  assert.ok(results.every((r) => r.status === 200), 'every probe succeeds');
  const body = await results[0].json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(results[0].headers.get('ratelimit-limit'), null, 'not counted by the limiter');
});

test('the hero artwork is detected from disk, in candidate order', async () => {
  const fsp = require('fs');
  const pth = require('path');
  // hero.webp is first in the candidate list, so it wins whatever else the
  // repository happens to ship — the test does not assume an empty /public.
  const target = pth.join(__dirname, '..', 'public', 'hero.webp');
  const anon = client();

  const baseline = (await anon('GET', '/api/property')).data.heroImage;
  assert.ok(baseline === null || baseline.startsWith('/hero.'), 'reports a hero path or nothing');
  assert.ok(!fsp.existsSync(target), 'test file is not already present');

  fsp.writeFileSync(target, PNG_1X1);
  try {
    const during = await anon('GET', '/api/property');
    assert.strictEqual(during.data.heroImage, '/hero.webp', 'the first candidate takes precedence');
    const served = await fetch(`${baseUrl}/hero.webp`);
    assert.strictEqual(served.status, 200, 'and is actually served');
  } finally {
    fsp.rmSync(target, { force: true });
  }

  const after = (await anon('GET', '/api/property')).data.heroImage;
  assert.strictEqual(after, baseline, 'falls back to the previous state once removed');
});

'use strict';

// End-to-end API tests, including security regression tests: role separation,
// portal isolation, cross-owner IDOR, upload validation, SQL injection,
// CSRF origin checks, and double-booking under overlapping dates.
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolated throwaway database, with demo seeding off for deterministic counts.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-test-'));
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';
// Raise the throttles so this suite is not rate-limited against itself; the
// limiters themselves are verified in test/ratelimit.test.js.
process.env.AUTH_RATE_LIMIT = '5000';
process.env.GLOBAL_RATE_LIMIT = '10000';

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

async function makeOwner(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', {
    email,
    name: 'Owner',
    password: 'owner-password-1',
    role: 'owner',
  });
  assert.strictEqual(r.status, 201);
  return c;
}

async function makeGuest(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', {
    email,
    name: 'Guest',
    password: 'guest-password-1',
    role: 'guest',
  });
  assert.strictEqual(r.status, 201);
  return c;
}

async function makeProperty(owner, overrides = {}) {
  const r = await owner('POST', '/api/owner/properties', {
    title: 'Test Cottage',
    location: 'Testville',
    pricePerNight: 1000,
    maxGuests: 4,
    description: 'A place to test.',
    contactName: 'Test Owner',
    contactEmail: 'owner@example.com',
    contactPhone: '+91 90000 11111',
    ...overrides,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.property.id;
}

// --- Public browsing (guests must not need an account) ---

test('the landing API is public and needs no authentication', async () => {
  const c = client();
  const r = await c('GET', '/api/properties');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data.properties));
});

test('the landing page itself is served, not a login page', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Find a place to stay/);
});

test('anonymous visitors can view a property, its rooms and owner contact details', async () => {
  const owner = await makeOwner('view-owner@example.com');
  const id = await makeProperty(owner, { title: 'Viewable Villa' });
  await owner('POST', `/api/owner/properties/${id}/rooms`, { name: 'Suite', description: 'King bed' });

  const anon = client();
  const r = await anon('GET', `/api/properties/${id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.property.title, 'Viewable Villa');
  assert.strictEqual(r.data.property.contactPhone, '+91 90000 11111');
  assert.strictEqual(r.data.rooms.length, 1);
  assert.strictEqual(r.data.rooms[0].name, 'Suite');
});

test('unpublished properties are hidden from the public listing and detail view', async () => {
  const owner = await makeOwner('hidden-owner@example.com');
  const id = await makeProperty(owner, { title: 'Secret Shack' });
  await owner('PATCH', `/api/owner/properties/${id}`, { published: false });

  const anon = client();
  const list = await anon('GET', '/api/properties');
  assert.ok(!list.data.properties.some((p) => p.id === id));
  const detail = await anon('GET', `/api/properties/${id}`);
  assert.strictEqual(detail.status, 404);

  // The owner can still see it.
  const ownerView = await owner('GET', `/api/properties/${id}`);
  assert.strictEqual(ownerView.status, 200);
});

// --- Registration and portal separation ---

test('registration rejects a self-assigned admin role', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/register', {
    email: 'wannabe-admin@example.com',
    name: 'Sneaky',
    password: 'sneaky-password',
    role: 'admin',
  });
  assert.strictEqual(r.status, 400);
});

test('a guest account cannot sign in through the owner portal, and vice versa', async () => {
  await makeGuest('portal-guest@example.com');
  await makeOwner('portal-owner@example.com');

  const c = client();
  let r = await c('POST', '/api/auth/login', {
    email: 'portal-guest@example.com',
    password: 'guest-password-1',
    portal: 'owner',
  });
  assert.strictEqual(r.status, 401, 'guest rejected at the owner portal');

  r = await c('POST', '/api/auth/login', {
    email: 'portal-owner@example.com',
    password: 'owner-password-1',
    portal: 'guest',
  });
  assert.strictEqual(r.status, 401, 'owner rejected at the guest portal');

  // Each works at its own portal.
  r = await c('POST', '/api/auth/login', {
    email: 'portal-guest@example.com',
    password: 'guest-password-1',
    portal: 'guest',
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.role, 'guest');
});

test('wrong portal and wrong password are indistinguishable (no role probing)', async () => {
  const c = client();
  const wrongPortal = await c('POST', '/api/auth/login', {
    email: 'portal-guest@example.com',
    password: 'guest-password-1',
    portal: 'owner',
  });
  const wrongPassword = await c('POST', '/api/auth/login', {
    email: 'portal-guest@example.com',
    password: 'not-the-password',
    portal: 'owner',
  });
  const noSuchUser = await c('POST', '/api/auth/login', {
    email: 'ghost@example.com',
    password: 'not-the-password',
    portal: 'owner',
  });
  assert.strictEqual(wrongPortal.data.error, wrongPassword.data.error);
  assert.strictEqual(wrongPortal.data.error, noSuchUser.data.error);
});

// --- Owner management and access control ---

test('guests cannot reach owner endpoints', async () => {
  const guest = await makeGuest('nosy-guest@example.com');
  let r = await guest('GET', '/api/owner/properties');
  assert.strictEqual(r.status, 403);
  r = await guest('POST', '/api/owner/properties', {
    title: 'Guest listing',
    location: 'Nowhere',
    pricePerNight: 100,
    maxGuests: 1,
  });
  assert.strictEqual(r.status, 403);
});

test('owner endpoints reject anonymous callers', async () => {
  const anon = client();
  const r = await anon('GET', '/api/owner/properties');
  assert.strictEqual(r.status, 401);
});

test('an owner can create, update and unpublish their own property', async () => {
  const owner = await makeOwner('crud-owner@example.com');
  const id = await makeProperty(owner);

  let r = await owner('PATCH', `/api/owner/properties/${id}`, { title: 'Renamed Cottage', pricePerNight: 2500 });
  assert.strictEqual(r.status, 200);

  r = await owner('GET', '/api/owner/properties');
  const mine = r.data.properties.find((p) => p.id === id);
  assert.strictEqual(mine.title, 'Renamed Cottage');
  assert.strictEqual(mine.pricePerNight, 2500);
  assert.strictEqual(mine.published, true);
});

test('IDOR: an owner cannot read, modify or delete another owner\'s property', async () => {
  const alice = await makeOwner('alice-owner@example.com');
  const mallory = await makeOwner('mallory-owner@example.com');
  const aliceProperty = await makeProperty(alice, { title: 'Alice Place' });

  // Not listed in Mallory's dashboard.
  const list = await mallory('GET', '/api/owner/properties');
  assert.ok(!list.data.properties.some((p) => p.id === aliceProperty));

  // Every mutation path is refused with 404 (existence is not confirmed).
  let r = await mallory('PATCH', `/api/owner/properties/${aliceProperty}`, { pricePerNight: 1 });
  assert.strictEqual(r.status, 404);
  r = await mallory('DELETE', `/api/owner/properties/${aliceProperty}`);
  assert.strictEqual(r.status, 404);
  r = await mallory('POST', `/api/owner/properties/${aliceProperty}/rooms`, { name: 'Hijacked' });
  assert.strictEqual(r.status, 404);
  r = await mallory('POST', `/api/owner/properties/${aliceProperty}/images`, PNG_1X1, {
    'Content-Type': 'image/png',
  });
  assert.strictEqual(r.status, 404);

  // Alice's property is untouched.
  const check = await alice('GET', '/api/owner/properties');
  assert.strictEqual(check.data.properties.find((p) => p.id === aliceProperty).pricePerNight, 1000);
});

test('property field validation rejects bad prices, titles and guest counts', async () => {
  const owner = await makeOwner('validate-owner@example.com');
  for (const body of [
    { title: '', location: 'X', pricePerNight: 100, maxGuests: 2 },
    { title: 'X', location: '', pricePerNight: 100, maxGuests: 2 },
    { title: 'X', location: 'Y', pricePerNight: 0, maxGuests: 2 },
    { title: 'X', location: 'Y', pricePerNight: -5, maxGuests: 2 },
    { title: 'X', location: 'Y', pricePerNight: 1.5, maxGuests: 2 },
    { title: 'X', location: 'Y', pricePerNight: 100, maxGuests: 0 },
    { title: 'X', location: 'Y', pricePerNight: 100, maxGuests: 999 },
    { title: 'X'.repeat(121), location: 'Y', pricePerNight: 100, maxGuests: 2 },
  ]) {
    const r = await owner('POST', '/api/owner/properties', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
});

// --- Rooms and photos ---

test('an owner can add and remove rooms; another owner cannot remove them', async () => {
  const owner = await makeOwner('room-owner@example.com');
  const intruder = await makeOwner('room-intruder@example.com');
  const id = await makeProperty(owner);

  const created = await owner('POST', `/api/owner/properties/${id}/rooms`, {
    name: 'Attic',
    description: 'Two singles',
  });
  assert.strictEqual(created.status, 201);
  const roomId = created.data.room.id;

  const stolen = await intruder('DELETE', `/api/owner/rooms/${roomId}`);
  assert.strictEqual(stolen.status, 404);

  const removed = await owner('DELETE', `/api/owner/rooms/${roomId}`);
  assert.strictEqual(removed.status, 200);
});

test('photo upload accepts real images and serves them with the sniffed type', async () => {
  const owner = await makeOwner('photo-owner@example.com');
  const id = await makeProperty(owner);

  const upload = await owner('POST', `/api/owner/properties/${id}/images`, PNG_1X1, {
    'Content-Type': 'image/png',
  });
  assert.strictEqual(upload.status, 201);

  const res = await fetch(`${baseUrl}/api/images/${upload.data.image.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');

  // The photo appears on the public listing as the cover image.
  const anon = client();
  const detail = await anon('GET', `/api/properties/${id}`);
  assert.deepStrictEqual(detail.data.imageIds, [upload.data.image.id]);
});

test('uploads that are not real images are rejected, including disguised SVG and HTML', async () => {
  const owner = await makeOwner('badphoto-owner@example.com');
  const id = await makeProperty(owner);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');

  for (const payload of [svg, html, Buffer.from('not an image at all')]) {
    const r = await owner('POST', `/api/owner/properties/${id}/images`, payload, {
      'Content-Type': 'image/png', // lying about the type must not help
    });
    assert.strictEqual(r.status, 400, 'non-image rejected by magic-byte sniffing');
  }
});

test('oversized uploads are rejected', async () => {
  const owner = await makeOwner('bigphoto-owner@example.com');
  const id = await makeProperty(owner);
  const huge = Buffer.concat([PNG_1X1, Buffer.alloc(3 * 1024 * 1024)]);
  const r = await owner('POST', `/api/owner/properties/${id}/images`, huge, { 'Content-Type': 'image/png' });
  assert.strictEqual(r.status, 413);
});

// --- Booking ---

test('a guest can book, and the total is computed server-side', async () => {
  const owner = await makeOwner('book-owner@example.com');
  const id = await makeProperty(owner, { pricePerNight: 1500 });
  const guest = await makeGuest('booker@example.com');

  const r = await guest('POST', '/api/bookings', {
    propertyId: id,
    checkIn: dateIn(10),
    checkOut: dateIn(13),
    guests: 2,
    totalPrice: 1, // a client-supplied price must be ignored
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.booking.nights, 3);
  assert.strictEqual(r.data.booking.totalPrice, 4500);
});

test('overlapping stays are refused, and same-day changeover is allowed', async () => {
  const owner = await makeOwner('overlap-owner@example.com');
  const id = await makeProperty(owner);
  const first = await makeGuest('overlap-one@example.com');
  const second = await makeGuest('overlap-two@example.com');

  let r = await first('POST', '/api/bookings', { propertyId: id, checkIn: dateIn(20), checkOut: dateIn(25) });
  assert.strictEqual(r.status, 201);

  for (const [checkIn, checkOut] of [
    [dateIn(21), dateIn(23)], // fully inside
    [dateIn(18), dateIn(22)], // overlaps the start
    [dateIn(23), dateIn(28)], // overlaps the end
    [dateIn(18), dateIn(30)], // encloses it
  ]) {
    r = await second('POST', '/api/bookings', { propertyId: id, checkIn, checkOut });
    assert.strictEqual(r.status, 409, `${checkIn}..${checkOut} should clash`);
  }

  // Checking in the day the previous guest leaves is fine.
  r = await second('POST', '/api/bookings', { propertyId: id, checkIn: dateIn(25), checkOut: dateIn(27) });
  assert.strictEqual(r.status, 201);
});

test('concurrent requests for the same dates cannot both succeed', async () => {
  const owner = await makeOwner('race-owner@example.com');
  const id = await makeProperty(owner);
  const guest = await makeGuest('race-guest@example.com');

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      guest('POST', '/api/bookings', { propertyId: id, checkIn: dateIn(40), checkOut: dateIn(42) })
    )
  );
  assert.strictEqual(attempts.filter((r) => r.status === 201).length, 1);
  assert.strictEqual(attempts.filter((r) => r.status === 409).length, 4);
});

test('booking validation rejects bad date ranges and guest counts', async () => {
  const owner = await makeOwner('dates-owner@example.com');
  const id = await makeProperty(owner, { maxGuests: 4 });
  const guest = await makeGuest('dates-guest@example.com');

  for (const body of [
    { propertyId: id, checkIn: dateIn(-3), checkOut: dateIn(2) }, // starts in the past
    { propertyId: id, checkIn: dateIn(5), checkOut: dateIn(5) }, // zero nights
    { propertyId: id, checkIn: dateIn(9), checkOut: dateIn(7) }, // reversed
    { propertyId: id, checkIn: '2026-02-31', checkOut: dateIn(9) }, // not a real date
    { propertyId: id, checkIn: dateIn(400), checkOut: dateIn(402) }, // too far ahead
    { propertyId: id, checkIn: dateIn(5), checkOut: dateIn(90) }, // stay too long
    { propertyId: id, checkIn: dateIn(5), checkOut: dateIn(7), guests: 9 }, // over capacity
    { propertyId: id, checkIn: "2026-08-01' OR '1'='1", checkOut: dateIn(9) },
  ]) {
    const r = await guest('POST', '/api/bookings', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
});

test('owners cannot book through the guest booking route', async () => {
  const owner = await makeOwner('cantbook-owner@example.com');
  const id = await makeProperty(owner);
  const r = await owner('POST', '/api/bookings', {
    propertyId: id,
    checkIn: dateIn(50),
    checkOut: dateIn(52),
  });
  assert.strictEqual(r.status, 403);
});

test('IDOR: a guest cannot cancel another guest\'s booking', async () => {
  const owner = await makeOwner('cancel-owner@example.com');
  const id = await makeProperty(owner);
  const alice = await makeGuest('cancel-alice@example.com');
  const mallory = await makeGuest('cancel-mallory@example.com');

  const booked = await alice('POST', '/api/bookings', {
    propertyId: id,
    checkIn: dateIn(60),
    checkOut: dateIn(62),
  });
  assert.strictEqual(booked.status, 201);

  const stolen = await mallory('DELETE', `/api/bookings/${booked.data.booking.id}`);
  assert.strictEqual(stolen.status, 404);

  const own = await alice('DELETE', `/api/bookings/${booked.data.booking.id}`);
  assert.strictEqual(own.status, 200);
});

test('an owner sees bookings for their own properties only', async () => {
  const alice = await makeOwner('sees-alice@example.com');
  const bob = await makeOwner('sees-bob@example.com');
  const aliceProperty = await makeProperty(alice, { title: 'Alice Rental' });
  const guest = await makeGuest('sees-guest@example.com');

  await guest('POST', '/api/bookings', {
    propertyId: aliceProperty,
    checkIn: dateIn(70),
    checkOut: dateIn(72),
  });

  const aliceView = await alice('GET', '/api/owner/bookings');
  assert.ok(aliceView.data.bookings.some((b) => b.property === 'Alice Rental'));

  const bobView = await bob('GET', '/api/owner/bookings');
  assert.strictEqual(bobView.data.bookings.length, 0);
});

test('deleting a property with upcoming bookings is blocked', async () => {
  const owner = await makeOwner('protect-owner@example.com');
  const id = await makeProperty(owner);
  const guest = await makeGuest('protect-guest@example.com');
  await guest('POST', '/api/bookings', { propertyId: id, checkIn: dateIn(80), checkOut: dateIn(82) });

  const r = await owner('DELETE', `/api/owner/properties/${id}`);
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /upcoming booking/);
});

// --- Injection, XSS and transport security ---

test('SQL injection in search and ids is handled safely', async () => {
  const anon = client();
  let r = await anon('GET', "/api/properties?q=' OR '1'='1");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.properties.length, 0, 'injection matches nothing, it is a literal search term');

  r = await anon('GET', "/api/properties/1' OR '1'='1");
  assert.strictEqual(r.status, 400);

  r = await anon('GET', '/api/properties?maxPrice=1;DROP TABLE properties');
  assert.strictEqual(r.status, 400);

  // The table is still there.
  r = await anon('GET', '/api/properties');
  assert.strictEqual(r.status, 200);
});

test('LIKE wildcards in a search term are escaped, not honoured', async () => {
  const owner = await makeOwner('wildcard-owner@example.com');
  await makeProperty(owner, { title: 'Wildcard Lodge', location: 'Percentville' });
  const anon = client();
  const r = await anon('GET', '/api/properties?q=%25');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.properties.length, 0, 'a bare % must not match every listing');
});

test('script payloads in listing text are stored and returned as inert data', async () => {
  const owner = await makeOwner('xss-owner@example.com');
  const payload = '<script>alert("xss")</script>';
  const id = await makeProperty(owner, { title: payload, description: payload });

  const anon = client();
  const r = await anon('GET', `/api/properties/${id}`);
  // Returned verbatim as a JSON string: the frontend renders it with
  // textContent, and the CSP forbids inline script regardless.
  assert.strictEqual(r.data.property.title, payload);
});

test('cross-origin state-changing requests are rejected (CSRF)', async () => {
  const owner = await makeOwner('csrf-owner@example.com');
  const r = await owner(
    'POST',
    '/api/owner/properties',
    { title: 'Evil', location: 'Evil', pricePerNight: 1, maxGuests: 1 },
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
      role: 'guest',
    }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('session='));
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

'use strict';

// Google sign-in. Runs in its own file because the flow is configured by
// environment variables read at require time, and because it stubs Google's
// token endpoint — which must not leak into the rest of the suite.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-google-'));
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';
process.env.AUTH_RATE_LIMIT = '5000';
process.env.GLOBAL_RATE_LIMIT = '20000';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://127.0.0.1/api/auth/google/callback';

const app = require('../src/app');
const db = require('../src/db');

let server;
let baseUrl;

const OWNER_EMAIL = 'owner@colonelsparadisebir.com';

// Stands in for Google's token endpoint. Each test sets what the next exchange
// should return, so the flow can be driven without network access.
const realFetch = globalThis.fetch;
let nextIdToken = null;
let tokenExchangeCalls = [];

function idToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email_verified: true,
      ...claims,
    })
  ).toString('base64url');
  return `${header}.${payload}.signature-not-checked-on-this-path`;
}

before(async () => {
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      tokenExchangeCalls.push(new URLSearchParams(options.body).get('code_verifier'));
      if (nextIdToken === null) {
        return { ok: false, status: 400, text: async () => 'invalid_grant' };
      }
      return { ok: true, json: async () => ({ id_token: nextIdToken }) };
    }
    return realFetch(url, options);
  };

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')").run(
    OWNER_EMAIL,
    'Owner',
    bcrypt.hashSync('owner-Password-9876', 10)
  );
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// Drives the flow the way a browser would: follow the redirect to Google,
// keep the flow cookie, then call the callback with the state Google echoes.
async function signInWithGoogle({ sub, email, name = 'Guest Person', tamperState = false }) {
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  const setCookie = start.headers.getSetCookie().find((c) => c.startsWith('g_oauth='));
  assert.ok(setCookie, 'the flow cookie is set on the way out');
  const cookie = setCookie.split(';')[0];

  const location = new URL(start.headers.get('location'));
  const state = tamperState ? 'not-the-right-state' : location.searchParams.get('state');

  nextIdToken = email === null ? null : idToken({ sub, email, name });
  const callback = await fetch(
    `${baseUrl}/api/auth/google/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookie }, redirect: 'manual' }
  );
  return { start, location, callback };
}

function sessionCookieFrom(res) {
  return (res.headers.getSetCookie() ?? []).find((c) => c.startsWith('session='));
}

test('the redirect to Google carries PKCE and the configured client', async () => {
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  assert.strictEqual(start.status, 302);
  const url = new URL(start.headers.get('location'));

  assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.strictEqual(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'), 'a PKCE challenge is sent');
  assert.ok(url.searchParams.get('state'), 'a CSRF state is sent');
});

test('a new Google guest gets an account and a session', async () => {
  const { callback } = await signInWithGoogle({ sub: 'google-sub-1', email: 'aditya@example.com' });

  assert.strictEqual(callback.status, 302);
  assert.match(callback.headers.get('location'), /^\/auth-complete\.html/);
  assert.ok(sessionCookieFrom(callback), 'a session cookie is issued');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('aditya@example.com');
  assert.strictEqual(user.role, 'guest', 'Google sign-in can only ever create a guest');
  assert.strictEqual(user.google_sub, 'google-sub-1');
});

test('no password works on an account created through Google', async () => {
  await signInWithGoogle({ sub: 'google-sub-pw', email: 'nopassword@example.com' });

  // The stored hash is of a discarded random secret, so the obvious guesses —
  // and anything else — must fail.
  for (const guess of ['', 'password', 'google-sub-pw', 'nopassword@example.com']) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nopassword@example.com', password: guess, portal: 'guest' }),
    });
    assert.strictEqual(res.status, 401, `password "${guess}" must not sign in`);
  }
});

test('signing in twice reuses the same account', async () => {
  await signInWithGoogle({ sub: 'google-sub-2', email: 'repeat@example.com' });
  await signInWithGoogle({ sub: 'google-sub-2', email: 'repeat@example.com' });

  const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?').get('google-sub-2').n;
  assert.strictEqual(count, 1, 'the second sign-in must not create a duplicate');
});

test('a changed Google address follows the subject, not the email', async () => {
  await signInWithGoogle({ sub: 'google-sub-3', email: 'before@example.com' });
  await signInWithGoogle({ sub: 'google-sub-3', email: 'after@example.com' });

  const rows = db.prepare('SELECT email FROM users WHERE google_sub = ?').all('google-sub-3');
  assert.strictEqual(rows.length, 1, 'still one account after the address changed');
});

test('a password account is linked, and its password keeps working', async () => {
  const password = 'existing-guest-pw-1';
  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'linkme@example.com', name: 'Link Me', password }),
  });

  await signInWithGoogle({ sub: 'google-sub-4', email: 'linkme@example.com' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('linkme@example.com');
  assert.strictEqual(user.google_sub, 'google-sub-4', 'the existing account was linked, not duplicated');

  // Linking adds a way in; it must not take one away.
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'linkme@example.com', password, portal: 'guest' }),
  });
  assert.strictEqual(res.status, 200, 'the original password still signs in');
});

// The one that matters most: the dashboard is password + 2FA, and Google must
// never be a way around that.
test('the owner account cannot be reached through Google', async () => {
  const { callback } = await signInWithGoogle({ sub: 'google-sub-owner', email: OWNER_EMAIL });

  assert.strictEqual(callback.status, 302);
  assert.match(callback.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(sessionCookieFrom(callback), undefined, 'no session is issued');

  const owner = db.prepare('SELECT * FROM users WHERE email = ?').get(OWNER_EMAIL);
  assert.strictEqual(owner.role, 'owner', 'the role is untouched');
  assert.strictEqual(owner.google_sub, null, 'the owner account is never linked to a Google identity');
});

test('an unverified Google address is refused', async () => {
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith('g_oauth=')).split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  nextIdToken = idToken({ sub: 'google-sub-5', email: 'unverified@example.com', email_verified: false });
  const callback = await fetch(
    `${baseUrl}/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookie }, redirect: 'manual' }
  );

  assert.match(callback.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('unverified@example.com').n,
    0,
    'an unverified address must not create or claim an account'
  );
});

test('a token minted for another application is refused', async () => {
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith('g_oauth=')).split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  nextIdToken = idToken({ sub: 'google-sub-6', email: 'otherapp@example.com', aud: 'someone-elses-client-id' });
  const callback = await fetch(
    `${baseUrl}/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookie }, redirect: 'manual' }
  );

  assert.match(callback.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('otherapp@example.com').n,
    0
  );
});

test('a mismatched state is rejected', async () => {
  const { callback } = await signInWithGoogle({
    sub: 'google-sub-7',
    email: 'csrf@example.com',
    tamperState: true,
  });

  assert.match(callback.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(sessionCookieFrom(callback), undefined);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('csrf@example.com').n,
    0
  );
});

test('a callback with no flow cookie is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/auth/google/callback?code=c&state=anything`, {
    redirect: 'manual',
  });
  assert.match(res.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(sessionCookieFrom(res), undefined);
});

test('the callback cannot be replayed', async () => {
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith('g_oauth=')).split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  nextIdToken = idToken({ sub: 'google-sub-8', email: 'replay@example.com' });
  const first = await fetch(`${baseUrl}/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.match(first.headers.get('location'), /^\/auth-complete\.html/);

  // Google will not honour a second exchange of the same code; the stub says so.
  nextIdToken = null;
  const second = await fetch(`${baseUrl}/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.match(second.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(sessionCookieFrom(second), undefined);
});

test('the PKCE verifier sent to Google matches the challenge advertised', async () => {
  tokenExchangeCalls = [];
  const { location } = await signInWithGoogle({ sub: 'google-sub-9', email: 'pkce@example.com' });

  const verifier = tokenExchangeCalls.at(-1);
  assert.ok(verifier, 'a verifier reached the token endpoint');
  const derived = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(derived, location.searchParams.get('code_challenge'));
});

test('a cancelled consent screen returns to the login page', async () => {
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith('g_oauth=')).split(';')[0];

  const res = await fetch(`${baseUrl}/api/auth/google/callback?error=access_denied`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.match(res.headers.get('location'), /^\/login\.html\?error=/);
  assert.strictEqual(sessionCookieFrom(res), undefined);
});

test('the sign-in page is told Google is available', async () => {
  const res = await fetch(`${baseUrl}/api/auth/providers`);
  assert.deepStrictEqual(await res.json(), { google: true });
});

'use strict';

// Verifies the custom-domain redirect. This lives in its own file because
// node:test gives each file a fresh process, so CANONICAL_HOST can be set here
// without redirecting every request in the main suite.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-canonical-'));
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = '0';
process.env.CANONICAL_HOST = 'colonelsparadisebir.com';

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

// `fetch` follows redirects and rewrites the Host header, so these use manual
// mode and set Host explicitly to simulate arriving on a different name.
function request(pathname, host, method = 'GET') {
  return fetch(`${baseUrl}${pathname}`, { method, headers: { host }, redirect: 'manual' });
}

test('an alias hostname is redirected to the canonical one', async () => {
  const res = await request('/room.html?id=3', 'www.colonelsparadisebir.com');
  assert.strictEqual(res.status, 308);
  assert.strictEqual(
    res.headers.get('location'),
    'https://colonelsparadisebir.com/room.html?id=3',
    'the path and query survive the redirect'
  );
});

test('the old onrender.com URL still reaches the site', async () => {
  const res = await request('/', 'booking-system.onrender.com');
  assert.strictEqual(res.status, 308);
  assert.strictEqual(res.headers.get('location'), 'https://colonelsparadisebir.com/');
});

test('a POST keeps its method so the request can be replayed', async () => {
  const res = await request('/api/auth/login', 'www.colonelsparadisebir.com', 'POST');
  // 308 (not 301) is what tells the browser to re-send the POST as a POST.
  assert.strictEqual(res.status, 308);
});

test('requests already on the canonical host are served normally', async () => {
  const res = await request('/healthz', 'colonelsparadisebir.com');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'ok' });
});

test('a host with a port still matches the canonical name', async () => {
  const res = await request('/healthz', 'colonelsparadisebir.com:443');
  assert.strictEqual(res.status, 200, 'the port is ignored when comparing hosts');
});

test('health checks are never redirected', async () => {
  // Render probes the service on its internal hostname; a redirect there would
  // fail the deploy gate.
  const res = await request('/healthz', 'booking-system.onrender.com');
  assert.strictEqual(res.status, 200);
});

'use strict';

// Google sign-in for guests, as a server-side authorization-code flow.
//
// Deliberately not Google's JavaScript SDK: the site runs a strict CSP with
// `script-src 'self'` and no inline scripts, and the SDK would mean punching a
// third-party origin through it on every page. A redirect flow needs no
// client-side JavaScript from anyone, so the CSP stays exactly as it is.

const crypto = require('crypto');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Google has issued tokens under both spellings for years.
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// Small allowance for clock skew between this host and Google.
const CLOCK_SKEW_SEC = 60;

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Where Google sends the browser back to. Google matches this against the list
 * registered in the console and rejects anything else, so a forged Host header
 * cannot redirect the code somewhere else — but an explicit value is still
 * preferred, since deriving it from the request makes the failure a confusing
 * error from Google rather than a clear one from here.
 */
function redirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = process.env.CANONICAL_HOST || req.headers.host;
  const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return `${scheme}://${host}/api/auth/google/callback`;
}

// PKCE. Not strictly required for a confidential client that holds a secret,
// but it costs one hash and removes the whole class of attacks where a stolen
// authorization code is redeemed by someone else.
function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizationUrl({ req, state, challenge }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Ask for an account choice every time rather than silently reusing
    // whichever Google session the browser happens to hold.
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCode({ req, code, verifier }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const body = await res.json();
  if (!body.id_token) throw new Error('Google returned no id_token');
  return body.id_token;
}

/**
 * Read and check the ID token.
 *
 * The signature is not verified locally, and that is a deliberate, bounded
 * choice: this token did not come through the browser. It arrived in the body
 * of our own TLS request to Google's token endpoint, authenticated with the
 * client secret, which is the case Google documents as not requiring local
 * verification. Verifying it would mean fetching, caching and rotating JWKS —
 * more moving parts, and a new failure mode, for no additional guarantee on
 * this path.
 *
 * The claims are still checked, because a trusted channel proves who sent the
 * token, not that the token says what this application requires.
 */
function readIdToken(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Unreadable id_token payload');
  }

  if (!ISSUERS.has(claims.iss)) {
    throw new Error(`Unexpected issuer: ${claims.iss}`);
  }
  // Without this a token minted for a different application would be accepted.
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error('id_token was not issued for this application');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < now) {
    throw new Error('id_token has expired');
  }
  if (!claims.sub) {
    throw new Error('id_token carries no subject');
  }
  if (!claims.email) {
    throw new Error('Google did not return an email address');
  }
  // An unverified address is just a string the user typed. Accepting it would
  // let someone claim an address they do not control and, through the
  // email-matching link below, walk into an existing account.
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error('That Google account has an unverified email address');
  }

  return {
    sub: String(claims.sub),
    email: String(claims.email),
    name: typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name.trim() : '',
  };
}

module.exports = {
  isConfigured,
  redirectUri,
  createPkce,
  authorizationUrl,
  exchangeCode,
  readIdToken,
};

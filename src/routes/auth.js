'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const totp = require('../totp');
const auth = require('../auth');
const googleOAuth = require('../google-oauth');
const v = require('../validators');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
// Pre-computed hash compared against when the account does not exist, so the
// login endpoint takes the same time either way (no user-enumeration timing oracle).
const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', BCRYPT_ROUNDS);

// Which roles may sign in through each portal. Guests can never reach the
// owner portal, and the owner account can never sign in as a guest.
const PORTAL_ROLES = {
  guest: ['guest'],
  owner: ['owner', 'admin'],
};

const AUTH_LIMIT = Number(process.env.AUTH_RATE_LIMIT) || 20;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTH_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// The owner portal is throttled harder still: there is exactly one owner
// account, so legitimate traffic here is a handful of requests a day.
const ownerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.OWNER_RATE_LIMIT) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    totpEnabled: Boolean(user.totp_enabled ?? user.totpEnabled),
  };
}

// Registration creates guests only. There is one owner and it is provisioned
// by `npm run create-owner`, so no network path can ever mint one.
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, name, password, phone } = req.body ?? {};
    if (!v.isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!v.isValidName(name)) {
      return res.status(400).json({ error: 'Name is required (max 100 characters)' });
    }
    if (!v.isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be 8-72 characters' });
    }
    if (phone !== undefined && phone !== '' && !v.isValidPhone(phone)) {
      return res.status(400).json({ error: 'Phone number is not valid' });
    }

    const normalized = v.normalizeEmail(email);
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let result;
    try {
      result = db
        .prepare("INSERT INTO users (email, name, phone, password_hash, role) VALUES (?, ?, ?, ?, 'guest')")
        .run(normalized, name.trim(), (phone ?? '').trim(), hash);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      throw err;
    }

    const user = { id: result.lastInsertRowid, email: normalized, name: name.trim(), role: 'guest' };
    auth.createSession(req, res, user);
    auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'register' });
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password, portal, totpCode, recoveryCode } = req.body ?? {};
    if (!Object.prototype.hasOwnProperty.call(PORTAL_ROLES, portal)) {
      return res.status(400).json({ error: 'Unknown sign-in portal' });
    }
    // The owner portal gets the stricter limiter as well as the shared one.
    if (portal === 'owner') {
      await new Promise((resolve, reject) => {
        ownerLoginLimiter(req, res, (err) => (err ? reject(err) : resolve()));
      });
      if (res.headersSent) return undefined;
    }

    if (!v.isValidEmail(email) || typeof password !== 'string' || password.length > 1024) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const normalized = v.normalizeEmail(email);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);

    // A locked account is refused before the password is even considered.
    if (user) {
      const remaining = auth.lockRemainingMs(user);
      if (remaining > 0) {
        auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'locked' });
        return res.status(429).json({
          error: `Too many failed attempts. Try again in ${Math.ceil(remaining / 60000)} minute(s).`,
        });
      }
    }

    // Always run a comparison so a wrong password and a missing account are
    // indistinguishable in both timing and response.
    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !passwordOk) {
      if (user) auth.recordFailedAttempt(user);
      auth.recordLoginAttempt(req, {
        userId: user ? user.id : null,
        email: normalized,
        outcome: user ? 'bad_password' : 'unknown_user',
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Using the wrong portal is reported exactly like bad credentials, so the
    // portals cannot be used to discover which address is the owner's.
    if (!PORTAL_ROLES[portal].includes(user.role)) {
      auth.recordFailedAttempt(user);
      auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'wrong_portal' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Second factor, when the account has it switched on.
    if (user.totp_enabled) {
      const suppliedTotp = typeof totpCode === 'string' ? totpCode.trim() : '';
      const suppliedRecovery = typeof recoveryCode === 'string' ? recoveryCode.trim().toUpperCase() : '';

      if (suppliedTotp === '' && suppliedRecovery === '') {
        // Not a failed attempt: the password was right, we just need step two.
        return res.status(401).json({
          error: 'Enter the 6-digit code from your authenticator app',
          totpRequired: true,
        });
      }

      let accepted = false;
      if (suppliedRecovery !== '') {
        accepted = consumeRecoveryCode(user.id, suppliedRecovery);
      } else {
        const step = totp.verify(user.totp_secret, suppliedTotp, { minStep: user.totp_last_step });
        if (step !== null) {
          // Recording the step blocks replay of the same code inside its window.
          db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
          accepted = true;
        }
      }

      if (!accepted) {
        auth.recordFailedAttempt(user);
        auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'bad_totp' });
        return res.status(401).json({
          error: 'That code is not valid or has already been used',
          totpRequired: true,
        });
      }
    }

    auth.clearFailedAttempts(user.id);
    auth.createSession(req, res, user);
    auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'success' });
    return res.json({ user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

// --- Google sign-in (guests only) ---

// Holds the CSRF state and the PKCE verifier between the redirect out to Google
// and the callback back. SameSite must be Lax, not Strict: the callback is a
// top-level navigation from accounts.google.com, and a Strict cookie is not
// sent on a cross-site navigation — the flow would fail every time. Lax is the
// weakest setting that works here and still blocks cross-site POSTs.
const GOOGLE_FLOW_COOKIE = 'g_oauth';
const GOOGLE_FLOW_MS = 10 * 60 * 1000;

function googleFlowCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: GOOGLE_FLOW_MS,
    path: '/api/auth',
  };
}

// Only same-origin paths survive, so a crafted ?next= cannot bounce a
// freshly signed-in guest to someone else's site.
function safeNext(value, fallback = '/bookings.html') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : fallback;
}

function backToLogin(res, reason) {
  return res.redirect(`/login.html?error=${encodeURIComponent(reason)}`);
}

// Lets the sign-in page show the Google button only when Google is actually
// wired up, rather than offering a button that dead-ends in a 404.
router.get('/providers', (req, res) => {
  res.json({ google: googleOAuth.isConfigured() });
});

router.get('/google', authLimiter, (req, res) => {
  if (!googleOAuth.isConfigured()) {
    return res.status(404).json({ error: 'Google sign-in is not enabled' });
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const { verifier, challenge } = googleOAuth.createPkce();

  res.cookie(
    GOOGLE_FLOW_COOKIE,
    Buffer.from(JSON.stringify({ state, verifier, next: safeNext(req.query.next) })).toString('base64url'),
    googleFlowCookieOptions()
  );
  return res.redirect(googleOAuth.authorizationUrl({ req, state, challenge }));
});

router.get('/google/callback', authLimiter, async (req, res, next) => {
  if (!googleOAuth.isConfigured()) {
    return res.status(404).json({ error: 'Google sign-in is not enabled' });
  }

  // Single-use: cleared before anything can fail, so a replayed callback has no
  // state to match against.
  const raw = req.cookies[GOOGLE_FLOW_COOKIE];
  res.clearCookie(GOOGLE_FLOW_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/api/auth' });

  try {
    // The guest pressed Cancel on Google's consent screen.
    if (req.query.error) {
      return backToLogin(res, 'Google sign-in was cancelled');
    }

    let flow;
    try {
      flow = JSON.parse(Buffer.from(String(raw ?? ''), 'base64url').toString('utf8'));
    } catch {
      flow = null;
    }
    if (!flow || typeof flow.state !== 'string' || typeof flow.verifier !== 'string') {
      return backToLogin(res, 'Your sign-in took too long — please try again');
    }
    // Constant-time, and length-checked first because timingSafeEqual throws on
    // a length mismatch.
    const supplied = Buffer.from(String(req.query.state ?? ''));
    const expected = Buffer.from(flow.state);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      auth.recordLoginAttempt(req, { email: '', outcome: 'google_bad_state' });
      return backToLogin(res, 'Sign-in could not be verified — please try again');
    }
    if (typeof req.query.code !== 'string' || req.query.code === '') {
      return backToLogin(res, 'Google sign-in did not complete');
    }

    let profile;
    try {
      const idToken = await googleOAuth.exchangeCode({ req, code: req.query.code, verifier: flow.verifier });
      profile = googleOAuth.readIdToken(idToken);
    } catch (err) {
      console.error('Google sign-in failed:', err.message);
      auth.recordLoginAttempt(req, { email: '', outcome: 'google_rejected' });
      return backToLogin(res, 'Google sign-in failed — please try again or use a password');
    }

    const normalized = v.normalizeEmail(profile.email);
    // Matched on the Google subject first: it survives the guest changing the
    // address on their Google account, which the email never would.
    let user =
      db.prepare('SELECT * FROM users WHERE google_sub = ?').get(profile.sub) ??
      db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);

    if (user) {
      // The owner account is reachable only by password plus its second factor.
      // Without this, anyone who controls that Google address would inherit the
      // dashboard — no password, no 2FA, nothing to brute-force. Reported the
      // same way as any other refusal so the response cannot be used to
      // discover which address is the owner's.
      if (user.role !== 'guest') {
        auth.recordLoginAttempt(req, {
          userId: user.id,
          email: normalized,
          outcome: 'google_wrong_portal',
        });
        return backToLogin(res, 'That account cannot use Google sign-in');
      }

      const remaining = auth.lockRemainingMs(user);
      if (remaining > 0) {
        auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'locked' });
        return backToLogin(res, `Too many failed attempts. Try again in ${Math.ceil(remaining / 60000)} minute(s).`);
      }

      // First Google sign-in for an account that registered with a password.
      // Safe only because the address is verified above; the password keeps
      // working, so this adds a way in rather than replacing one.
      if (!user.google_sub) {
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(profile.sub, user.id);
      }
    } else {
      // No password is ever usable on an account created this way: the stored
      // hash is of a random secret that is discarded immediately.
      const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), BCRYPT_ROUNDS);
      const name = profile.name !== '' ? profile.name.slice(0, 100) : normalized.split('@')[0].slice(0, 100);
      const result = db
        .prepare(
          "INSERT INTO users (email, name, phone, password_hash, role, google_sub) VALUES (?, ?, '', ?, 'guest', ?)"
        )
        .run(normalized, name, unusable, profile.sub);
      user = { id: result.lastInsertRowid, email: normalized, name, role: 'guest' };
      auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'google_register' });
    }

    auth.clearFailedAttempts(user.id);
    auth.createSession(req, res, user);
    auth.recordLoginAttempt(req, { userId: user.id, email: normalized, outcome: 'google_success' });

    // Via a static page rather than straight to the destination. The session
    // cookie is SameSite=Strict, and this response is the tail of a cross-site
    // navigation from Google; browsers may withhold a Strict cookie on the very
    // next hop, landing the guest on a page that thinks they are signed out.
    // A same-origin page navigating onward is unambiguously same-site.
    return res.redirect(`/auth-complete.html?next=${encodeURIComponent(safeNext(flow.next))}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', auth.requireAuth, (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', auth.requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024) {
      return res.status(400).json({ error: 'Current password is required' });
    }

    // The owner is held to the stronger policy.
    if (auth.isPrivileged(req.user.role)) {
      const strength = v.isStrongOwnerPassword(newPassword);
      if (!strength.ok) return res.status(400).json({ error: strength.error });
    } else if (!v.isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be 8-72 characters' });
    }

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) {
      auth.recordLoginAttempt(req, {
        userId: req.user.id,
        email: req.user.email,
        outcome: 'bad_password_change',
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

    // A password change revokes every session, then issues one fresh session.
    auth.destroyAllSessions(req.user.id);
    auth.createSession(req, res, req.user);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Two-factor authentication (owner) ---

function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < 8; i += 1) {
    const raw = crypto.randomBytes(9).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const padded = (raw + crypto.randomBytes(9).toString('hex').toUpperCase()).slice(0, 12);
    codes.push(`${padded.slice(0, 4)}-${padded.slice(4, 8)}-${padded.slice(8, 12)}`);
  }
  return codes;
}

function storeRecoveryCodes(userId, codes) {
  const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    for (const code of codes) {
      insert.run(userId, bcrypt.hashSync(code, 10));
    }
  });
  replace();
}

// Recovery codes are single use: the row is marked the moment one is accepted.
function consumeRecoveryCode(userId, supplied) {
  if (!v.isValidRecoveryCode(supplied)) return false;
  const rows = db
    .prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .all(userId);
  for (const row of rows) {
    if (bcrypt.compareSync(supplied, row.code_hash)) {
      db.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
      return true;
    }
  }
  return false;
}

// Step one: hand back a secret and its QR-ready URI. Nothing is switched on
// until the owner proves they can generate a code from it.
router.post('/2fa/setup', auth.requireOwner, (req, res) => {
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  res.json({
    secret,
    uri: totp.provisioningUri(secret, { issuer: 'Staylist', account: req.user.email }),
  });
});

// Step two: confirm a code, enable two-factor, and issue recovery codes. They
// are shown exactly once — only their hashes are stored.
router.post('/2fa/enable', auth.requireOwner, authLimiter, (req, res) => {
  const { code } = req.body ?? {};
  const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!row.totp_secret) {
    return res.status(400).json({ error: 'Start the setup step first' });
  }
  if (row.totp_enabled) {
    return res.status(409).json({ error: 'Two-factor authentication is already on' });
  }
  if (!v.isValidTotpCode(code)) {
    return res.status(400).json({ error: 'Enter the 6-digit code from your authenticator app' });
  }
  const step = totp.verify(row.totp_secret, code);
  if (step === null) {
    return res.status(400).json({ error: 'That code is not valid — check your app and try again' });
  }

  const codes = generateRecoveryCodes();
  storeRecoveryCodes(req.user.id, codes);
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, req.user.id);

  // Turning two-factor on invalidates other sessions, in case one was stolen.
  auth.destroyOtherSessions(req.user.id, req.sessionToken);
  res.json({ ok: true, recoveryCodes: codes });
});

// Disabling requires the current password: a stolen session alone must not be
// enough to strip the second factor off the account.
router.post('/2fa/disable', auth.requireOwner, authLimiter, async (req, res, next) => {
  try {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Your password is required to turn two-factor off' });
    }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?')
      .run(req.user.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/recovery-codes', auth.requireOwner, authLimiter, async (req, res, next) => {
  try {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Your password is required' });
    }
    const row = db.prepare('SELECT password_hash, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!row.totp_enabled) {
      return res.status(400).json({ error: 'Two-factor authentication is not on' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Password is incorrect' });

    const codes = generateRecoveryCodes();
    storeRecoveryCodes(req.user.id, codes);
    res.json({ ok: true, recoveryCodes: codes });
  } catch (err) {
    next(err);
  }
});

// --- Session visibility and revocation (owner) ---

router.get('/security', auth.requireOwner, (req, res) => {
  const row = db
    .prepare('SELECT totp_enabled, last_login_at, failed_attempts FROM users WHERE id = ?')
    .get(req.user.id);
  const unusedCodes = db
    .prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(req.user.id).n;
  res.json({
    twoFactorEnabled: Boolean(row.totp_enabled),
    lastLoginAt: row.last_login_at,
    failedAttempts: row.failed_attempts,
    unusedRecoveryCodes: unusedCodes,
    sessions: auth.listSessions(req.user.id, req.sessionToken),
    recentAttempts: auth.recentLoginAttempts(req.user.id),
  });
});

router.delete('/sessions/:id', auth.requireOwner, (req, res) => {
  const removed = auth.revokeSessionById(req.user.id, req.params.id);
  if (removed === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ ok: true });
});

router.post('/sessions/revoke-others', auth.requireOwner, (req, res) => {
  auth.destroyOtherSessions(req.user.id, req.sessionToken);
  res.json({ ok: true });
});

module.exports = router;

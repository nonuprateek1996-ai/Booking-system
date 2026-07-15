'use strict';

const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'session';

// Session tokens are stored only as SHA-256 hashes so that a leaked database
// does not allow session hijacking.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expiresAt);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function destroySession(req, res) {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
}

// Invalidate every session for a user (e.g. after a password change).
function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Populates req.user when a valid, unexpired session cookie is present.
function sessionLoader(req, res, next) {
  req.user = null;
  const token = req.cookies[COOKIE_NAME];
  if (typeof token === 'string' && token.length > 0 && token.length <= 128) {
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`
      )
      .get(hashToken(token));
    if (row) {
      if (row.expires_at > Date.now()) {
        req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
      } else {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      }
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// CSRF defence in depth: the session cookie is SameSite=Strict, and every
// state-changing request must additionally arrive from our own origin.
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
    if (originHost !== req.headers.host) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
  }
  next();
}

// Opportunistically purge expired sessions.
function pruneExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

module.exports = {
  COOKIE_NAME,
  createSession,
  destroySession,
  destroyAllSessions,
  sessionLoader,
  requireAuth,
  requireAdmin,
  csrfProtection,
  pruneExpiredSessions,
};

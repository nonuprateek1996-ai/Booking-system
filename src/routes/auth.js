'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { createSession, destroySession, destroyAllSessions, requireAuth } = require('../auth');
const v = require('../validators');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
// Pre-computed hash compared against when the account does not exist, so the
// login endpoint takes the same time either way (no user-enumeration timing oracle).
const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', BCRYPT_ROUNDS);

// Tight limits on credential endpoints to blunt brute-force and stuffing attacks.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, name, password } = req.body ?? {};
    if (!v.isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!v.isValidName(name)) {
      return res.status(400).json({ error: 'Name is required (max 100 characters)' });
    }
    if (!v.isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be 8-72 characters' });
    }

    const normalized = v.normalizeEmail(email);
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let result;
    try {
      result = db
        .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
        .run(normalized, name.trim(), hash);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      throw err;
    }

    createSession(res, result.lastInsertRowid);
    res.status(201).json({ user: { id: result.lastInsertRowid, email: normalized, name: name.trim(), role: 'user' } });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!v.isValidEmail(email) || typeof password !== 'string' || password.length > 1024) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const user = db
      .prepare('SELECT id, email, name, role, password_hash FROM users WHERE email = ?')
      .get(v.normalizeEmail(email));

    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    createSession(res, user.id);
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    if (!v.isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be 8-72 characters' });
    }

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

    // Changing the password revokes every existing session, then issues a fresh one.
    destroyAllSessions(req.user.id);
    createSession(res, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

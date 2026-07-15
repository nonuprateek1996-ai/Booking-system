'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const v = require('../validators');

const router = express.Router();

// List active resources (public).
router.get('/resources', (req, res) => {
  const resources = db
    .prepare('SELECT id, name, description FROM resources WHERE active = 1 ORDER BY name')
    .all();
  res.json({ resources });
});

// Availability for one resource on one date (public).
router.get('/resources/:id/availability', (req, res) => {
  if (!v.isValidId(req.params.id) || !v.isValidBookingDate(String(req.query.date ?? ''))) {
    return res.status(400).json({ error: 'A valid resource id and date (YYYY-MM-DD) are required' });
  }
  const resource = db
    .prepare('SELECT id FROM resources WHERE id = ? AND active = 1')
    .get(Number(req.params.id));
  if (!resource) {
    return res.status(404).json({ error: 'Resource not found' });
  }
  const taken = new Set(
    db
      .prepare('SELECT slot FROM bookings WHERE resource_id = ? AND date = ?')
      .all(resource.id, req.query.date)
      .map((r) => r.slot)
  );
  res.json({
    date: req.query.date,
    slots: v.SLOTS.map((slot) => ({ slot, available: !taken.has(slot) })),
  });
});

// Create a booking for the signed-in user.
router.post('/bookings', requireAuth, (req, res) => {
  const { resourceId, date, slot } = req.body ?? {};
  if (!v.isValidId(resourceId)) {
    return res.status(400).json({ error: 'A valid resource is required' });
  }
  if (!v.isValidBookingDate(date)) {
    return res.status(400).json({ error: `Date must be YYYY-MM-DD, today or later, within ${v.MAX_ADVANCE_DAYS} days` });
  }
  if (!v.isValidSlot(slot)) {
    return res.status(400).json({ error: 'Invalid time slot' });
  }

  const resource = db
    .prepare('SELECT id, name FROM resources WHERE id = ? AND active = 1')
    .get(Number(resourceId));
  if (!resource) {
    return res.status(404).json({ error: 'Resource not found' });
  }

  // The UNIQUE(resource_id, date, slot) constraint makes double-booking
  // impossible even under concurrent requests.
  let result;
  try {
    result = db
      .prepare('INSERT INTO bookings (user_id, resource_id, date, slot) VALUES (?, ?, ?, ?)')
      .run(req.user.id, resource.id, date, slot);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That slot has already been booked' });
    }
    throw err;
  }

  res.status(201).json({
    booking: { id: result.lastInsertRowid, resource: resource.name, resourceId: resource.id, date, slot },
  });
});

// The signed-in user's own bookings only.
router.get('/bookings', requireAuth, (req, res) => {
  const bookings = db
    .prepare(
      `SELECT b.id, b.date, b.slot, b.created_at, r.name AS resource, r.id AS resourceId
         FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE b.user_id = ?
        ORDER BY b.date, b.slot`
    )
    .all(req.user.id);
  res.json({ bookings });
});

// Cancel a booking. Ownership is enforced in the WHERE clause so a user can
// never cancel (or even probe the existence of) someone else's booking.
router.delete('/bookings/:id', requireAuth, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const result =
    req.user.role === 'admin'
      ? db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id))
      : db.prepare('DELETE FROM bookings WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json({ ok: true });
});

// --- Admin endpoints ---

router.get('/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db
    .prepare(
      `SELECT b.id, b.date, b.slot, b.created_at,
              r.name AS resource, u.email AS userEmail, u.name AS userName
         FROM bookings b
         JOIN resources r ON r.id = b.resource_id
         JOIN users u     ON u.id = b.user_id
        ORDER BY b.date, b.slot
        LIMIT 500`
    )
    .all();
  res.json({ bookings });
});

router.post('/admin/resources', requireAdmin, (req, res) => {
  const { name, description } = req.body ?? {};
  if (!v.isValidResourceName(name)) {
    return res.status(400).json({ error: 'Resource name is required (max 120 characters)' });
  }
  if (description !== undefined && !v.isValidDescription(description)) {
    return res.status(400).json({ error: 'Description too long (max 500 characters)' });
  }
  let result;
  try {
    result = db
      .prepare('INSERT INTO resources (name, description) VALUES (?, ?)')
      .run(name.trim(), (description ?? '').trim());
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A resource with this name already exists' });
    }
    throw err;
  }
  res.status(201).json({ resource: { id: result.lastInsertRowid, name: name.trim() } });
});

router.delete('/admin/resources/:id', requireAdmin, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid resource id' });
  }
  // Soft-delete keeps historical bookings intact.
  const result = db.prepare('UPDATE resources SET active = 0 WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Resource not found' });
  }
  res.json({ ok: true });
});

module.exports = router;

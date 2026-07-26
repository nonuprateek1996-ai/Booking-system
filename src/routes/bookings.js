'use strict';

const express = require('express');
const db = require('../db');
const { requireGuest, requireOwner } = require('../auth');
const notify = require('../notify');
const v = require('../validators');

const router = express.Router();

// A pending request holds its dates just like an approved one, so the owner is
// never asked to approve two guests for the same room and nights.
const HOLDING_STATUSES = "('pending', 'approved')";

// Reserve atomically: the availability check and the insert run in a single
// immediate transaction, so two simultaneous requests cannot both succeed.
const reserve = db.transaction((request) => {
  const clash = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings
        WHERE room_id = ? AND status IN ${HOLDING_STATUSES}
          AND check_in < ? AND check_out > ?`
    )
    .get(request.roomId, request.checkOut, request.checkIn).n;
  if (clash > 0) {
    return { conflict: true };
  }
  const result = db
    .prepare(
      `INSERT INTO bookings (guest_id, room_id, check_in, check_out, guests, total_price, guest_note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(
      request.guestId,
      request.roomId,
      request.checkIn,
      request.checkOut,
      request.guests,
      request.totalPrice,
      request.guestNote
    );
  return { id: result.lastInsertRowid };
});

// Guests request a room; the owner approves or declines.
router.post('/bookings', requireGuest, (req, res) => {
  const { roomId, checkIn, checkOut, guests, note } = req.body ?? {};
  if (!v.isValidId(roomId)) {
    return res.status(400).json({ error: 'A valid room is required' });
  }
  const stay = v.validateStay(checkIn, checkOut);
  if (stay.error) {
    return res.status(400).json({ error: stay.error });
  }
  const guestCount = guests === undefined ? 1 : guests;
  if (!v.isValidGuestCount(guestCount)) {
    return res.status(400).json({ error: 'Guest count must be between 1 and 50' });
  }
  if (note !== undefined && note !== '' && !v.isValidNote(note)) {
    return res.status(400).json({ error: 'Message is too long (max 500 characters)' });
  }

  const room = db
    .prepare('SELECT id, name, price_per_night, max_guests FROM rooms WHERE id = ? AND published = 1')
    .get(Number(roomId));
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (Number(guestCount) > room.max_guests) {
    return res.status(400).json({ error: `This room sleeps at most ${room.max_guests} guests` });
  }

  // The total is computed server-side from the stored nightly rate; any price
  // sent by the client is ignored entirely.
  const totalPrice = room.price_per_night * stay.nights;

  const outcome = reserve.immediate({
    guestId: req.user.id,
    roomId: room.id,
    checkIn,
    checkOut,
    guests: Number(guestCount),
    totalPrice,
    guestNote: (note ?? '').trim(),
  });
  if (outcome.conflict) {
    return res.status(409).json({ error: 'Those dates are no longer available' });
  }

  const guest = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(req.user.id);
  // Delivery is deliberately not awaited: a slow or broken provider must never
  // delay or fail a guest's request. Failures are recorded for the dashboard.
  notify
    .notifyOwnerOfRequest({
      id: outcome.id,
      room: room.name,
      checkIn,
      checkOut,
      nights: stay.nights,
      guests: Number(guestCount),
      totalPrice,
      guestName: guest.name,
      guestEmail: guest.email,
      guestPhone: guest.phone,
      guestNote: (note ?? '').trim(),
    })
    .catch(() => {});

  res.status(201).json({
    booking: {
      id: outcome.id,
      room: room.name,
      roomId: room.id,
      checkIn,
      checkOut,
      nights: stay.nights,
      guests: Number(guestCount),
      totalPrice,
      status: 'pending',
    },
  });
});

// A guest's own requests and stays.
router.get('/bookings', requireGuest, (req, res) => {
  const bookings = db
    .prepare(
      `SELECT b.id, b.check_in AS checkIn, b.check_out AS checkOut, b.guests,
              b.total_price AS totalPrice, b.status, b.guest_note AS guestNote,
              b.owner_note AS ownerNote, b.created_at AS createdAt,
              r.id AS roomId, r.name AS room,
              (SELECT id FROM images WHERE room_id = r.id ORDER BY id LIMIT 1) AS coverImageId
         FROM bookings b JOIN rooms r ON r.id = b.room_id
        WHERE b.guest_id = ?
        ORDER BY b.check_in DESC`
    )
    .all(req.user.id);

  const property = db
    .prepare(
      `SELECT name, contact_name AS contactName, contact_email AS contactEmail,
              contact_phone AS contactPhone, check_in_time AS checkInTime,
              check_out_time AS checkOutTime, address
         FROM property WHERE id = 1`
    )
    .get();
  res.json({ bookings, property });
});

// Cancel. Scoped to the signed-in guest in the WHERE clause, so a guest can
// never cancel — or probe the existence of — someone else's booking.
router.delete('/bookings/:id', requireGuest, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const result = db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', decided_at = datetime('now')
        WHERE id = ? AND guest_id = ? AND status IN ${HOLDING_STATUSES}`
    )
    .run(Number(req.params.id), req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json({ ok: true });
});

// --- Owner: the approval inbox ---

router.get('/owner/bookings', requireOwner, (req, res) => {
  const status = req.query.status;
  const allowed = ['pending', 'approved', 'declined', 'cancelled'];
  const clauses = [];
  const params = [];
  if (status !== undefined && status !== '') {
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Unknown status filter' });
    }
    clauses.push('b.status = ?');
    params.push(status);
  }

  const bookings = db
    .prepare(
      `SELECT b.id, b.check_in AS checkIn, b.check_out AS checkOut, b.guests,
              b.total_price AS totalPrice, b.status, b.guest_note AS guestNote,
              b.owner_note AS ownerNote, b.created_at AS createdAt,
              b.decided_at AS decidedAt,
              r.name AS room, r.id AS roomId,
              u.name AS guestName, u.email AS guestEmail, u.phone AS guestPhone
         FROM bookings b
         JOIN rooms r ON r.id = b.room_id
         JOIN users u ON u.id = b.guest_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.check_in
        LIMIT 500`
    )
    .all(...params);

  const pendingCount = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'").get().n;
  res.json({ bookings, pendingCount });
});

// Approve or decline. Only a pending request can be decided, and deciding is
// atomic so a double-click cannot approve twice or race a decline.
function decide(req, res, nextStatus) {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const { note } = req.body ?? {};
  if (note !== undefined && note !== '' && !v.isValidNote(note)) {
    return res.status(400).json({ error: 'Note is too long (max 500 characters)' });
  }

  const apply = db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE bookings SET status = ?, owner_note = ?, decided_at = datetime('now')
          WHERE id = ? AND status = 'pending'`
      )
      .run(nextStatus, (note ?? '').trim(), Number(req.params.id)).changes;
    if (changed === 0) return null;
    return db
      .prepare(
        `SELECT b.id, b.check_in AS checkIn, b.check_out AS checkOut,
                b.total_price AS totalPrice, b.owner_note AS ownerNote,
                r.name AS room, u.email AS guestEmail, u.name AS guestName
           FROM bookings b
           JOIN rooms r ON r.id = b.room_id
           JOIN users u ON u.id = b.guest_id
          WHERE b.id = ?`
      )
      .get(Number(req.params.id));
  });

  const booking = apply.immediate();
  if (!booking) {
    return res.status(409).json({ error: 'That request is no longer pending' });
  }

  notify.notifyGuestOfDecision(booking, nextStatus === 'approved').catch(() => {});
  return res.json({ ok: true, status: nextStatus });
}

router.post('/owner/bookings/:id/approve', requireOwner, (req, res) => decide(req, res, 'approved'));
router.post('/owner/bookings/:id/decline', requireOwner, (req, res) => decide(req, res, 'declined'));

module.exports = router;

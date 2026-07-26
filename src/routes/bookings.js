'use strict';

const express = require('express');
const db = require('../db');
const { requireGuest, requireOwner } = require('../auth');
const v = require('../validators');

const router = express.Router();

// Two stays clash when each starts before the other ends. Same-day
// changeover (one guest's check-out is the next guest's check-in) is allowed.
const OVERLAP_SQL = `
  SELECT COUNT(*) AS n FROM bookings
   WHERE property_id = ? AND check_in < ? AND check_out > ?`;

// Reserve a property atomically: the availability check and the insert run in
// one immediate transaction, so two simultaneous requests for the same dates
// cannot both succeed.
const reserve = db.transaction((booking) => {
  const clash = db
    .prepare(OVERLAP_SQL)
    .get(booking.propertyId, booking.checkOut, booking.checkIn).n;
  if (clash > 0) {
    return { conflict: true };
  }
  const result = db
    .prepare(
      `INSERT INTO bookings (guest_id, property_id, check_in, check_out, guests, total_price)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      booking.guestId,
      booking.propertyId,
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.totalPrice
    );
  return { id: result.lastInsertRowid };
});

// Guests book; owners manage listings and cannot book through this route.
router.post('/bookings', requireGuest, (req, res) => {
  const { propertyId, checkIn, checkOut, guests } = req.body ?? {};
  if (!v.isValidId(propertyId)) {
    return res.status(400).json({ error: 'A valid property is required' });
  }
  const stay = v.validateStay(checkIn, checkOut);
  if (stay.error) {
    return res.status(400).json({ error: stay.error });
  }
  const guestCount = guests === undefined ? 1 : guests;
  if (!v.isValidGuestCount(guestCount)) {
    return res.status(400).json({ error: 'Guest count must be between 1 and 50' });
  }

  const property = db
    .prepare('SELECT id, title, price_per_night, max_guests FROM properties WHERE id = ? AND published = 1')
    .get(Number(propertyId));
  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }
  if (Number(guestCount) > property.max_guests) {
    return res.status(400).json({ error: `This property sleeps at most ${property.max_guests} guests` });
  }

  // The total is computed server-side from the stored nightly rate; a price
  // sent by the client is ignored entirely.
  const totalPrice = property.price_per_night * stay.nights;

  const outcome = reserve.immediate({
    guestId: req.user.id,
    propertyId: property.id,
    checkIn,
    checkOut,
    guests: Number(guestCount),
    totalPrice,
  });
  if (outcome.conflict) {
    return res.status(409).json({ error: 'Those dates are no longer available' });
  }

  res.status(201).json({
    booking: {
      id: outcome.id,
      property: property.title,
      propertyId: property.id,
      checkIn,
      checkOut,
      nights: stay.nights,
      guests: Number(guestCount),
      totalPrice,
    },
  });
});

// A guest's own bookings only.
router.get('/bookings', requireGuest, (req, res) => {
  const bookings = db
    .prepare(
      `SELECT b.id, b.check_in AS checkIn, b.check_out AS checkOut, b.guests,
              b.total_price AS totalPrice, b.created_at AS createdAt,
              p.id AS propertyId, p.title AS property, p.location,
              p.contact_name AS contactName, p.contact_email AS contactEmail,
              p.contact_phone AS contactPhone,
              (SELECT id FROM property_images WHERE property_id = p.id ORDER BY id LIMIT 1) AS coverImageId
         FROM bookings b JOIN properties p ON p.id = b.property_id
        WHERE b.guest_id = ?
        ORDER BY b.check_in DESC`
    )
    .all(req.user.id);
  res.json({ bookings });
});

// Cancel. Ownership is enforced in the WHERE clause, so a guest can never
// cancel — or probe the existence of — someone else's booking.
router.delete('/bookings/:id', requireGuest, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const result = db
    .prepare('DELETE FROM bookings WHERE id = ? AND guest_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json({ ok: true });
});

// Bookings across the signed-in owner's properties, with the guest's contact
// details so the owner can reach them.
router.get('/owner/bookings', requireOwner, (req, res) => {
  const bookings =
    req.user.role === 'admin'
      ? db
          .prepare(
            `SELECT b.id, b.check_in AS checkIn, b.check_out AS checkOut, b.guests,
                    b.total_price AS totalPrice, p.title AS property,
                    u.name AS guestName, u.email AS guestEmail
               FROM bookings b
               JOIN properties p ON p.id = b.property_id
               JOIN users u      ON u.id = b.guest_id
              ORDER BY b.check_in DESC LIMIT 500`
          )
          .all()
      : db
          .prepare(
            `SELECT b.id, b.check_in AS checkIn, b.check_out AS checkOut, b.guests,
                    b.total_price AS totalPrice, p.title AS property,
                    u.name AS guestName, u.email AS guestEmail
               FROM bookings b
               JOIN properties p ON p.id = b.property_id
               JOIN users u      ON u.id = b.guest_id
              WHERE p.owner_id = ?
              ORDER BY b.check_in DESC LIMIT 500`
          )
          .all(req.user.id);
  res.json({ bookings });
});

module.exports = router;

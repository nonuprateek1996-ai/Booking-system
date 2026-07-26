'use strict';

const express = require('express');
const db = require('../db');
const { requireOwner } = require('../auth');
const v = require('../validators');

const router = express.Router();

// Escapes the LIKE wildcards so a search for "100%" cannot match everything.
function likeTerm(value) {
  return `%${String(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Returns the property only if this user is allowed to manage it. Every owner
// mutation goes through here, so an owner can never touch another's listing.
function findManageableProperty(id, user) {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(Number(id));
  if (!property) return null;
  if (user.role === 'admin') return property;
  return property.owner_id === user.id ? property : null;
}

function imageIdsFor(propertyId) {
  return db
    .prepare('SELECT id FROM property_images WHERE property_id = ? ORDER BY id')
    .all(propertyId)
    .map((r) => r.id);
}

// --- Public browsing (no authentication) ---

router.get('/properties', (req, res) => {
  const { q, maxPrice, guests } = req.query;
  const clauses = ['p.published = 1'];
  const params = [];

  if (typeof q === 'string' && q.trim() !== '') {
    if (q.length > 100) {
      return res.status(400).json({ error: 'Search term too long' });
    }
    clauses.push("(p.title LIKE ? ESCAPE '\\' OR p.location LIKE ? ESCAPE '\\')");
    params.push(likeTerm(q.trim()), likeTerm(q.trim()));
  }
  if (maxPrice !== undefined && maxPrice !== '') {
    if (!v.isValidPrice(maxPrice)) {
      return res.status(400).json({ error: 'Invalid maximum price' });
    }
    clauses.push('p.price_per_night <= ?');
    params.push(Number(maxPrice));
  }
  if (guests !== undefined && guests !== '') {
    if (!v.isValidGuestCount(guests)) {
      return res.status(400).json({ error: 'Invalid guest count' });
    }
    clauses.push('p.max_guests >= ?');
    params.push(Number(guests));
  }

  const properties = db
    .prepare(
      `SELECT p.id, p.title, p.location, p.price_per_night AS pricePerNight,
              p.max_guests AS maxGuests, p.description,
              (SELECT id FROM property_images WHERE property_id = p.id ORDER BY id LIMIT 1) AS coverImageId
         FROM properties p
        WHERE ${clauses.join(' AND ')}
        ORDER BY p.created_at DESC
        LIMIT 100`
    )
    .all(...params);

  res.json({ properties });
});

router.get('/properties/:id', (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid property id' });
  }
  const property = db
    .prepare(
      `SELECT id, title, description, location, price_per_night AS pricePerNight,
              max_guests AS maxGuests, contact_name AS contactName,
              contact_email AS contactEmail, contact_phone AS contactPhone, published
         FROM properties WHERE id = ?`
    )
    .get(Number(req.params.id));

  // Unpublished listings are visible only to the owner (and admins).
  if (!property || (!property.published && !(req.user && findManageableProperty(property.id, req.user)))) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const rooms = db
    .prepare('SELECT id, name, description FROM rooms WHERE property_id = ? ORDER BY id')
    .all(property.id);

  // Upcoming booked ranges, so the calendar can grey them out. Guest identities
  // are never exposed on this public endpoint.
  const booked = db
    .prepare(
      `SELECT check_in AS checkIn, check_out AS checkOut
         FROM bookings WHERE property_id = ? AND check_out >= date('now')
        ORDER BY check_in`
    )
    .all(property.id);

  delete property.published;
  res.json({ property, rooms, imageIds: imageIdsFor(property.id), booked });
});

// Public image delivery. Content-Type comes from the stored value, which was
// set by sniffing magic bytes at upload time — not from anything the uploader
// declared. Combined with the global nosniff header and a CSP that forbids
// scripts, an uploaded file cannot be turned into executable content.
router.get('/images/:id', (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid image id' });
  }
  const image = db
    .prepare('SELECT mime_type, bytes FROM property_images WHERE id = ?')
    .get(Number(req.params.id));
  if (!image) {
    return res.status(404).json({ error: 'Image not found' });
  }
  res.set('Content-Type', image.mime_type);
  res.set('Content-Disposition', 'inline');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(image.bytes);
});

// --- Owner management ---

router.get('/owner/properties', requireOwner, (req, res) => {
  const rows =
    req.user.role === 'admin'
      ? db.prepare('SELECT * FROM properties ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM properties WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);

  const properties = rows.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    location: p.location,
    pricePerNight: p.price_per_night,
    maxGuests: p.max_guests,
    contactName: p.contact_name,
    contactEmail: p.contact_email,
    contactPhone: p.contact_phone,
    published: Boolean(p.published),
    rooms: db.prepare('SELECT id, name, description FROM rooms WHERE property_id = ? ORDER BY id').all(p.id),
    imageIds: imageIdsFor(p.id),
  }));
  res.json({ properties });
});

// Shared field validation for create and update.
function validatePropertyFields(body, { partial = false } = {}) {
  const fields = {};
  const check = (key, valid, message, transform = (x) => x) => {
    if (body[key] === undefined) {
      if (!partial) return message;
      return null;
    }
    if (!valid(body[key])) return message;
    fields[key] = transform(body[key]);
    return null;
  };

  const errors = [
    check('title', v.isValidTitle, 'Title is required (max 120 characters)', (x) => x.trim()),
    check('location', v.isValidLocation, 'Location is required (max 120 characters)', (x) => x.trim()),
    check('pricePerNight', v.isValidPrice, 'Price must be a whole number of at least 1', Number),
    check('maxGuests', v.isValidGuestCount, 'Maximum guests must be between 1 and 50', Number),
  ].filter(Boolean);
  if (errors.length > 0) return { error: errors[0] };

  // Optional fields default to empty rather than being required.
  for (const [key, valid, message] of [
    ['description', v.isValidDescription, 'Description is too long (max 2000 characters)'],
    ['contactName', v.isValidName, 'Contact name is too long (max 100 characters)'],
    ['contactEmail', v.isValidEmail, 'Contact email is not valid'],
    ['contactPhone', v.isValidPhone, 'Contact phone is not valid'],
  ]) {
    if (body[key] === undefined || body[key] === '') {
      if (!partial) fields[key] = '';
      continue;
    }
    if (!valid(body[key])) return { error: message };
    fields[key] = String(body[key]).trim();
  }

  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') {
      return { error: 'Published must be true or false' };
    }
    fields.published = body.published ? 1 : 0;
  }

  return { fields };
}

router.post('/owner/properties', requireOwner, (req, res) => {
  const { error, fields } = validatePropertyFields(req.body ?? {});
  if (error) return res.status(400).json({ error });

  const result = db
    .prepare(
      `INSERT INTO properties
         (owner_id, title, description, location, price_per_night, max_guests,
          contact_name, contact_email, contact_phone, published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      fields.title,
      fields.description ?? '',
      fields.location,
      fields.pricePerNight,
      fields.maxGuests,
      fields.contactName ?? '',
      fields.contactEmail ?? '',
      fields.contactPhone ?? '',
      fields.published ?? 1
    );

  res.status(201).json({ property: { id: result.lastInsertRowid, title: fields.title } });
});

router.patch('/owner/properties/:id', requireOwner, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid property id' });
  }
  if (!findManageableProperty(req.params.id, req.user)) {
    return res.status(404).json({ error: 'Property not found' });
  }
  const { error, fields } = validatePropertyFields(req.body ?? {}, { partial: true });
  if (error) return res.status(400).json({ error });

  const columns = {
    title: 'title',
    description: 'description',
    location: 'location',
    pricePerNight: 'price_per_night',
    maxGuests: 'max_guests',
    contactName: 'contact_name',
    contactEmail: 'contact_email',
    contactPhone: 'contact_phone',
    published: 'published',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(fields[key]);
    }
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'No changes supplied' });
  }
  params.push(Number(req.params.id));
  db.prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/owner/properties/:id', requireOwner, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid property id' });
  }
  const property = findManageableProperty(req.params.id, req.user);
  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }
  // Guests' upcoming stays are protected: unpublish hides a listing without
  // destroying bookings people are relying on.
  const upcoming = db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE property_id = ? AND check_out >= date('now')")
    .get(property.id).n;
  if (upcoming > 0) {
    return res.status(409).json({
      error: `This property has ${upcoming} upcoming booking(s). Unpublish it instead, or wait until the stays are over.`,
    });
  }
  db.prepare('DELETE FROM properties WHERE id = ?').run(property.id);
  res.json({ ok: true });
});

// --- Rooms ---

router.post('/owner/properties/:id/rooms', requireOwner, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid property id' });
  }
  const property = findManageableProperty(req.params.id, req.user);
  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }
  const { name, description } = req.body ?? {};
  if (!v.isValidRoomName(name)) {
    return res.status(400).json({ error: 'Room name is required (max 80 characters)' });
  }
  if (description !== undefined && description !== '' && !v.isValidDescription(description)) {
    return res.status(400).json({ error: 'Room description is too long (max 2000 characters)' });
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE property_id = ?').get(property.id).n;
  if (count >= 30) {
    return res.status(409).json({ error: 'A property can have at most 30 rooms' });
  }
  const result = db
    .prepare('INSERT INTO rooms (property_id, name, description) VALUES (?, ?, ?)')
    .run(property.id, name.trim(), (description ?? '').trim());
  res.status(201).json({ room: { id: result.lastInsertRowid, name: name.trim() } });
});

router.delete('/owner/rooms/:id', requireOwner, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid room id' });
  }
  const room = db.prepare('SELECT property_id FROM rooms WHERE id = ?').get(Number(req.params.id));
  if (!room || !findManageableProperty(room.property_id, req.user)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  db.prepare('DELETE FROM rooms WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// --- Images ---

// The body is read as raw bytes; the declared Content-Type is only a filter,
// the real type is decided by sniffing magic bytes below.
const rawImage = express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: v.MAX_IMAGE_BYTES,
});

router.post('/owner/properties/:id/images', requireOwner, rawImage, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid property id' });
  }
  const property = findManageableProperty(req.params.id, req.user);
  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Send the image as a JPEG, PNG or WebP file' });
  }
  const mime = v.sniffImageType(req.body);
  if (!mime) {
    return res.status(400).json({ error: 'That file is not a valid JPEG, PNG or WebP image' });
  }
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM property_images WHERE property_id = ?')
    .get(property.id).n;
  if (count >= 20) {
    return res.status(409).json({ error: 'A property can have at most 20 photos' });
  }
  const caption = typeof req.query.caption === 'string' ? req.query.caption : '';
  if (!v.isValidCaption(caption)) {
    return res.status(400).json({ error: 'Caption is too long (max 140 characters)' });
  }
  const result = db
    .prepare('INSERT INTO property_images (property_id, mime_type, bytes, caption) VALUES (?, ?, ?, ?)')
    .run(property.id, mime, req.body, caption.trim());
  res.status(201).json({ image: { id: result.lastInsertRowid } });
});

router.delete('/owner/images/:id', requireOwner, (req, res) => {
  if (!v.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid image id' });
  }
  const image = db
    .prepare('SELECT property_id FROM property_images WHERE id = ?')
    .get(Number(req.params.id));
  if (!image || !findManageableProperty(image.property_id, req.user)) {
    return res.status(404).json({ error: 'Image not found' });
  }
  db.prepare('DELETE FROM property_images WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;

'use strict';

// Bookable time slots (start of each one-hour window).
const SLOTS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

// How far ahead bookings may be made.
const MAX_ADVANCE_DAYS = 90;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function isValidName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 100;
}

// bcrypt only uses the first 72 bytes, so cap the length as well as floor it.
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && Buffer.byteLength(password, 'utf8') <= 72;
}

function isValidSlot(slot) {
  return typeof slot === 'string' && SLOTS.includes(slot);
}

// Accepts only a real calendar date, today or later, within the booking window.
function isValidBookingDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Reject dates JS "helpfully" rolls over, e.g. 2026-02-31 -> March 3rd.
  if (parsed.toISOString().slice(0, 10) !== date) return false;

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const diffDays = (parsed.getTime() - todayUtc) / 86400000;
  return diffDays >= 0 && diffDays <= MAX_ADVANCE_DAYS;
}

function isValidId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
}

function isValidResourceName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 120;
}

function isValidDescription(text) {
  return typeof text === 'string' && text.length <= 500;
}

module.exports = {
  SLOTS,
  MAX_ADVANCE_DAYS,
  normalizeEmail,
  isValidEmail,
  isValidName,
  isValidPassword,
  isValidSlot,
  isValidBookingDate,
  isValidId,
  isValidResourceName,
  isValidDescription,
};

'use strict';

// TOTP (RFC 6238) built on Node's own crypto, so two-factor adds no
// third-party dependency to the supply chain. Compatible with Google
// Authenticator, Authy, 1Password and any other standard TOTP app.

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side, to tolerate clock drift between phone and server.
const WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character in secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  // 160 bits, the size RFC 4226 recommends for HMAC-SHA1.
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentStep(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

function codeForStep(secret, step) {
  return hotp(base32Decode(secret), step);
}

// Compares in constant time so a near-miss code cannot be found by timing.
function codesMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verifies a submitted code.
 *
 * `minStep` blocks replay: pass the last step this user already consumed and
 * anything at or before it is refused, so a code observed over the shoulder
 * (or in a log) cannot be used a second time inside its 30-second window.
 *
 * Returns the accepted step, or null if the code is not valid.
 */
function verify(secret, submitted, { atMs = Date.now(), minStep = 0 } = {}) {
  if (typeof submitted !== 'string' || !/^\d{6}$/.test(submitted.trim())) {
    return null;
  }
  const code = submitted.trim();
  const now = currentStep(atMs);
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const step = now + offset;
    if (step <= minStep) continue;
    if (codesMatch(code, codeForStep(secret, step))) {
      return step;
    }
  }
  return null;
}

// otpauth:// URI for QR codes and manual entry in an authenticator app.
function provisioningUri(secret, { issuer, account }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  STEP_SECONDS,
  DIGITS,
  generateSecret,
  verify,
  codeForStep,
  currentStep,
  provisioningUri,
};

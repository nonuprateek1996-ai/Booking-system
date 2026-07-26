'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { sessionLoader, csrfProtection, pruneExpiredSessions } = require('./auth');
const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const bookingRoutes = require('./routes/bookings');

const app = express();

// Do not advertise the framework.
app.disable('x-powered-by');

// On hosting platforms the app sits behind exactly one TLS-terminating proxy;
// trusting it makes Secure cookies and per-client rate limiting work correctly.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// Security headers, including a strict same-origin CSP (no inline scripts).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

// Global rate limit; credential endpoints have their own tighter limit.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.GLOBAL_RATE_LIMIT) || 500,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  })
);

// Small body limit: no endpoint needs large payloads.
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(sessionLoader);
app.use(csrfProtection);

app.use('/api/auth', authRoutes);
app.use('/api', propertyRoutes);
app.use('/api', bookingRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Unknown API routes get JSON 404s rather than the static handler's HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler: log details server-side, never leak them to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That file or request is too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Hourly cleanup of expired sessions.
const pruneTimer = setInterval(pruneExpiredSessions, 60 * 60 * 1000);
pruneTimer.unref();

module.exports = app;

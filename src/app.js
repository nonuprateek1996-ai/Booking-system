'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { sessionLoader, csrfProtection, pruneExpiredSessions } = require('./auth');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
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
        // Fonts are self-hosted, so no external font host is permitted —
        // tighter than Helmet's default, which allows any https origin.
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

// Health check for the hosting platform. Deliberately a dedicated endpoint
// rather than a product one: it must keep answering across refactors, and it
// sits above the rate limiter so frequent polling can never be throttled or
// eat into a real visitor's allowance.
app.get('/healthz', (req, res) => {
  try {
    // Confirms the process is up *and* the database is readable.
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ status: 'unavailable' });
  }
});

// Custom domain: send every alias to the one canonical hostname. Render routes
// several names to this service (the apex, www, and the permanent
// *.onrender.com URL), and without this they would each serve the whole site —
// splitting search rankings and leaving visitors on whichever one they happened
// to type. Unset in development, where the app answers on localhost.
//
// CANONICAL_HOST must agree with the apex/www redirect Render performs at its
// own edge (the "redirects to ..." badge under Settings -> Custom Domains).
// Aim the two at each other and a request bounces between Render and this app
// until the browser aborts with ERR_TOO_MANY_REDIRECTS.
//
// It sits below /healthz so platform probes are never redirected, and above the
// rate limiter so a redirected visitor does not spend an allowance on a request
// that returns no content. Protocol is left alone: Render terminates TLS and
// already forces HTTPS, and second-guessing that from behind the proxy risks a
// redirect loop.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim().toLowerCase();
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    // Strip any port before comparing: the Host header carries one when the
    // service is reached on a non-standard port, the configured name never does.
    const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!host || host === CANONICAL_HOST) return next();
    // Only origin-form targets are rewritten. An absolute-form request line
    // ("GET http://elsewhere/") would otherwise be pasted onto the canonical
    // name and produce a nonsense Location header.
    const target = req.originalUrl.startsWith('/') ? req.originalUrl : '/';
    // 308 rather than 301: it preserves the method and body, so a form post
    // that lands on an alias still completes instead of silently becoming a GET.
    res.redirect(308, `https://${CANONICAL_HOST}${target}`);
  });
}

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
app.use('/api', roomRoutes);
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

# Booking System

A secure room/resource booking web application. Users register, sign in, check availability, and book one-hour slots on shared resources (meeting rooms, booths, halls). Admins can manage resources and see all bookings.

## Stack

- **Backend:** Node.js (≥18), Express, better-sqlite3 (SQLite)
- **Frontend:** Vanilla HTML/CSS/JS single page, served statically
- **Auth:** Server-side sessions with hashed tokens in HttpOnly cookies

## Getting started

```bash
npm install
npm start          # serves http://127.0.0.1:3000
```

The SQLite database is created automatically in `data/` and seeded with a few example resources on first run.

Create an admin account (credentials come from the environment, never from code):

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-strong-password' npm run create-admin
```

Run the test suite (includes security regression tests):

```bash
npm test
```

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | – | Create an account, starts a session |
| POST | `/api/auth/login` | – | Sign in |
| POST | `/api/auth/logout` | user | Sign out (revokes session) |
| GET | `/api/auth/me` | – | Current user (or `null`) |
| POST | `/api/auth/change-password` | user | Change password, revokes all other sessions |
| GET | `/api/resources` | – | List active resources |
| GET | `/api/resources/:id/availability?date=YYYY-MM-DD` | – | Slot availability |
| POST | `/api/bookings` | user | Book a slot |
| GET | `/api/bookings` | user | Own bookings |
| DELETE | `/api/bookings/:id` | user | Cancel own booking (admin: any) |
| GET | `/api/admin/bookings` | admin | All bookings |
| POST | `/api/admin/resources` | admin | Add a resource |
| DELETE | `/api/admin/resources/:id` | admin | Deactivate a resource |

Bookings are for one-hour slots between 09:00 and 17:00, up to 90 days ahead.

## Security design

The application was built to eliminate the common web vulnerability classes:

- **SQL injection** — every query uses prepared statements with bound parameters; no string-built SQL anywhere.
- **XSS** — the frontend inserts all dynamic data via `textContent`/`createTextNode` (never `innerHTML`), and a strict Content-Security-Policy (`default-src 'self'`, no inline scripts) is enforced via Helmet as a second layer.
- **CSRF** — session cookies are `SameSite=Strict`, and every state-changing request is additionally checked against the request `Origin`/`Referer`.
- **Broken authentication** — passwords hashed with bcrypt (cost 12, 8–72 char policy); login compares against a dummy hash when the account doesn't exist so response timing and error messages don't reveal which emails are registered.
- **Session hijacking** — session tokens are 256-bit random values stored server-side only as SHA-256 hashes (a database leak exposes no usable tokens); cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production; sessions expire after 7 days; a password change revokes all sessions.
- **IDOR / broken access control** — every booking query is scoped to the authenticated user in the `WHERE` clause; other users' bookings return 404 (not 403), so their existence can't be probed. Admin routes require the `admin` role, granted only via the `create-admin` script.
- **Brute force / DoS** — rate limiting on all endpoints with a tighter limit on credential endpoints; request bodies capped at 10 KB.
- **Race conditions / double booking** — a database `UNIQUE(resource_id, date, slot)` constraint makes double-booking impossible even under concurrent requests.
- **Information leakage** — a central error handler returns generic messages and logs details server-side only; `X-Powered-By` is disabled; security headers (CSP, `nosniff`, `frame-ancestors 'none'`, referrer policy) are set by Helmet.
- **Secrets** — no credentials or secrets in the codebase; admin credentials are supplied via environment variables; the database and `.env` are git-ignored.
- **Input validation** — every field (email, name, password, date, slot, ids) is validated server-side with strict allow-lists; calendar dates are verified as real dates within the booking window.

For production deployment, run behind TLS (the `Secure` cookie flag activates with `NODE_ENV=production`) and set `HOST`/`PORT` as needed (the server binds to `127.0.0.1` by default).

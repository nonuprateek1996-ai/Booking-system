# Staylist — property booking system

A secure property-rental web application. Visitors browse listings, photos and prices with no account at all; guests sign in to book stays; owners sign in through a separate portal to list and manage their properties.

## Stack

- **Backend:** Node.js (≥18), Express, better-sqlite3 (SQLite)
- **Frontend:** Vanilla HTML/CSS/ES modules, served statically
- **Auth:** Server-side sessions with hashed tokens in HttpOnly cookies

## Getting started

```bash
npm install
npm start          # serves http://127.0.0.1:3000
```

The SQLite database is created automatically in `data/`, and a few example listings are seeded on first run so the landing page isn't empty. Set `SEED_DEMO=0` to skip that. The seeded demo owner is given a random, unrecorded password, so it is not a usable account — real owners register their own.

Run the test suite (33 tests, including security regression tests):

```bash
npm test
```

Optional: create an admin account (credentials come from the environment, never from code). Admins sign in through the owner portal and can manage every listing.

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-strong-password' npm run create-admin
```

## How it works

**Visitors (no account)** land on the property grid, search by place, price and party size, and open any listing to see its photos, description, rooms and the owner's contact details.

**Guests** register at `/login.html`, pick dates and party size on a listing, and get instant confirmation if the dates are free. `/bookings.html` lists their trips with the host's contact details and a cancel button.

**Owners** register at `/owner-login.html` and manage everything from `/owner.html`: create properties, edit title, location, description, nightly price and capacity, add and remove room descriptions, upload and delete photos, publish or unpublish a listing, and see every booking on their properties with the guest's contact details.

Guests book whole properties by the night. Rooms are descriptive detail within a listing, not separately bookable.

## API

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/properties` | public | Search and list published properties |
| GET | `/api/properties/:id` | public | Listing detail, rooms, photos, booked dates |
| GET | `/api/images/:id` | public | Serve a property photo |
| POST | `/api/auth/register` | public | Create a guest or owner account |
| POST | `/api/auth/login` | public | Sign in through the `guest` or `owner` portal |
| POST | `/api/auth/logout` | any | Sign out |
| GET | `/api/auth/me` | public | Current user, or `null` |
| POST | `/api/auth/change-password` | any | Change password, revokes other sessions |
| POST | `/api/bookings` | guest | Book a stay |
| GET | `/api/bookings` | guest | Own bookings |
| DELETE | `/api/bookings/:id` | guest | Cancel own booking |
| GET | `/api/owner/properties` | owner | Own listings, with rooms and photos |
| POST | `/api/owner/properties` | owner | Create a listing |
| PATCH | `/api/owner/properties/:id` | owner | Update or (un)publish a listing |
| DELETE | `/api/owner/properties/:id` | owner | Delete a listing |
| POST | `/api/owner/properties/:id/rooms` | owner | Add a room description |
| DELETE | `/api/owner/rooms/:id` | owner | Remove a room |
| POST | `/api/owner/properties/:id/images` | owner | Upload a photo (raw JPEG/PNG/WebP body) |
| DELETE | `/api/owner/images/:id` | owner | Delete a photo |
| GET | `/api/owner/bookings` | owner | Bookings across own properties |

Stays may start up to 365 days ahead and run up to 60 nights.

## Security design

The application was built to eliminate the common web vulnerability classes, and each of these is covered by a regression test:

- **SQL injection** — every query uses prepared statements with bound parameters; no string-built SQL anywhere. Search terms additionally escape LIKE wildcards, so a bare `%` is matched literally rather than returning every listing.
- **XSS** — the frontend builds all DOM through `textContent`/`createTextNode` and never uses `innerHTML`, so listing text written by owners cannot become markup. A strict Content-Security-Policy (`default-src 'self'`, no inline scripts) enforces this a second time.
- **Malicious uploads** — photos are accepted only after their real type is confirmed by magic-byte sniffing, never from the declared `Content-Type`. SVG is deliberately unsupported because it can carry script. Uploads are capped at 2 MB and 20 photos per property, and are served with a fixed type plus `nosniff`.
- **Broken access control** — roles are `guest`, `owner` and `admin`, and each route lists exactly which may reach it. Guests cannot reach owner endpoints and owners cannot book. `admin` can never be self-assigned at registration; it is granted only by the server-side `create-admin` script.
- **Portal isolation** — guest and owner sign-in are separate portals, and an account can only authenticate through its own. Using the wrong portal returns the same error as a wrong password, so the portals cannot be used to discover which emails are owners.
- **IDOR** — every owner mutation resolves the target through an ownership check, and bookings are scoped to the signed-in guest in the `WHERE` clause. Another user's property, room, photo or booking returns 404 rather than 403, so its existence is never confirmed.
- **CSRF** — session cookies are `SameSite=Strict`, and every state-changing request is additionally checked against the request `Origin`/`Referer`.
- **Broken authentication** — passwords hashed with bcrypt (cost 12, 8–72 character policy); login compares against a dummy hash when the account doesn't exist, so timing and error messages don't reveal which emails are registered.
- **Session hijacking** — session tokens are 256-bit random values stored server-side only as SHA-256 hashes (a database leak exposes no usable tokens); cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production; sessions expire after 7 days; a password change revokes all sessions.
- **Price tampering** — booking totals are computed server-side from the stored nightly rate, and a price sent by the client is ignored. Money is held as integers, so totals cannot drift through floating-point rounding.
- **Double booking** — the availability check and the insert run inside one immediate transaction, so simultaneous requests for overlapping dates cannot both succeed. Same-day changeover is allowed by design.
- **Open redirect** — the post-login `?next=` parameter is honoured only for same-origin relative paths.
- **Data loss** — deleting a property with upcoming bookings is refused; owners unpublish instead, which hides the listing without destroying stays guests are relying on.
- **Brute force / DoS** — rate limiting on all endpoints with a tighter limit on credential endpoints; JSON bodies capped at 10 KB.
- **Information leakage** — a central error handler returns generic messages and logs details server-side only; `X-Powered-By` is disabled; security headers (CSP, `nosniff`, `frame-ancestors 'none'`, referrer policy) are set by Helmet.
- **Secrets** — no credentials in the codebase; admin credentials come from environment variables; seeded demo data ships no usable password; the database and `.env` are git-ignored.

For production, run behind TLS (the `Secure` cookie flag activates with `NODE_ENV=production`) and set `TRUST_PROXY=1` when behind a single reverse proxy so secure cookies and per-client rate limiting work correctly. The server binds to `127.0.0.1` by default; set `HOST`/`PORT` as needed.

## Deploying (go live)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nonuprateek1996-ai/Booking-system)

**Render (one click, free):** click the button above, sign in with GitHub, and Render reads `render.yaml` and deploys automatically. You'll get a public `https://booking-system-XXXX.onrender.com` URL. On the free plan the SQLite file is ephemeral (listings, photos and bookings reset on redeploys); attach a persistent disk mounted at `/data` and set `DATA_DIR=/data` to keep data permanently.

**Any Docker host (Railway, Fly.io, a VPS):** a production `Dockerfile` is included:

```bash
docker build -t booking-system .
docker run -p 3000:3000 -v booking-data:/data booking-system
```

Because uploaded photos are stored in the SQLite database, a persistent volume keeps images as well as bookings.

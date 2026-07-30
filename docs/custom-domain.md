# Pointing colonelsparadisebir.com at the Render service

The code and blueprint changes are already in the repository. What remains are
two steps that can only be done from an account console: adding the domain in
Render, and creating the DNS records at the registrar the domain was bought
from.

## 1. Add the domain in Render

If the service was created from `render.yaml` and Render re-reads the blueprint
on deploy, the two names below are added automatically — open
**Settings → Custom Domains** and confirm they are listed. Otherwise add them by
hand:

1. Render Dashboard → the `booking-system` service → **Settings** → **Custom Domains**
2. **Add Custom Domain** → `colonelsparadisebir.com` → Save
3. **Add Custom Domain** → `www.colonelsparadisebir.com` → Save

Render then shows the exact DNS target for each name. Use the values Render
shows over the examples below if they differ.

Custom domains are available on the free instance type, so no plan change is
needed.

## 2. Create the DNS records at the registrar

Sign in wherever `colonelsparadisebir.com` was bought (GoDaddy, Namecheap,
Cloudflare, Hostinger, …) and open its DNS / nameserver settings.

| Type | Name / Host | Value | TTL |
| --- | --- | --- | --- |
| `A` | `@` (the bare domain) | `216.24.57.1` | default |
| `CNAME` | `www` | `booking-system.onrender.com` | default |

Notes on the two rows:

- **Apex (`@`)** — Render's documented anycast address for apex domains is
  `216.24.57.1`. **Copy the address Render shows on the Custom Domains page**
  rather than trusting this table; it is the one value here that Render can
  change. If the registrar supports `ALIAS`, `ANAME`, or CNAME flattening,
  prefer that pointing at `booking-system.onrender.com` — it follows Render
  automatically if the IP ever moves.
- **`www`** — the value is the service's own `.onrender.com` hostname. Confirm
  it on the service page; it is `booking-system.onrender.com` unless Render
  appended a suffix to make the name unique.
- If a parking page, forwarding rule, or placeholder `A`/`CNAME` record for `@`
  or `www` already exists, delete it. Two records for the same name conflict.
- **Delete any `AAAA` record** for `@` or `www`. Render serves over IPv4 only,
  and a leftover IPv6 record makes browsers try an address that does not answer.
- **On Cloudflare**, use a `CNAME` for the apex (Cloudflare flattens it) rather
  than the `A` record, and set both records to **DNS only** — the orange-cloud
  proxy blocks the check Render's certificate issuance depends on. Turn the
  proxy back on, if wanted, only after both certificates are issued.

## 3. Wait for verification

Render polls DNS and issues a TLS certificate automatically once the records
resolve. Both names flip to **Certificate Issued** — usually within 15 minutes,
though registrars advertise up to 48 hours.

While the page still says **Certificate Pending**, the browser cannot negotiate
TLS at all and shows `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` ("This site can't
provide a secure connection"). That is the expected appearance of a
not-yet-issued certificate, not a misconfiguration — it clears itself once the
status flips. If it is still pending after an hour, the usual causes are a
leftover `AAAA` record, a proxying CDN in front of the records, or a `CAA`
record that does not permit `letsencrypt.org`.

Check propagation from a terminal:

```bash
dig +short colonelsparadisebir.com
dig +short www.colonelsparadisebir.com
```

Then confirm the site and the redirect:

```bash
curl -sI https://www.colonelsparadisebir.com/          # expect HTTP/2 200
curl -sI https://colonelsparadisebir.com/              # expect 301 -> https://www.colonelsparadisebir.com/
curl -s  https://www.colonelsparadisebir.com/healthz   # expect {"status":"ok"}

# Following the chain must settle, not ping-pong. More than one or two hops
# means CANONICAL_HOST disagrees with Render's redirect direction.
curl -sIL https://colonelsparadisebir.com/ | grep -iE '^(HTTP|location)'
```

## How the app handles the domain

- `CANONICAL_HOST=www.colonelsparadisebir.com` is set in `render.yaml`. Any
  request arriving on another name Render routes here — the apex, the old
  `booking-system.onrender.com` URL — is answered with a `308` to the same path
  on the canonical name, so the site has one address for links, bookmarks and
  search engines. Set it in Render's environment too if the service does not
  re-read the blueprint.
- **`CANONICAL_HOST` must point the same way as Render's own apex/www redirect**,
  shown as a `redirects to ...` badge under Settings → Custom Domains. Render is
  currently set to send the apex to `www`, so `www` is canonical. Aim the two at
  each other and a request bounces between Render's edge and this app until the
  browser aborts with `ERR_TOO_MANY_REDIRECTS`.
- To make the bare domain canonical instead: on the Custom Domains page, edit
  the domain and use the **Redirect to** control so `www.colonelsparadisebir.com`
  redirects to `colonelsparadisebir.com`, then change `CANONICAL_HOST` to
  `colonelsparadisebir.com`. Change both, in either order — but do not leave
  them disagreeing.
- `/healthz` is deliberately exempt: Render probes the service on its internal
  hostname, and a redirect there would fail the deploy gate.
- HTTPS is Render's job. It terminates TLS, renews the certificate, and
  redirects HTTP to HTTPS before the request reaches this app — which is why the
  app rewrites the hostname only and never the protocol.
- Nothing else in the app hard-codes a hostname: cookies are host-scoped, the
  CSRF check compares the request's `Origin` against its own `Host`, and the CSP
  is `'self'`. The change of domain needs no further code edits.
- To move to a different domain later, change `CANONICAL_HOST` and the `domains`
  list in `render.yaml`; leaving `CANONICAL_HOST` unset disables the redirect
  entirely (which is how local development runs on `localhost`).

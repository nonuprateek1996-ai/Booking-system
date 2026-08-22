# Google sign-in for guests

Guests can sign in with Google instead of choosing a password. It is off until
two environment variables are set, and the sign-in page shows the button only
when they are — so a half-finished setup shows the password form, not a button
that dead-ends.

**Guests only.** The owner dashboard stays on password plus two-factor, and the
callback refuses outright if the Google address matches the owner account. See
*Why the owner is excluded* below.

## 1. Configure the Google Cloud project

1. <https://console.cloud.google.com> → create a project (or pick one).
2. **APIs & Services → OAuth consent screen**
   - User type **External**, then **Publish** the app when you are ready for
     real guests. While it is in *Testing*, only addresses you list as test
     users can sign in.
   - Scopes: the defaults are enough. This app asks only for `openid`, `email`
     and `profile` — no Gmail, Drive or contacts access, so the consent screen
     stays on the non-sensitive path and needs no Google review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorised redirect URI** — this must match character for character:

     ```
     https://www.colonelsparadisebir.com/api/auth/google/callback
     ```

     Add `http://localhost:3000/api/auth/google/callback` too if you develop
     locally. Google compares the whole string, so `http` vs `https`, a missing
     `www`, or a trailing slash all fail with `redirect_uri_mismatch`.

Copy the **Client ID** and **Client secret**.

## 2. Set the variables

In Render → the service → **Environment**:

| Key | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the client ID, ending `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | the client secret |
| `GOOGLE_REDIRECT_URI` | optional — set it if the derived URL is ever wrong |

They are deliberately absent from `render.yaml`: the secret is a credential and
does not belong in the repository.

Without `GOOGLE_REDIRECT_URI` the callback URL is built from `CANONICAL_HOST`,
which is what the blueprint already sets. Setting it explicitly turns a
mismatch into an obvious configuration error rather than a confusing message
from Google.

## 3. Check it

Open `/login.html`. The **Continue with Google** button appears only when the
server reports the feature configured — `GET /api/auth/providers` returns
`{"google":true}`.

Sign in with an address that has never booked. A guest account is created, and
the dashboard's **Requests** tab shows their bookings exactly like any other
guest's.

## How it works

A server-side authorization-code flow with PKCE, not Google's JavaScript SDK.
The site runs a strict CSP with `script-src 'self'`, and the SDK would mean
allowing a third-party script origin on every page. A redirect flow needs no
third-party JavaScript, so the CSP is untouched.

```
/api/auth/google           → sets a short-lived state + PKCE cookie, redirects to Google
   ↓
accounts.google.com        → guest picks an account
   ↓
/api/auth/google/callback  → checks state, exchanges the code, validates the token,
                             finds or creates the guest, issues the session
   ↓
/auth-complete.html        → forwards to the destination
```

### Why there is a page in the middle

The session cookie is `SameSite=Strict`. The callback response is the tail of a
cross-site navigation from `accounts.google.com`, and browsers may withhold a
Strict cookie on the hop straight after that — the guest would land on a page
that believes they are signed out. A navigation started by a page on this origin
is unambiguously same-site, so `/auth-complete.html` forwards them and the
cookie travels.

The state cookie is `SameSite=Lax` for the mirror-image reason: the callback
*is* a cross-site navigation, and a Strict cookie would never arrive.

### Why the owner is excluded

The dashboard controls every booking and every guest's contact details. It is
protected by a password, a second factor, per-account lockout and a short
session. Allowing Google sign-in for it would replace all of that with "controls
one Gmail account" — and would silently downgrade the account the moment the
owner's address happened to be a Google one.

So the callback refuses any account whose role is not `guest`, and the refusal
reads the same as any other, so the response cannot be used to work out which
address belongs to the owner.

### Account linking

A guest who registered with a password and later uses Google with the same
address is linked to their existing account rather than given a second one, so
their booking history follows them. Their password keeps working — linking adds
a way in, it does not replace one.

This is safe only because Google's `email_verified` claim is required. An
unverified address is a string someone typed, and accepting it would let anyone
claim an address they do not control and walk into the account it matches.

Accounts are matched on Google's subject identifier first and the address
second, so a guest who changes the address on their Google account keeps their
bookings.

### On the ID token signature

The ID token is not signature-checked locally. It never passes through the
browser: it arrives in the body of this server's own TLS request to Google's
token endpoint, authenticated with the client secret — the case Google documents
as not requiring local verification. Verifying it would mean fetching, caching
and rotating JWKS, which is more moving parts and another failure mode for no
extra guarantee on this path.

The claims are still checked, because a trusted channel proves who sent the
token, not that it says what this application requires: issuer, audience
(`aud` must be this client ID, so a token minted for another application is
refused), expiry, subject, address, and `email_verified`.

## Turning it off

Remove `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and redeploy. The button
disappears and the endpoints return 404. Guests who signed in with Google keep
their accounts and bookings, but have no password — they would need one issuing
before they could sign in again, so tell them before switching it off.

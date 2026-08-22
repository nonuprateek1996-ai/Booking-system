'use strict';

// The last hop of Google sign-in. The callback lands here rather than on the
// destination because the session cookie is SameSite=Strict: this page's own
// request is the tail of a cross-site navigation from Google, and a browser may
// withhold a Strict cookie on that hop. A navigation started by this page is
// unambiguously same-site, so the cookie travels and the destination sees a
// signed-in guest.

// Only same-origin paths are honoured, so a crafted ?next= cannot forward
// someone to another site immediately after signing in.
function safeNext(fallback) {
  const next = new URLSearchParams(window.location.search).get('next');
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

const destination = safeNext('/bookings.html');
document.getElementById('fallback').setAttribute('href', destination);

// replace(), so Back does not return here and bounce forward again.
window.location.replace(destination);

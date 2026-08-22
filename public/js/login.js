'use strict';

import { api, showMessage, initPage } from './common.js';

const portal = document.body.dataset.portal; // 'guest' or 'owner'
const isOwnerPortal = portal === 'owner';
const home = isOwnerPortal ? '/owner.html' : '/bookings.html';

let registering = false;

// Only same-origin relative paths are honoured, so a crafted ?next= cannot
// bounce a freshly signed-in user to an attacker's site (open redirect).
function safeNext(fallback) {
  const next = new URLSearchParams(window.location.search).get('next');
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
    return next;
  }
  return fallback;
}

// Guests can self-register; the owner account never can.
function setMode(toRegistering) {
  registering = toRegistering;
  document.getElementById('auth-title').textContent = registering ? 'Create a guest account' : 'Sign in to book';
  document.getElementById('submit').textContent = registering ? 'Create account' : 'Sign in';
  document.getElementById('toggle').textContent = registering ? 'Sign in instead' : 'Create a guest account';
  document.getElementById('toggle-text').textContent = registering ? 'Already registered?' : 'New here?';
  document.getElementById('name-row').hidden = !registering;
  document.getElementById('phone-row').hidden = !registering;
  document.getElementById('name').required = registering;
  document.getElementById('password').autocomplete = registering ? 'new-password' : 'current-password';
  showMessage('');
}

// The callback redirects back here with ?error= when Google sign-in could not
// be completed, so the reason is shown rather than silently swallowed.
function showRedirectError() {
  const message = new URLSearchParams(window.location.search).get('error');
  if (message) showMessage(message);
}

// Google is offered only when the server says it is configured; a button that
// dead-ends in a 404 is worse than no button.
async function mountGoogle() {
  try {
    const { google } = await api('/api/auth/providers');
    if (!google) return;
    const link = document.getElementById('google-btn');
    // Carries ?next= through Google, so a guest sent to sign in from a room
    // page comes back to that page rather than to their trips.
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      link.setAttribute('href', `/api/auth/google?next=${encodeURIComponent(next)}`);
    }
    document.getElementById('google-row').hidden = false;
  } catch {
    // Leave the button hidden: password sign-in still works.
  }
}

if (!isOwnerPortal) {
  document.getElementById('toggle').addEventListener('click', () => setMode(!registering));
  setMode(false);
  showRedirectError();
  mountGoogle();
} else {
  document.getElementById('use-recovery').addEventListener('click', () => {
    const row = document.getElementById('recovery-row');
    row.hidden = !row.hidden;
    document.getElementById('totpCode').required = row.hidden;
  });
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    if (registering) {
      await api('/api/auth/register', {
        method: 'POST',
        body: {
          email,
          password,
          name: document.getElementById('name').value,
          phone: document.getElementById('phone').value,
        },
      });
    } else {
      const body = { email, password, portal };
      if (isOwnerPortal) {
        const code = document.getElementById('totpCode').value.trim();
        const recovery = document.getElementById('recoveryCode').value.trim();
        if (code) body.totpCode = code;
        if (recovery) body.recoveryCode = recovery;
      }
      await api('/api/auth/login', { method: 'POST', body });
    }
    window.location.href = safeNext(home);
  } catch (err) {
    // A second factor is needed: reveal the code field rather than treating
    // this as a failure.
    if (isOwnerPortal && err.totpRequired) {
      document.getElementById('totp-row').hidden = false;
      document.getElementById('totpCode').focus();
    }
    showMessage(err.message);
  }
});

initPage().then((user) => {
  if (user) {
    window.location.replace(user.role === 'guest' ? '/bookings.html' : '/owner.html');
  }
});

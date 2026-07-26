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

function setMode(toRegistering) {
  registering = toRegistering;
  const title = document.getElementById('auth-title');
  const submit = document.getElementById('submit');
  const toggle = document.getElementById('toggle');
  const toggleText = document.getElementById('toggle-text');

  if (registering) {
    title.textContent = isOwnerPortal ? 'Create an owner account' : 'Create a guest account';
    submit.textContent = 'Create account';
    toggle.textContent = 'Sign in instead';
    toggleText.textContent = 'Already registered?';
  } else {
    title.textContent = isOwnerPortal ? 'Sign in to manage your properties' : 'Sign in to book';
    submit.textContent = 'Sign in';
    toggle.textContent = isOwnerPortal ? 'Create an owner account' : 'Create a guest account';
    toggleText.textContent = isOwnerPortal ? 'Want to list a property?' : 'New here?';
  }
  document.getElementById('name-row').hidden = !registering;
  document.getElementById('name').required = registering;
  document.getElementById('password').autocomplete = registering ? 'new-password' : 'current-password';
  showMessage('');
}

document.getElementById('toggle').addEventListener('click', () => setMode(!registering));

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    if (registering) {
      await api('/api/auth/register', {
        method: 'POST',
        body: { email, password, name: document.getElementById('name').value, role: portal },
      });
    } else {
      await api('/api/auth/login', { method: 'POST', body: { email, password, portal } });
    }
    window.location.href = safeNext(home);
  } catch (err) {
    showMessage(err.message);
  }
});

initPage().then((user) => {
  // Already signed in: send them straight to the right area.
  if (user) {
    window.location.replace(user.role === 'guest' ? '/bookings.html' : '/owner.html');
  }
});
setMode(false);

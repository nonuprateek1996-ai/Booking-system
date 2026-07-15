'use strict';

// All dynamic text is inserted via textContent / createTextNode — never
// innerHTML — so user-controlled strings can never become markup (XSS-safe).

const $ = (id) => document.getElementById(id);

let registering = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showMessage(text, isSuccess = false) {
  const el = $('message');
  el.textContent = text;
  el.className = isSuccess ? 'success' : '';
  el.hidden = !text;
}

function setSignedIn(user) {
  const signedIn = Boolean(user);
  $('auth-panel').hidden = signedIn;
  $('booking-panel').hidden = !signedIn;
  $('user-box').hidden = !signedIn;
  if (signedIn) {
    $('user-name').textContent = user.name;
    loadResources();
    loadBookings();
  }
}

function toggleAuthMode() {
  registering = !registering;
  $('auth-title').textContent = registering ? 'Register' : 'Sign in';
  $('auth-submit').textContent = registering ? 'Register' : 'Sign in';
  $('auth-toggle').textContent = registering ? 'Sign in' : 'Register';
  $('auth-toggle-text').textContent = registering ? 'Already have an account?' : 'Need an account?';
  $('name-row').hidden = !registering;
  $('auth-name').required = registering;
  $('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  showMessage('');
}

async function loadResources() {
  const { resources } = await api('/api/resources');
  const select = $('resource-select');
  select.replaceChildren();
  for (const r of resources) {
    const opt = document.createElement('option');
    opt.value = String(r.id);
    opt.textContent = r.description ? `${r.name} — ${r.description}` : r.name;
    select.appendChild(opt);
  }
  refreshSlots();
}

async function refreshSlots() {
  const resourceId = $('resource-select').value;
  const date = $('date-input').value;
  const select = $('slot-select');
  select.replaceChildren();
  if (!resourceId || !date) return;
  try {
    const { slots } = await api(
      `/api/resources/${encodeURIComponent(resourceId)}/availability?date=${encodeURIComponent(date)}`
    );
    for (const s of slots) {
      const opt = document.createElement('option');
      opt.value = s.slot;
      opt.textContent = s.available ? s.slot : `${s.slot} (booked)`;
      opt.disabled = !s.available;
      select.appendChild(opt);
    }
  } catch (err) {
    showMessage(err.message);
  }
}

async function loadBookings() {
  const { bookings } = await api('/api/bookings');
  const list = $('bookings-list');
  list.replaceChildren();
  $('no-bookings').hidden = bookings.length > 0;
  for (const b of bookings) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${b.resource} — ${b.date} at ${b.slot}`;
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.className = 'link-btn';
    cancel.addEventListener('click', async () => {
      try {
        await api(`/api/bookings/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
        showMessage('Booking cancelled.', true);
        loadBookings();
        refreshSlots();
      } catch (err) {
        showMessage(err.message);
      }
    });
    li.append(label, cancel);
    list.appendChild(li);
  }
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = {
      email: $('auth-email').value,
      password: $('auth-password').value,
    };
    if (registering) body.name = $('auth-name').value;
    const { user } = await api(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body,
    });
    $('auth-form').reset();
    showMessage('');
    setSignedIn(user);
  } catch (err) {
    showMessage(err.message);
  }
});

$('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/bookings', {
      method: 'POST',
      body: {
        resourceId: Number($('resource-select').value),
        date: $('date-input').value,
        slot: $('slot-select').value,
      },
    });
    showMessage('Booking confirmed.', true);
    loadBookings();
    refreshSlots();
  } catch (err) {
    showMessage(err.message);
  }
});

$('auth-toggle').addEventListener('click', toggleAuthMode);
$('resource-select').addEventListener('change', refreshSlots);
$('date-input').addEventListener('change', refreshSlots);

$('logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    /* session may already be gone; sign out locally regardless */
  }
  setSignedIn(null);
});

// Constrain the date picker to the valid booking window.
(function initDateBounds() {
  const input = $('date-input');
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const max = new Date(today.getTime() + 90 * 86400000);
  input.min = fmt(today);
  input.max = fmt(max);
  input.value = fmt(today);
})();

// Restore an existing session on page load.
api('/api/auth/me')
  .then(({ user }) => setSignedIn(user))
  .catch(() => setSignedIn(null));

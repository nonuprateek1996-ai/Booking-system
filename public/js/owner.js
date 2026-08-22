'use strict';

import { api, el, money, formatDate, showMessage, initPage } from './common.js';
import { initCalendar, loadCalendar } from './calendar.js';

const STATUS_LABEL = {
  pending: 'Pending',
  approved: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled by guest',
};

// --- Tabs ---

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('active', button === tab);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.id !== `panel-${tab.dataset.tab}`;
  }
  showMessage('');
  // The calendar measures its own columns, which it cannot do while hidden,
  // so it is redrawn each time the tab comes back into view.
  if (tab.dataset.tab === 'calendar') loadCalendar();
});

// --- Booking requests ---

function bookingCard(b, reload) {
  const noteInput = el('input', { type: 'text', maxlength: 500, placeholder: 'Note to the guest (optional)' });

  const decide = async (action) => {
    try {
      await api(`/api/owner/bookings/${b.id}/${action}`, { method: 'POST', body: { note: noteInput.value } });
      showMessage(action === 'approve' ? 'Booking confirmed — the guest has been emailed.' : 'Request declined.', 'success');
      reload();
      // A decision changes which nights are held, so the calendar is stale now.
      loadCalendar();
    } catch (err) {
      showMessage(err.message);
    }
  };

  return el(
    'div',
    { className: 'card booking-request' },
    el(
      'div',
      { className: 'request-head' },
      el('h3', {}, b.room, el('span', { className: `badge status-${b.status}` }, STATUS_LABEL[b.status] ?? b.status)),
      el('strong', {}, money(b.totalPrice))
    ),
    el('p', {}, `${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} · ${b.guests} guest${b.guests === 1 ? '' : 's'}`),
    el('p', { className: 'hint' }, `${b.guestName} · ${b.guestEmail}${b.guestPhone ? ` · ${b.guestPhone}` : ''}`),
    b.guestNote && el('p', {}, `“${b.guestNote}”`),
    b.ownerNote && el('p', { className: 'hint' }, `Your note: ${b.ownerNote}`),
    b.status === 'pending' &&
      el(
        'div',
        { className: 'request-actions' },
        noteInput,
        el('button', { type: 'button', className: 'approve-btn', onClick: () => decide('approve') }, 'Approve'),
        el('button', { type: 'button', className: 'danger-btn', onClick: () => decide('decline') }, 'Decline')
      )
  );
}

async function loadBookings() {
  try {
    const [{ bookings, pendingCount }, { transports }] = await Promise.all([
      api('/api/owner/bookings'),
      api('/api/owner/notifications'),
    ]);

    const badge = document.getElementById('pending-badge');
    badge.hidden = pendingCount === 0;
    badge.textContent = String(pendingCount);

    // Be explicit about which alert channels are actually live.
    const channels = [];
    if (transports.email) channels.push('email');
    if (transports.whatsapp) channels.push(transports.whatsappTemplate ? 'WhatsApp' : 'WhatsApp (text only)');
    document.getElementById('transport-note').textContent = channels.length
      ? `New requests alert you by ${channels.join(' and ')}.`
      : 'Email and WhatsApp are not configured yet, so requests appear here only.';

    document.getElementById('no-bookings').hidden = bookings.length > 0;
    document.getElementById('bookings').replaceChildren(...bookings.map((b) => bookingCard(b, loadBookings)));
  } catch (err) {
    showMessage(err.message);
  }
}

// --- Rooms ---

function photoStrip(imageIds, reload) {
  return el(
    'div',
    { className: 'photo-strip' },
    imageIds.map((id) =>
      el(
        'div',
        { className: 'photo' },
        el('img', { src: `/api/images/${id}`, alt: '', loading: 'lazy' }),
        el(
          'button',
          {
            className: 'photo-delete',
            type: 'button',
            title: 'Delete photo',
            onClick: async () => {
              try {
                await api(`/api/owner/images/${id}`, { method: 'DELETE' });
                reload();
              } catch (err) {
                showMessage(err.message);
              }
            },
          },
          '×'
        )
      )
    )
  );
}

function uploadInput(url, reload) {
  return el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        showMessage('Photos must be 2 MB or smaller.');
        e.target.value = '';
        return;
      }
      try {
        await api(url, { method: 'POST', raw: file });
        showMessage('Photo added.', 'success');
        reload();
      } catch (err) {
        showMessage(err.message);
      } finally {
        e.target.value = '';
      }
    },
  });
}

function roomCard(room, reload) {
  const inputs = {
    name: el('input', { type: 'text', value: room.name, required: true, maxlength: 80 }),
    pricePerNight: el('input', { type: 'number', value: room.pricePerNight, required: true, min: 1, step: 1 }),
    maxGuests: el('input', { type: 'number', value: room.maxGuests, required: true, min: 1, max: 50 }),
  };
  const description = el('textarea', { rows: 2, maxlength: 2000 });
  description.value = room.description;

  return el(
    'div',
    { className: 'card owner-property' },
    el(
      'div',
      { className: 'owner-property-head' },
      el('div', {}, el('h2', {}, room.name), el('p', { className: 'card-location' }, `${money(room.pricePerNight)} / night · sleeps ${room.maxGuests}`)),
      el(
        'div',
        { className: 'owner-actions' },
        el('span', { className: room.published ? 'badge live' : 'badge' }, room.published ? 'Published' : 'Hidden'),
        el(
          'button',
          {
            type: 'button',
            className: 'link-btn',
            onClick: async () => {
              try {
                await api(`/api/owner/rooms/${room.id}`, { method: 'PATCH', body: { published: !room.published } });
                reload();
              } catch (err) {
                showMessage(err.message);
              }
            },
          },
          room.published ? 'Unpublish' : 'Publish'
        ),
        el('a', { className: 'link-btn', href: `/room.html?id=${room.id}` }, 'View'),
        el(
          'button',
          {
            type: 'button',
            className: 'link-btn danger',
            onClick: async () => {
              if (!window.confirm(`Delete “${room.name}” permanently?`)) return;
              try {
                await api(`/api/owner/rooms/${room.id}`, { method: 'DELETE' });
                showMessage('Room deleted.', 'success');
                reload();
              } catch (err) {
                showMessage(err.message);
              }
            },
          },
          'Delete'
        )
      )
    ),
    el(
      'form',
      {
        className: 'grid-form',
        onSubmit: async (e) => {
          e.preventDefault();
          try {
            await api(`/api/owner/rooms/${room.id}`, {
              method: 'PATCH',
              body: {
                name: inputs.name.value,
                pricePerNight: Number(inputs.pricePerNight.value),
                maxGuests: Number(inputs.maxGuests.value),
                description: description.value,
              },
            });
            showMessage('Room updated.', 'success');
            reload();
          } catch (err) {
            showMessage(err.message);
          }
        },
      },
      el('label', {}, 'Room name', inputs.name),
      el('label', {}, 'Price per night (₹)', inputs.pricePerNight),
      el('label', {}, 'Sleeps', inputs.maxGuests),
      el('label', { className: 'full' }, 'Description', description),
      el('div', { className: 'full form-actions' }, el('button', { type: 'submit' }, 'Save changes'))
    ),
    el(
      'section',
      { className: 'sub' },
      el('h3', {}, `Photos (${room.imageIds.length}/20)`),
      room.imageIds.length > 0 ? photoStrip(room.imageIds, reload) : el('p', { className: 'hint' }, 'No photos yet.'),
      uploadInput(`/api/owner/rooms/${room.id}/images`, reload)
    )
  );
}

async function loadRooms() {
  try {
    const { rooms } = await api('/api/owner/rooms');
    document.getElementById('no-rooms').hidden = rooms.length > 0;
    document.getElementById('rooms').replaceChildren(...rooms.map((r) => roomCard(r, loadRooms)));
  } catch (err) {
    showMessage(err.message);
  }
}

document.getElementById('new-room-btn').addEventListener('click', () => {
  const card = document.getElementById('new-room-card');
  card.hidden = !card.hidden;
});
document.getElementById('new-room-cancel').addEventListener('click', () => {
  document.getElementById('new-room-card').hidden = true;
});
document.getElementById('new-room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/owner/rooms', {
      method: 'POST',
      body: {
        name: document.getElementById('new-name').value,
        pricePerNight: Number(document.getElementById('new-price').value),
        maxGuests: Number(document.getElementById('new-guests').value),
        description: document.getElementById('new-description').value,
      },
    });
    e.target.reset();
    document.getElementById('new-room-card').hidden = true;
    showMessage('Room created. Add photos below.', 'success');
    loadRooms();
  } catch (err) {
    showMessage(err.message);
  }
});

// --- The place ---

async function loadProperty() {
  try {
    const { property, imageIds } = await api('/api/property');
    const set = (id, value) => {
      document.getElementById(id).value = value ?? '';
    };
    set('p-name', property.name);
    set('p-location', property.location);
    set('p-tagline', property.tagline);
    set('p-about', property.about);
    set('p-address', property.address);
    set('p-contact-name', property.contactName);
    set('p-contact-email', property.contactEmail);
    set('p-contact-phone', property.contactPhone);
    set('p-check-in', property.checkInTime);
    set('p-check-out', property.checkOutTime);
    set('p-house-rules', property.houseRules);

    const strip = document.getElementById('property-photos');
    strip.replaceChildren(
      imageIds.length > 0
        ? photoStrip(imageIds, loadProperty)
        : el('p', { className: 'hint' }, 'No photos of the place yet.')
    );
  } catch (err) {
    showMessage(err.message);
  }
}

document.getElementById('property-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = (id) => document.getElementById(id).value;
  try {
    await api('/api/owner/property', {
      method: 'PATCH',
      body: {
        name: value('p-name'),
        location: value('p-location'),
        tagline: value('p-tagline'),
        about: value('p-about'),
        address: value('p-address'),
        contactName: value('p-contact-name'),
        contactEmail: value('p-contact-email'),
        contactPhone: value('p-contact-phone'),
        checkInTime: value('p-check-in'),
        checkOutTime: value('p-check-out'),
        houseRules: value('p-house-rules'),
      },
    });
    showMessage('Saved.', 'success');
  } catch (err) {
    showMessage(err.message);
  }
});

document
  .getElementById('property-photo-input')
  .replaceWith(uploadInput('/api/owner/property/images', loadProperty));

// --- Security ---

function showRecoveryCodes(codes) {
  const box = document.getElementById('recovery-display');
  box.hidden = false;
  document.getElementById('recovery-list').replaceChildren(
    ...codes.map((c) => el('li', {}, el('code', {}, c)))
  );
}

async function loadSecurity() {
  try {
    const data = await api('/api/auth/security');
    document.getElementById('twofa-off').hidden = data.twoFactorEnabled;
    document.getElementById('twofa-on').hidden = !data.twoFactorEnabled;
    document.getElementById('twofa-state').textContent = data.twoFactorEnabled
      ? 'Two-factor authentication is on.'
      : 'Two-factor authentication is off.';
    document.getElementById('recovery-count').textContent =
      `${data.unusedRecoveryCodes} unused recovery code(s) remaining.`;

    document.getElementById('sessions').replaceChildren(
      ...data.sessions.map((s) =>
        el(
          'div',
          { className: 'session-row' },
          el('span', {}, s.current ? 'This device' : 'Other device'),
          el('span', { className: 'hint' }, `${s.ip || 'unknown IP'} · ${s.userAgent.slice(0, 60) || 'unknown device'}`),
          el('span', { className: 'hint' }, `last seen ${new Date(s.lastSeenAt).toLocaleString()}`),
          !s.current &&
            el(
              'button',
              {
                type: 'button',
                className: 'link-btn danger',
                onClick: async () => {
                  try {
                    await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
                    showMessage('Device signed out.', 'success');
                    loadSecurity();
                  } catch (err) {
                    showMessage(err.message);
                  }
                },
              },
              'Sign out'
            )
        )
      )
    );

    document.getElementById('audit').replaceChildren(
      ...data.recentAttempts.map((a) =>
        el(
          'div',
          { className: 'session-row' },
          el('span', { className: a.outcome === 'success' ? '' : 'danger' }, a.outcome),
          el('span', { className: 'hint' }, a.ip || 'unknown IP'),
          el('span', { className: 'hint' }, a.createdAt)
        )
      )
    );
  } catch (err) {
    showMessage(err.message);
  }
}

document.getElementById('twofa-start').addEventListener('click', async () => {
  try {
    const { secret, uri } = await api('/api/auth/2fa/setup', { method: 'POST', body: {} });
    document.getElementById('twofa-setup').hidden = false;
    document.getElementById('twofa-secret').textContent = secret;
    const link = document.getElementById('twofa-uri');
    link.href = uri;
  } catch (err) {
    showMessage(err.message);
  }
});

document.getElementById('twofa-enable-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { recoveryCodes } = await api('/api/auth/2fa/enable', {
      method: 'POST',
      body: { code: document.getElementById('twofa-code').value },
    });
    showMessage('Two-factor authentication is on.', 'success');
    showRecoveryCodes(recoveryCodes);
    loadSecurity();
  } catch (err) {
    showMessage(err.message);
  }
});

document.getElementById('twofa-disable-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/2fa/disable', {
      method: 'POST',
      body: { password: document.getElementById('twofa-password').value },
    });
    e.target.reset();
    showMessage('Two-factor authentication is off.', 'success');
    loadSecurity();
  } catch (err) {
    showMessage(err.message);
  }
});

document.getElementById('recovery-regen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { recoveryCodes } = await api('/api/auth/2fa/recovery-codes', {
      method: 'POST',
      body: { password: document.getElementById('recovery-password').value },
    });
    e.target.reset();
    showRecoveryCodes(recoveryCodes);
    loadSecurity();
  } catch (err) {
    showMessage(err.message);
  }
});

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: {
        currentPassword: document.getElementById('current-password').value,
        newPassword: document.getElementById('new-password').value,
      },
    });
    e.target.reset();
    showMessage('Password changed. Other devices were signed out.', 'success');
    loadSecurity();
  } catch (err) {
    showMessage(err.message);
  }
});

document.getElementById('revoke-others').addEventListener('click', async () => {
  try {
    await api('/api/auth/sessions/revoke-others', { method: 'POST', body: {} });
    showMessage('All other devices were signed out.', 'success');
    loadSecurity();
  } catch (err) {
    showMessage(err.message);
  }
});

initPage().then((user) => {
  if (!user) {
    window.location.replace('/owner-login.html?next=/owner.html');
    return;
  }
  if (user.role === 'guest') {
    window.location.replace('/bookings.html');
    return;
  }
  initCalendar({ onDecision: loadBookings });
  loadCalendar();
  loadBookings();
  loadRooms();
  loadProperty();
  loadSecurity();
});

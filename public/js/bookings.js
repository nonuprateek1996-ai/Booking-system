'use strict';

import { api, el, money, formatDate, showMessage, initPage } from './common.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');

const STATUS_LABEL = {
  pending: 'Awaiting owner approval',
  approved: 'Confirmed',
  declined: 'Declined by owner',
  cancelled: 'Cancelled',
};

function tripCard(b, property, reload) {
  const media = b.coverImageId
    ? el('img', { className: 'trip-image', src: `/api/images/${b.coverImageId}`, alt: '', loading: 'lazy' })
    : el('div', { className: 'trip-image placeholder' }, 'No photo');

  const live = b.status === 'pending' || b.status === 'approved';

  // Contact details and arrival times matter once a stay is real.
  const hostLines =
    b.status === 'approved'
      ? [
          property.contactName && `Host: ${property.contactName}`,
          property.contactPhone && `Phone: ${property.contactPhone}`,
          property.contactEmail && `Email: ${property.contactEmail}`,
          property.address && `Address: ${property.address}`,
          `Check in from ${property.checkInTime} · check out by ${property.checkOutTime}`,
        ].filter(Boolean)
      : [];

  return el(
    'div',
    { className: 'card trip' },
    media,
    el(
      'div',
      { className: 'trip-body' },
      el(
        'h2',
        {},
        el('a', { href: `/room.html?id=${encodeURIComponent(b.roomId)}` }, b.room),
        el('span', { className: `badge status-${b.status}` }, STATUS_LABEL[b.status] ?? b.status)
      ),
      el('p', {}, `${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} · ${b.guests} guest${b.guests === 1 ? '' : 's'}`),
      el('p', {}, el('strong', {}, money(b.totalPrice)), ' total'),
      b.guestNote && el('p', { className: 'hint' }, `Your message: ${b.guestNote}`),
      b.ownerNote && el('p', { className: 'hint' }, `From the owner: ${b.ownerNote}`),
      ...hostLines.map((line) => el('p', { className: 'hint' }, line)),
      live &&
        el(
          'button',
          {
            className: 'danger-btn',
            type: 'button',
            onClick: async () => {
              try {
                await api(`/api/bookings/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
                showMessage(b.status === 'pending' ? 'Request withdrawn.' : 'Booking cancelled.', 'success');
                reload();
              } catch (err) {
                showMessage(err.message);
              }
            },
          },
          b.status === 'pending' ? 'Withdraw request' : 'Cancel booking'
        )
    )
  );
}

async function load() {
  try {
    const { bookings, property } = await api('/api/bookings');
    list.replaceChildren(...bookings.map((b) => tripCard(b, property, load)));
    empty.hidden = bookings.length > 0;
  } catch (err) {
    showMessage(err.message);
  }
}

initPage().then((user) => {
  if (!user) {
    window.location.replace('/login.html?next=/bookings.html');
    return;
  }
  if (user.role !== 'guest') {
    window.location.replace('/owner.html');
    return;
  }
  load();
});

'use strict';

import { api, el, money, formatDate, showMessage, initPage } from './common.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');

function tripCard(b, reload) {
  const media = b.coverImageId
    ? el('img', { className: 'trip-image', src: `/api/images/${b.coverImageId}`, alt: '', loading: 'lazy' })
    : el('div', { className: 'trip-image placeholder' }, 'No photo');

  const contactLines = [
    b.contactName && `Host: ${b.contactName}`,
    b.contactPhone && `Phone: ${b.contactPhone}`,
    b.contactEmail && `Email: ${b.contactEmail}`,
  ].filter(Boolean);

  return el(
    'div',
    { className: 'card trip' },
    media,
    el(
      'div',
      { className: 'trip-body' },
      el('h2', {}, el('a', { href: `/property.html?id=${encodeURIComponent(b.propertyId)}` }, b.property)),
      el('p', { className: 'card-location' }, b.location),
      el('p', {}, `${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} · ${b.guests} guest${b.guests === 1 ? '' : 's'}`),
      el('p', {}, el('strong', {}, money(b.totalPrice)), ' total'),
      ...contactLines.map((line) => el('p', { className: 'hint' }, line)),
      el(
        'button',
        {
          className: 'danger-btn',
          type: 'button',
          onClick: async () => {
            try {
              await api(`/api/bookings/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
              showMessage('Booking cancelled.', 'success');
              reload();
            } catch (err) {
              showMessage(err.message);
            }
          },
        },
        'Cancel booking'
      )
    )
  );
}

async function load() {
  try {
    const { bookings } = await api('/api/bookings');
    list.replaceChildren(...bookings.map((b) => tripCard(b, load)));
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

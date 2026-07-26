'use strict';

import {
  api, el, money, formatDate, nightsBetween, todayIso, showMessage, initPage,
} from './common.js';

const propertyId = new URLSearchParams(window.location.search).get('id');
let property = null;
let user = null;

function renderGallery(imageIds, title) {
  const gallery = document.getElementById('gallery');
  if (imageIds.length === 0) {
    gallery.append(el('div', { className: 'gallery-main placeholder' }, 'No photos yet'));
    return;
  }
  const main = el('img', {
    className: 'gallery-main',
    src: `/api/images/${imageIds[0]}`,
    alt: `Photo of ${title}`,
  });
  gallery.append(main);
  if (imageIds.length > 1) {
    gallery.append(
      el(
        'div',
        { className: 'thumbs' },
        imageIds.map((id) =>
          el('img', {
            className: 'thumb',
            src: `/api/images/${id}`,
            alt: `Photo of ${title}`,
            loading: 'lazy',
            onClick: () => {
              main.src = `/api/images/${id}`;
            },
          })
        )
      )
    );
  }
}

function updateTotal() {
  const checkIn = document.getElementById('checkIn').value;
  const checkOut = document.getElementById('checkOut').value;
  const total = document.getElementById('total');
  if (!checkIn || !checkOut) {
    total.textContent = '';
    return;
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) {
    total.textContent = 'Check-out must be after check-in.';
    return;
  }
  total.textContent = `${nights} night${nights === 1 ? '' : 's'} · ${money(
    property.pricePerNight * nights
  )} total`;
}

function setupBookingForm() {
  const form = document.getElementById('booking-form');
  const hint = document.getElementById('book-hint');
  const guests = document.getElementById('guests');
  guests.max = String(property.maxGuests);

  const checkIn = document.getElementById('checkIn');
  const checkOut = document.getElementById('checkOut');
  checkIn.min = todayIso();
  checkOut.min = todayIso();
  checkIn.addEventListener('change', () => {
    checkOut.min = checkIn.value || todayIso();
    updateTotal();
  });
  checkOut.addEventListener('change', updateTotal);

  // Owners and signed-out visitors see the listing but cannot book here.
  if (!user) {
    form.querySelector('button').disabled = true;
    hint.replaceChildren(
      el('a', { href: `/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}` },
        'Sign in as a guest'),
      ' to book this place.'
    );
    return;
  }
  if (user.role !== 'guest') {
    form.querySelector('button').disabled = true;
    hint.textContent = 'You are signed in as an owner. Bookings are made from a guest account.';
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { booking } = await api('/api/bookings', {
        method: 'POST',
        body: {
          propertyId: Number(propertyId),
          checkIn: checkIn.value,
          checkOut: checkOut.value,
          guests: Number(guests.value),
        },
      });
      showMessage(
        `Booked — ${booking.nights} night${booking.nights === 1 ? '' : 's'} for ${money(booking.totalPrice)}.`,
        'success'
      );
      window.setTimeout(() => {
        window.location.href = '/bookings.html';
      }, 1200);
    } catch (err) {
      showMessage(err.message);
    }
  });
}

async function load() {
  user = await initPage();

  if (!propertyId) {
    showMessage('No property specified.');
    return;
  }

  try {
    const { property: p, rooms, imageIds, booked } = await api(
      `/api/properties/${encodeURIComponent(propertyId)}`
    );
    property = p;

    document.title = `${p.title} — Staylist`;
    document.getElementById('title').textContent = p.title;
    document.getElementById('location').textContent = p.location;
    document.getElementById('description').textContent = p.description || 'No description provided.';
    document.getElementById('price').replaceChildren(
      el('strong', {}, money(p.pricePerNight)),
      ` per night · sleeps ${p.maxGuests}`
    );

    renderGallery(imageIds, p.title);

    if (rooms.length > 0) {
      document.getElementById('rooms-section').hidden = false;
      document.getElementById('rooms').replaceChildren(
        ...rooms.map((r) =>
          el('li', {}, el('strong', {}, r.name), r.description ? ` — ${r.description}` : '')
        )
      );
    }

    if (booked.length > 0) {
      document.getElementById('booked-section').hidden = false;
      document.getElementById('booked').replaceChildren(
        ...booked.map((b) =>
          el('li', {}, `${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}`)
        )
      );
    }

    const hasContact = p.contactName || p.contactEmail || p.contactPhone;
    document.getElementById('contact-name').textContent = p.contactName || '';
    document.getElementById('contact-phone').textContent = p.contactPhone || '';
    if (p.contactEmail) {
      document
        .getElementById('contact-email')
        .replaceChildren(el('a', { href: `mailto:${p.contactEmail}` }, p.contactEmail));
    }
    document.getElementById('contact-none').hidden = Boolean(hasContact);

    setupBookingForm();
  } catch (err) {
    showMessage(err.message);
  }
}

load();

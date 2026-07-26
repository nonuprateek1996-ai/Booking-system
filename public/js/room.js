'use strict';

import {
  api, el, money, formatDate, nightsBetween, todayIso, showMessage, initPage,
} from './common.js';

const query = new URLSearchParams(window.location.search);
const roomId = query.get('id');
let room = null;
let user = null;

function renderGallery(imageIds, name) {
  const gallery = document.getElementById('gallery');
  if (imageIds.length === 0) {
    gallery.append(el('div', { className: 'gallery-main placeholder' }, 'No photos yet'));
    return;
  }
  const main = el('img', { className: 'gallery-main', src: `/api/images/${imageIds[0]}`, alt: `Photo of ${name}` });
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
            alt: `Photo of ${name}`,
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
  total.textContent = `${nights} night${nights === 1 ? '' : 's'} · ${money(room.pricePerNight * nights)} total`;
}

function setupBookingForm() {
  const form = document.getElementById('booking-form');
  const hint = document.getElementById('book-hint');
  const button = document.getElementById('book-btn');
  const guests = document.getElementById('guests');
  guests.max = String(room.maxGuests);

  const checkIn = document.getElementById('checkIn');
  const checkOut = document.getElementById('checkOut');
  checkIn.min = todayIso();
  checkOut.min = todayIso();
  checkIn.addEventListener('change', () => {
    checkOut.min = checkIn.value || todayIso();
    updateTotal();
  });
  checkOut.addEventListener('change', updateTotal);

  // Dates carried over from the availability search arrive pre-filled.
  const fromSearch = { checkIn: query.get('checkIn'), checkOut: query.get('checkOut') };
  if (fromSearch.checkIn && fromSearch.checkOut) {
    checkIn.value = fromSearch.checkIn;
    checkOut.value = fromSearch.checkOut;
    checkOut.min = fromSearch.checkIn;
    updateTotal();
  }

  if (!user) {
    button.disabled = true;
    hint.replaceChildren(
      el(
        'a',
        { href: `/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}` },
        'Sign in as a guest'
      ),
      ' to request this room.'
    );
    return;
  }
  if (user.role !== 'guest') {
    button.disabled = true;
    hint.textContent = 'You are signed in as the owner. Bookings are requested from a guest account.';
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    try {
      await api('/api/bookings', {
        method: 'POST',
        body: {
          roomId: Number(roomId),
          checkIn: checkIn.value,
          checkOut: checkOut.value,
          guests: Number(guests.value),
          note: document.getElementById('note').value,
        },
      });
      showMessage('Request sent — the owner has been notified and will confirm it shortly.', 'success');
      window.setTimeout(() => {
        window.location.href = '/bookings.html';
      }, 1400);
    } catch (err) {
      showMessage(err.message);
      button.disabled = false;
    }
  });
}

async function load() {
  user = await initPage();
  if (!roomId) {
    showMessage('No room specified.');
    return;
  }

  try {
    const [roomData, propertyData] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomId)}`),
      api('/api/property'),
    ]);
    const { room: r, imageIds, booked } = roomData;
    const { property } = propertyData;
    room = r;

    document.title = `${r.name} — ${property.name}`;
    document.getElementById('brand-name').textContent = property.name;
    document.getElementById('room-name').textContent = r.name;
    document.getElementById('room-sleeps').textContent = `Sleeps ${r.maxGuests} · ${property.location}`;
    document.getElementById('room-description').textContent = r.description || 'No description provided.';
    document.getElementById('price').replaceChildren(el('strong', {}, money(r.pricePerNight)), ' per night');

    renderGallery(imageIds, r.name);

    if (booked.length > 0) {
      document.getElementById('booked-section').hidden = false;
      document.getElementById('booked').replaceChildren(
        ...booked.map((b) => el('li', {}, `${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}`))
      );
    }

    document.getElementById('contact-name').textContent = property.contactName;
    document.getElementById('contact-phone').textContent = property.contactPhone;
    if (property.contactEmail) {
      document
        .getElementById('contact-email')
        .replaceChildren(el('a', { href: `mailto:${property.contactEmail}` }, property.contactEmail));
    }

    setupBookingForm();
  } catch (err) {
    showMessage(err.message);
  }
}

load();

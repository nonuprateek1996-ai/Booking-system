'use strict';

import { api, el, money, showMessage, initPage, todayIso } from './common.js';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const count = document.getElementById('results-count');
const FIELDS = ['q', 'checkIn', 'checkOut', 'guests', 'maxPrice'];

function propertyCard(p) {
  const media = p.coverImageId
    ? el('img', {
        className: 'card-image',
        src: `/api/images/${p.coverImageId}`,
        alt: `Photo of ${p.title}`,
        loading: 'lazy',
      })
    : el('div', { className: 'card-image placeholder' }, 'No photo yet');

  // Carry the chosen dates into the listing so the booking form is pre-filled.
  const link = new URLSearchParams({ id: String(p.id) });
  const checkIn = document.getElementById('checkIn').value;
  const checkOut = document.getElementById('checkOut').value;
  if (checkIn && checkOut) {
    link.set('checkIn', checkIn);
    link.set('checkOut', checkOut);
  }

  return el(
    'a',
    { className: 'card', href: `/property.html?${link.toString()}` },
    media,
    el(
      'div',
      { className: 'card-body' },
      el('h2', { className: 'card-title' }, p.title),
      el('p', { className: 'card-location' }, p.location),
      el(
        'p',
        { className: 'card-price' },
        el('strong', {}, money(p.pricePerNight)),
        ' per night · sleeps ',
        String(p.maxGuests)
      ),
      p.stayTotal !== undefined &&
        el(
          'p',
          { className: 'card-total' },
          `${money(p.stayTotal)} for ${p.nights} night${p.nights === 1 ? '' : 's'}`
        )
    )
  );
}

async function load() {
  const params = new URLSearchParams();
  for (const id of FIELDS) {
    const value = document.getElementById(id).value.trim();
    if (value !== '') params.set(id, value);
  }

  // Keep the URL shareable: a search can be linked or reloaded.
  const query = params.toString();
  window.history.replaceState(null, '', query ? `/?${query}` : '/');

  try {
    const { properties, nights } = await api(`/api/properties?${query}`);
    grid.replaceChildren(...properties.map(propertyCard));
    empty.hidden = properties.length > 0;
    if (properties.length === 0) {
      count.textContent = '';
    } else {
      const noun = properties.length === 1 ? 'property' : 'properties';
      count.textContent = nights
        ? `${properties.length} ${noun} free for your ${nights} night${nights === 1 ? '' : 's'}`
        : `${properties.length} ${noun} available`;
    }
    showMessage('');
  } catch (err) {
    showMessage(err.message);
    grid.replaceChildren();
    count.textContent = '';
  }
}

const checkInInput = document.getElementById('checkIn');
const checkOutInput = document.getElementById('checkOut');

checkInInput.min = todayIso();
checkOutInput.min = todayIso();
checkInInput.addEventListener('change', () => {
  checkOutInput.min = checkInInput.value || todayIso();
  // Nudge check-out past check-in rather than leaving an impossible range.
  if (checkOutInput.value && checkOutInput.value <= checkInInput.value) {
    const next = new Date(`${checkInInput.value}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    checkOutInput.value = next.toISOString().slice(0, 10);
  }
});

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  load();
});

// Restore a search from the URL so links and reloads keep their filters.
const initial = new URLSearchParams(window.location.search);
for (const id of FIELDS) {
  const value = initial.get(id);
  if (value) document.getElementById(id).value = value;
}

initPage();
load();

'use strict';

import { api, el, money, showMessage, initPage, todayIso } from './common.js';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const count = document.getElementById('results-count');
const FIELDS = ['checkIn', 'checkOut', 'guests'];

const SECTION_LINKS = [
  { href: '#rooms', label: 'Rooms' },
  { href: '#about', label: 'The place' },
  { href: '#contact', label: 'Contact' },
];

// ---------- Hero background ----------

// The guesthouse's own photographs, crossfading slowly. Honours
// prefers-reduced-motion by holding a single still frame instead.
function mountHeroBackground(imageIds, name) {
  const host = document.getElementById('hero-bg');
  if (!host || imageIds.length === 0) return; // CSS gradient stands in

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ids = reduceMotion ? imageIds.slice(0, 1) : imageIds.slice(0, 6);

  const layers = ids.map((id, i) =>
    el('img', {
      src: `/api/images/${id}`,
      alt: i === 0 ? `${name}` : '',
      className: i === 0 ? 'active' : '',
      // Only the first image blocks the hero; the rest arrive lazily.
      loading: i === 0 ? 'eager' : 'lazy',
      'aria-hidden': i === 0 ? null : 'true',
    })
  );
  host.replaceChildren(...layers);

  if (reduceMotion || layers.length < 2) return;

  let current = 0;
  window.setInterval(() => {
    layers[current].classList.remove('active');
    current = (current + 1) % layers.length;
    layers[current].classList.add('active');
  }, 6500);
}

// ---------- Rooms ----------

function roomCard(room) {
  const media = room.coverImageId
    ? el('img', {
        className: 'card-image',
        src: `/api/images/${room.coverImageId}`,
        alt: `Photo of ${room.name}`,
        loading: 'lazy',
      })
    : el('div', { className: 'card-image placeholder' }, 'No photo yet');

  // Carry the chosen dates into the room page so the request form is prefilled.
  const link = new URLSearchParams({ id: String(room.id) });
  const checkIn = document.getElementById('checkIn').value;
  const checkOut = document.getElementById('checkOut').value;
  if (checkIn && checkOut) {
    link.set('checkIn', checkIn);
    link.set('checkOut', checkOut);
  }

  return el(
    'a',
    { className: 'card', href: `/room.html?${link.toString()}` },
    media,
    el(
      'div',
      { className: 'card-body' },
      el('h3', { className: 'card-title' }, room.name),
      room.description && el('p', { className: 'card-location' }, room.description),
      el(
        'p',
        { className: 'card-price' },
        el('strong', {}, money(room.pricePerNight)),
        ' per night · sleeps ',
        String(room.maxGuests)
      ),
      room.stayTotal !== undefined &&
        el(
          'p',
          { className: 'card-total' },
          `${money(room.stayTotal)} for ${room.nights} night${room.nights === 1 ? '' : 's'}`
        )
    )
  );
}

function renderGallery(imageIds, name) {
  const gallery = document.getElementById('gallery');
  if (!gallery || imageIds.length < 2) return;
  gallery.hidden = false;

  const main = el('img', {
    className: 'gallery-main',
    src: `/api/images/${imageIds[0]}`,
    alt: `Photo of ${name}`,
    loading: 'lazy',
  });
  gallery.replaceChildren(
    main,
    el(
      'div',
      { className: 'thumbs' },
      imageIds.map((id) =>
        el('img', {
          className: 'thumb',
          src: `/api/images/${id}`,
          alt: '',
          loading: 'lazy',
          onClick: () => {
            main.src = `/api/images/${id}`;
          },
        })
      )
    )
  );
}

async function loadProperty() {
  const { property, imageIds } = await api('/api/property');

  document.title = `${property.name} — book a room`;
  document.getElementById('brand-name').textContent = property.name;
  document.getElementById('foot-mark-name').textContent = property.name;

  // The heading reads as the reference does: name, then a lighter accent clause.
  const heading = document.getElementById('hero-heading');
  heading.replaceChildren(
    el('span', {}, property.name),
    property.tagline ? el('br', {}) : null,
    property.tagline ? el('span', { className: 'accent' }, property.tagline) : null
  );
  document.getElementById('hero-tagline').textContent =
    property.about ? property.about.split('. ')[0].replace(/\.$/, '') + '.' : '';
  document.getElementById('hero-place').textContent = property.location;

  document.getElementById('property-about').textContent = property.about || 'No description yet.';
  if (property.houseRules) {
    document.getElementById('house-rules-block').hidden = false;
    document.getElementById('house-rules').textContent = property.houseRules;
  }

  document.getElementById('contact-name').textContent = property.contactName;
  document.getElementById('contact-phone').textContent = property.contactPhone;
  if (property.contactEmail) {
    document
      .getElementById('contact-email')
      .replaceChildren(el('a', { href: `mailto:${property.contactEmail}` }, property.contactEmail));
  }
  document.getElementById('contact-address').textContent = property.address;
  document.getElementById('check-times').textContent =
    `Check in from ${property.checkInTime} · check out by ${property.checkOutTime}`;

  mountHeroBackground(imageIds, property.name);
  renderGallery(imageIds, property.name);
}

async function loadRooms({ scroll = false } = {}) {
  const params = new URLSearchParams();
  for (const id of FIELDS) {
    const value = document.getElementById(id).value.trim();
    if (value !== '') params.set(id, value);
  }
  const query = params.toString();
  window.history.replaceState(null, '', query ? `/?${query}` : '/');

  try {
    const { rooms, nights } = await api(`/api/rooms?${query}`);
    grid.replaceChildren(...rooms.map(roomCard));
    empty.hidden = rooms.length > 0;
    if (rooms.length === 0) {
      count.textContent = '';
    } else {
      const noun = rooms.length === 1 ? 'room' : 'rooms';
      count.textContent = nights
        ? `${rooms.length} ${noun} free for your ${nights} night${nights === 1 ? '' : 's'}`
        : `${rooms.length} ${noun}, booked individually`;
    }
    showMessage('');
    if (scroll) {
      document.getElementById('rooms').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    showMessage(err.message);
    grid.replaceChildren();
    count.textContent = '';
  }
}

// ---------- Date inputs ----------

const checkInInput = document.getElementById('checkIn');
const checkOutInput = document.getElementById('checkOut');
checkInInput.min = todayIso();
checkOutInput.min = todayIso();
checkInInput.addEventListener('change', () => {
  checkOutInput.min = checkInInput.value || todayIso();
  if (checkOutInput.value && checkOutInput.value <= checkInInput.value) {
    const next = new Date(`${checkInInput.value}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    checkOutInput.value = next.toISOString().slice(0, 10);
  }
});

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // Searching from the hero jumps to the results, which are below the fold.
  loadRooms({ scroll: true });
});

const initial = new URLSearchParams(window.location.search);
for (const id of FIELDS) {
  const value = initial.get(id);
  if (value) document.getElementById(id).value = value;
}

initPage(SECTION_LINKS);
loadProperty().catch((err) => showMessage(err.message));
loadRooms();

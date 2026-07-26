'use strict';

import { api, el, money, showMessage, initPage } from './common.js';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const count = document.getElementById('results-count');

function propertyCard(p) {
  const media = p.coverImageId
    ? el('img', {
        className: 'card-image',
        src: `/api/images/${p.coverImageId}`,
        alt: `Photo of ${p.title}`,
        loading: 'lazy',
      })
    : el('div', { className: 'card-image placeholder' }, 'No photo yet');

  return el(
    'a',
    { className: 'card', href: `/property.html?id=${encodeURIComponent(p.id)}` },
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
      )
    )
  );
}

async function load() {
  const params = new URLSearchParams();
  for (const id of ['q', 'guests', 'maxPrice']) {
    const value = document.getElementById(id).value.trim();
    if (value !== '') params.set(id, value);
  }

  try {
    const { properties } = await api(`/api/properties?${params.toString()}`);
    grid.replaceChildren(...properties.map(propertyCard));
    empty.hidden = properties.length > 0;
    count.textContent =
      properties.length > 0
        ? `${properties.length} ${properties.length === 1 ? 'property' : 'properties'} available`
        : '';
    showMessage('');
  } catch (err) {
    showMessage(err.message);
  }
}

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  load();
});

initPage();
load();

'use strict';

import { api, el, money, formatDate, showMessage, initPage } from './common.js';

const propertiesBox = document.getElementById('properties');
const emptyNote = document.getElementById('empty');

function field(labelText, input) {
  return el('label', {}, labelText, input);
}

// --- Photos ---

function photoSection(property, reload) {
  const strip = el(
    'div',
    { className: 'photo-strip' },
    property.imageIds.map((id) =>
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
                showMessage('Photo deleted.', 'success');
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

  const fileInput = el('input', {
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
        await api(`/api/owner/properties/${property.id}/images`, { method: 'POST', raw: file });
        showMessage('Photo added.', 'success');
        reload();
      } catch (err) {
        showMessage(err.message);
      } finally {
        e.target.value = '';
      }
    },
  });

  return el(
    'section',
    { className: 'sub' },
    el('h3', {}, `Photos (${property.imageIds.length}/20)`),
    property.imageIds.length > 0 ? strip : el('p', { className: 'hint' }, 'No photos yet.'),
    el('p', { className: 'hint' }, 'JPEG, PNG or WebP · up to 2 MB each'),
    fileInput
  );
}

// --- Rooms ---

function roomSection(property, reload) {
  const nameInput = el('input', { type: 'text', maxlength: 80, placeholder: 'Room name', required: true });
  const descInput = el('input', { type: 'text', maxlength: 2000, placeholder: 'Description (optional)' });

  const list = el(
    'ul',
    { className: 'rooms' },
    property.rooms.map((room) =>
      el(
        'li',
        {},
        el('strong', {}, room.name),
        room.description ? ` — ${room.description}` : '',
        el(
          'button',
          {
            className: 'link-btn danger',
            type: 'button',
            onClick: async () => {
              try {
                await api(`/api/owner/rooms/${room.id}`, { method: 'DELETE' });
                showMessage('Room removed.', 'success');
                reload();
              } catch (err) {
                showMessage(err.message);
              }
            },
          },
          'Remove'
        )
      )
    )
  );

  return el(
    'section',
    { className: 'sub' },
    el('h3', {}, 'Rooms'),
    property.rooms.length > 0 ? list : el('p', { className: 'hint' }, 'No rooms described yet.'),
    el(
      'form',
      {
        className: 'inline-form',
        onSubmit: async (e) => {
          e.preventDefault();
          try {
            await api(`/api/owner/properties/${property.id}/rooms`, {
              method: 'POST',
              body: { name: nameInput.value, description: descInput.value },
            });
            showMessage('Room added.', 'success');
            reload();
          } catch (err) {
            showMessage(err.message);
          }
        },
      },
      nameInput,
      descInput,
      el('button', { type: 'submit' }, 'Add room')
    )
  );
}

// --- Property details form ---

function detailsForm(property, reload) {
  const inputs = {
    title: el('input', { type: 'text', value: property.title, required: true, maxlength: 120 }),
    location: el('input', { type: 'text', value: property.location, required: true, maxlength: 120 }),
    pricePerNight: el('input', { type: 'number', value: property.pricePerNight, required: true, min: 1, step: 1 }),
    maxGuests: el('input', { type: 'number', value: property.maxGuests, required: true, min: 1, max: 50 }),
    contactName: el('input', { type: 'text', value: property.contactName, maxlength: 100 }),
    contactEmail: el('input', { type: 'email', value: property.contactEmail, maxlength: 254 }),
    contactPhone: el('input', { type: 'tel', value: property.contactPhone, maxlength: 20 }),
  };
  const description = el('textarea', { rows: 3, maxlength: 2000 });
  description.value = property.description;

  return el(
    'form',
    {
      className: 'grid-form',
      onSubmit: async (e) => {
        e.preventDefault();
        try {
          await api(`/api/owner/properties/${property.id}`, {
            method: 'PATCH',
            body: {
              title: inputs.title.value,
              location: inputs.location.value,
              pricePerNight: Number(inputs.pricePerNight.value),
              maxGuests: Number(inputs.maxGuests.value),
              description: description.value,
              contactName: inputs.contactName.value,
              contactEmail: inputs.contactEmail.value,
              contactPhone: inputs.contactPhone.value,
            },
          });
          showMessage('Property updated.', 'success');
          reload();
        } catch (err) {
          showMessage(err.message);
        }
      },
    },
    field('Title', inputs.title),
    field('Location', inputs.location),
    field('Price per night (₹)', inputs.pricePerNight),
    field('Sleeps', inputs.maxGuests),
    el('label', { className: 'full' }, 'Description', description),
    field('Contact name', inputs.contactName),
    field('Contact email', inputs.contactEmail),
    field('Contact phone', inputs.contactPhone),
    el('div', { className: 'full form-actions' }, el('button', { type: 'submit' }, 'Save changes'))
  );
}

function propertyCard(property, reload) {
  const statusText = property.published ? 'Published' : 'Hidden';

  return el(
    'div',
    { className: 'card owner-property' },
    el(
      'div',
      { className: 'owner-property-head' },
      el(
        'div',
        {},
        el('h2', {}, property.title),
        el('p', { className: 'card-location' }, `${property.location} · ${money(property.pricePerNight)} / night`)
      ),
      el(
        'div',
        { className: 'owner-actions' },
        el('span', { className: property.published ? 'badge live' : 'badge' }, statusText),
        el(
          'button',
          {
            type: 'button',
            className: 'link-btn',
            onClick: async () => {
              try {
                await api(`/api/owner/properties/${property.id}`, {
                  method: 'PATCH',
                  body: { published: !property.published },
                });
                showMessage(property.published ? 'Property hidden from guests.' : 'Property is now live.', 'success');
                reload();
              } catch (err) {
                showMessage(err.message);
              }
            },
          },
          property.published ? 'Unpublish' : 'Publish'
        ),
        el('a', { className: 'link-btn', href: `/property.html?id=${property.id}` }, 'View'),
        el(
          'button',
          {
            type: 'button',
            className: 'link-btn danger',
            onClick: async () => {
              if (!window.confirm(`Delete “${property.title}” permanently? This cannot be undone.`)) return;
              try {
                await api(`/api/owner/properties/${property.id}`, { method: 'DELETE' });
                showMessage('Property deleted.', 'success');
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
    detailsForm(property, reload),
    roomSection(property, reload),
    photoSection(property, reload)
  );
}

// --- Bookings on the owner's properties ---

async function loadBookings() {
  const box = document.getElementById('bookings');
  try {
    const { bookings } = await api('/api/owner/bookings');
    document.getElementById('no-bookings').hidden = bookings.length > 0;
    box.replaceChildren(
      ...bookings.map((b) =>
        el(
          'div',
          { className: 'card booking-row' },
          el('strong', {}, b.property),
          el('span', {}, `${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}`),
          el('span', {}, `${b.guests} guest${b.guests === 1 ? '' : 's'}`),
          el('span', {}, money(b.totalPrice)),
          el('span', { className: 'hint' }, `${b.guestName} · ${b.guestEmail}`)
        )
      )
    );
  } catch (err) {
    showMessage(err.message);
  }
}

async function load() {
  try {
    const { properties } = await api('/api/owner/properties');
    propertiesBox.replaceChildren(...properties.map((p) => propertyCard(p, load)));
    emptyNote.hidden = properties.length > 0;
    await loadBookings();
  } catch (err) {
    showMessage(err.message);
  }
}

// --- New property form ---

const newCard = document.getElementById('new-card');
document.getElementById('new-btn').addEventListener('click', () => {
  newCard.hidden = !newCard.hidden;
});
document.getElementById('new-cancel').addEventListener('click', () => {
  newCard.hidden = true;
});

document.getElementById('new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = (id) => document.getElementById(id).value;
  try {
    await api('/api/owner/properties', {
      method: 'POST',
      body: {
        title: value('new-title'),
        location: value('new-location'),
        pricePerNight: Number(value('new-price')),
        maxGuests: Number(value('new-guests')),
        description: value('new-description'),
        contactName: value('new-contact-name'),
        contactEmail: value('new-contact-email'),
        contactPhone: value('new-contact-phone'),
      },
    });
    document.getElementById('new-form').reset();
    newCard.hidden = true;
    showMessage('Property created. Add photos and rooms below.', 'success');
    load();
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
  load();
});

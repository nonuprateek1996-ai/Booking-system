'use strict';

// The room calendar: rooms down the side, nights across the top, one bar per
// stay. It answers "who is in which room tonight", which the approval inbox
// cannot — the inbox is ordered by decision, not by date.

import { api, el, money, formatDate, nightsBetween, showMessage } from './common.js';

const STATUS_LABEL = {
  pending: 'Pending',
  approved: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled by guest',
};

const WINDOW_CHOICES = [7, 14, 28];

const state = {
  start: null, // first date shown, YYYY-MM-DD
  days: 28,
  rooms: [],
  bookings: [],
  selectedId: null,
  // Approving from the drawer changes the pending count and the request list
  // too, so the calendar tells the dashboard to catch up rather than leaving
  // the other tab showing a decision that has already been made.
  onDecision: () => {},
};

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function todayIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function dayParts(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }),
    day: d.toLocaleDateString(undefined, { day: '2-digit', timeZone: 'UTC' }),
    month: d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
    weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
  };
}

// --- The grid ---

function headerRow(dates) {
  const cells = dates.map((iso, i) => {
    const p = dayParts(iso);
    const isFirstOfMonth = i === 0 || iso.slice(8) === '01';
    return el(
      'div',
      {
        className: [
          'cal-day-head',
          p.weekend ? 'weekend' : '',
          iso === todayIso() ? 'today' : '',
          isFirstOfMonth ? 'month-start' : '',
        ]
          .filter(Boolean)
          .join(' '),
      },
      // The month only prints where it changes, so a 28-day window is not
      // repeating "Jul" twenty-eight times.
      el('span', { className: 'cal-month' }, isFirstOfMonth ? p.month : ''),
      el('span', { className: 'cal-weekday' }, p.weekday),
      el('span', { className: 'cal-daynum' }, p.day)
    );
  });
  return el('div', { className: 'cal-row cal-head-row' }, el('div', { className: 'cal-room-head' }, 'Room'), ...cells);
}

function bookingBar(b, dates, onOpen) {
  const windowStart = dates[0];
  const windowEnd = addDays(dates[dates.length - 1], 1);

  // A stay running past either edge is clamped to the window and flagged, so a
  // three-week booking seen through a one-week window still reads as one
  // continuous stay rather than a stay that begins on Monday.
  const barStart = b.checkIn < windowStart ? windowStart : b.checkIn;
  const barEnd = b.checkOut > windowEnd ? windowEnd : b.checkOut;
  const offset = nightsBetween(windowStart, barStart);
  const span = nightsBetween(barStart, barEnd);
  if (span <= 0) return null;

  const nights = nightsBetween(b.checkIn, b.checkOut);
  const bar = el(
    'button',
    {
      type: 'button',
      className: [
        'cal-bar',
        `status-${b.status}`,
        b.checkIn < windowStart ? 'clipped-start' : '',
        b.checkOut > windowEnd ? 'clipped-end' : '',
        b.id === state.selectedId ? 'selected' : '',
      ]
        .filter(Boolean)
        .join(' '),
      'data-booking-id': String(b.id),
      title: `${b.guestName} · ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} · ${STATUS_LABEL[b.status]}`,
      'aria-label': `${b.guestName}, ${b.room}, ${formatDate(b.checkIn)} to ${formatDate(b.checkOut)}, ${
        STATUS_LABEL[b.status]
      }. Open details.`,
      onClick: () => onOpen(b.id),
    },
    el('span', { className: 'cal-bar-name' }, b.guestName),
    el('span', { className: 'cal-bar-meta' }, `${nights}n`)
  );
  // Grid placement is the one thing that cannot live in the stylesheet: the
  // column depends on the booking's dates. Column 1 is the room-name column.
  bar.style.gridColumn = `${offset + 2} / span ${span}`;
  return bar;
}

function roomRow(room, dates, onOpen) {
  const cells = dates.map((iso, i) => {
    const p = dayParts(iso);
    const cell = el('div', {
      className: ['cal-cell', p.weekend ? 'weekend' : '', iso === todayIso() ? 'today' : ''].filter(Boolean).join(' '),
    });
    // Every cell is placed by hand. Left to auto-placement they would flow
    // *around* the explicitly positioned bars — CSS grid places explicit items
    // first — and the displaced cells would open a phantom second row under
    // any room that has a booking.
    cell.style.gridColumn = String(i + 2);
    return cell;
  });

  const bars = state.bookings
    .filter((b) => b.roomId === room.id)
    .map((b) => bookingBar(b, dates, onOpen))
    .filter(Boolean);

  return el(
    'div',
    { className: 'cal-row' },
    el(
      'div',
      { className: 'cal-room-name' },
      el('strong', {}, room.name),
      el('span', { className: 'hint' }, `sleeps ${room.maxGuests} · ${money(room.pricePerNight)}`),
      !room.published && el('span', { className: 'badge' }, 'Unpublished')
    ),
    ...cells,
    ...bars
  );
}

// --- The detail drawer ---

function closeDrawer() {
  const drawer = document.getElementById('cal-drawer');
  drawer.hidden = true;
  document.getElementById('cal-backdrop').hidden = true;
  state.selectedId = null;
  for (const bar of document.querySelectorAll('.cal-bar.selected')) bar.classList.remove('selected');
}

function detailRow(label, value) {
  return el('div', { className: 'cal-detail-row' }, el('dt', {}, label), el('dd', {}, value));
}

function openDrawer(id, reload) {
  const b = state.bookings.find((x) => x.id === id);
  if (!b) return;

  state.selectedId = id;
  for (const bar of document.querySelectorAll('.cal-bar')) {
    bar.classList.toggle('selected', bar.dataset.bookingId === String(id));
  }

  const nights = nightsBetween(b.checkIn, b.checkOut);
  const body = document.getElementById('cal-drawer-body');

  const noteInput = el('input', { type: 'text', maxlength: 500, placeholder: 'Note to the guest (optional)' });
  const decide = async (action) => {
    try {
      await api(`/api/owner/bookings/${b.id}/${action}`, { method: 'POST', body: { note: noteInput.value } });
      showMessage(action === 'approve' ? 'Booking confirmed — the guest has been emailed.' : 'Request declined.', 'success');
      closeDrawer();
      reload();
      state.onDecision();
    } catch (err) {
      showMessage(err.message);
    }
  };

  body.replaceChildren(
    el(
      'div',
      { className: 'cal-drawer-head' },
      el('h2', {}, b.room),
      el('span', { className: `badge status-${b.status}` }, STATUS_LABEL[b.status] ?? b.status)
    ),
    el(
      'dl',
      { className: 'cal-details' },
      detailRow('Guest', b.guestName),
      detailRow('Email', el('a', { href: `mailto:${b.guestEmail}` }, b.guestEmail)),
      b.guestPhone && detailRow('Phone', el('a', { href: `tel:${b.guestPhone.replace(/\s/g, '')}` }, b.guestPhone)),
      detailRow('Check-in', formatDate(b.checkIn)),
      detailRow('Check-out', formatDate(b.checkOut)),
      detailRow('Nights', String(nights)),
      detailRow('Guests', `${b.guests} guest${b.guests === 1 ? '' : 's'}`),
      detailRow('Total', money(b.totalPrice)),
      detailRow('Requested', formatDate(b.createdAt.slice(0, 10)))
    ),
    b.guestNote && el('div', { className: 'cal-note' }, el('h3', {}, 'From the guest'), el('p', {}, `“${b.guestNote}”`)),
    b.ownerNote && el('div', { className: 'cal-note' }, el('h3', {}, 'Your note'), el('p', {}, b.ownerNote)),
    b.status === 'pending' &&
      el(
        'div',
        { className: 'cal-drawer-actions' },
        noteInput,
        el('div', { className: 'form-actions' },
          el('button', { type: 'button', className: 'approve-btn', onClick: () => decide('approve') }, 'Approve'),
          el('button', { type: 'button', className: 'danger-btn', onClick: () => decide('decline') }, 'Decline')
        )
      )
  );

  document.getElementById('cal-drawer').hidden = false;
  document.getElementById('cal-backdrop').hidden = false;
  document.getElementById('cal-drawer-close').focus();
}

// --- Loading and controls ---

export async function loadCalendar() {
  if (!state.start) state.start = todayIso();
  try {
    const data = await api(`/api/owner/calendar?start=${state.start}&days=${state.days}`);
    state.rooms = data.rooms;
    state.bookings = data.bookings;
  } catch (err) {
    showMessage(err.message);
    return;
  }

  const dates = Array.from({ length: state.days }, (_, i) => addDays(state.start, i));
  const grid = document.getElementById('cal-grid');
  const onOpen = (id) => openDrawer(id, loadCalendar);

  grid.replaceChildren(headerRow(dates), ...state.rooms.map((r) => roomRow(r, dates, onOpen)));
  // Every row shares one column template, so the room column and the day
  // columns stay aligned as the window width changes.
  grid.style.setProperty('--cal-days', String(state.days));

  document.getElementById('cal-range').textContent =
    `${formatDate(state.start)} → ${formatDate(addDays(state.start, state.days - 1))}`;

  document.getElementById('cal-empty').hidden = state.rooms.length > 0;

  const staying = state.bookings.length;
  document.getElementById('cal-summary').textContent = staying
    ? `${staying} stay${staying === 1 ? '' : 's'} in view`
    : 'No stays in this window.';
}

export function initCalendar({ onDecision } = {}) {
  if (onDecision) state.onDecision = onDecision;

  document.getElementById('cal-prev').addEventListener('click', () => {
    state.start = addDays(state.start ?? todayIso(), -state.days);
    loadCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.start = addDays(state.start ?? todayIso(), state.days);
    loadCalendar();
  });
  document.getElementById('cal-today').addEventListener('click', () => {
    state.start = todayIso();
    document.getElementById('cal-start').value = state.start;
    loadCalendar();
  });
  document.getElementById('cal-start').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.start = e.target.value;
    loadCalendar();
  });

  const span = document.getElementById('cal-span');
  span.replaceChildren(
    ...WINDOW_CHOICES.map((n) => el('option', { value: String(n) }, `${n} days`))
  );
  span.value = String(state.days);
  span.addEventListener('change', (e) => {
    state.days = Number(e.target.value);
    loadCalendar();
  });

  document.getElementById('cal-drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('cal-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('cal-drawer').hidden) closeDrawer();
  });

  state.start = todayIso();
  document.getElementById('cal-start').value = state.start;
}

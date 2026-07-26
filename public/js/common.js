'use strict';

// Every helper here builds DOM through textContent and setAttribute.
// innerHTML is never used anywhere in this app, so listing text written by
// owners or guests can never be interpreted as markup.

export async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {},
  };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.raw !== undefined) {
    init.headers['Content-Type'] = options.raw.type;
    init.body = options.raw;
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the response fields on the error so callers can react to flags
    // such as totpRequired without re-parsing the body.
    const error = new Error(data.error || `Request failed (${res.status})`);
    Object.assign(error, data, { status: res.status });
    throw error;
  }
  return data;
}

// el('div', { className: 'card' }, 'text', childNode)
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className' || key === 'textContent' || key === 'value' || key === 'type') {
      node[key] = value;
    } else if (key === 'onClick') {
      node.addEventListener('click', value);
    } else if (key === 'onSubmit') {
      node.addEventListener('submit', value);
    } else if (key === 'onChange') {
      node.addEventListener('change', value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function money(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function nightsBetween(checkIn, checkOut) {
  return (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function showMessage(text, kind = 'error') {
  const box = document.getElementById('message');
  if (!box) return;
  box.textContent = text || '';
  box.className = kind;
  box.hidden = !text;
  if (text) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export async function fetchUser() {
  try {
    const { user } = await api('/api/auth/me');
    return user;
  } catch {
    return null;
  }
}

// Renders the header navigation for the current user.
export function mountNav(user) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.replaceChildren();

  if (!user) {
    nav.append(
      el('a', { href: '/owner-login.html', className: 'nav-link' }, 'Owner'),
      el('a', { href: '/login.html', className: 'nav-btn' }, 'Sign in to book')
    );
    return;
  }

  if (user.role === 'guest') {
    nav.append(el('a', { href: '/bookings.html', className: 'nav-link' }, 'My trips'));
  } else {
    nav.append(el('a', { href: '/owner.html', className: 'nav-link' }, 'Dashboard'));
  }
  nav.append(
    el('span', { className: 'nav-user' }, user.name),
    el(
      'button',
      {
        className: 'nav-link',
        type: 'button',
        onClick: async () => {
          try {
            await api('/api/auth/logout', { method: 'POST', body: {} });
          } catch {
            /* session may already be gone — send them home regardless */
          }
          window.location.href = '/';
        },
      },
      'Sign out'
    )
  );
}

// Standard page bootstrap: resolve the user, draw the nav, hand it back.
export async function initPage() {
  const user = await fetchUser();
  mountNav(user);
  return user;
}

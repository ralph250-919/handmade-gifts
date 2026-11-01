import { api, escapeHtml, getConfig, money, placeholderImage } from './api.js';

const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'shop.admin.token';
const VERIFIER_KEY = 'shop.admin.pkce';
let config;
let token;
let products = [];
let images = [];

const status = (html, kind = '') => ($('#status').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '');
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- Sign-in with Cognito (authorization code + PKCE) ----------
const redirectUri = () => `${location.origin}/admin/`;
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set(VERIFIER_KEY, verifier);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognito.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.assign(`${config.cognito.domain}/oauth2/authorize?${q}`);
}

async function exchangeCode(code) {
  const res = await fetch(`${config.cognito.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.cognito.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: store.get(VERIFIER_KEY) ?? '',
    }),
  });
  if (!res.ok) throw new Error('Sign-in failed. Please try again.');
  const data = await res.json();
  store.set(TOKEN_KEY, data.id_token);
  store.del(VERIFIER_KEY);
  history.replaceState(null, '', redirectUri());
}

function claims(jwt) {
  try {
    return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function logout() {
  store.del(TOKEN_KEY);
  if (config.devAuth) return location.reload();
  const q = new URLSearchParams({ client_id: config.cognito.clientId, logout_uri: redirectUri() });
  location.assign(`${config.cognito.domain}/logout?${q}`);
}

async function call(path, opts = {}) {
  try {
    return await api(path, { ...opts, token });
  } catch (err) {
    if (err.status === 401) {
      store.del(TOKEN_KEY);
      status('Your session expired. Please sign in again.', 'error');
      showSignIn();
    }
    throw err;
  }
}

function showSignIn() {
  $('#signin').hidden = false;
  $('#app').hidden = true;
  $('#logout').hidden = true;
}

// ---------- Orders ----------
const fmtAddress = (a = {}) =>
  [a.name, a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).map(escapeHtml).join('<br>');

async function loadOrders() {
  const statusFilter = $('#order-status').value;
  $('#orders').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { orders } = await call(`/api/admin/orders?status=${statusFilter}`);
    if (!orders.length) {
      $('#orders').innerHTML = `<p class="empty">${statusFilter === 'PAID' ? 'Nothing to ship right now. 🎉' : 'No orders here.'}</p>`;
      return;
    }
    $('#orders').innerHTML = orders
      .map(
        (o) => `<div class="order">
          <div class="row" style="justify-content:space-between">
            <strong>#${escapeHtml(o.id.slice(-8).toUpperCase())} · ${money(o.totalCents ?? o.subtotalCents, o.currency)}</strong>
            <span class="muted">${new Date(o.paidAt ?? o.createdAt).toLocaleString()}</span>
          </div>
          ${(o.issues ?? []).map((i) => `<div class="issue">⚠ ${escapeHtml(i)}</div>`).join('')}
          <div>${o.items.map((i) => `${i.quantity} × ${escapeHtml(i.name)}`).join('<br>')}</div>
          ${o.customerEmail ? `<div><a href="mailto:${escapeHtml(o.customerEmail)}">${escapeHtml(o.customerName ?? o.customerEmail)}</a></div>` : ''}
          ${o.shippingAddress ? `<div class="muted">${fmtAddress(o.shippingAddress)}</div>` : ''}
          ${o.trackingNumber ? `<div>Tracking: ${escapeHtml(o.carrier ?? '')} ${escapeHtml(o.trackingNumber)}</div>` : ''}
          ${
            o.status === 'PAID'
              ? `<form class="row" data-ship="${escapeHtml(o.id)}">
                  <input name="carrier" placeholder="Carrier (optional)" class="btn secondary small" style="min-width:0;width:150px">
                  <input name="trackingNumber" placeholder="Tracking # (optional)" class="btn secondary small" style="min-width:0;width:190px">
                  <button class="btn small">Mark shipped &amp; email customer</button>
                </form>`
              : ''
          }
        </div>`,
      )
      .join('');
    document.querySelectorAll('[data-ship]').forEach((f) =>
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(f));
        f.querySelector('button').disabled = true;
        try {
          const { emailed } = await call(`/api/admin/orders/${encodeURIComponent(f.dataset.ship)}/ship`, { method: 'POST', body });
          status(emailed ? 'Marked as shipped and the customer was emailed.' : 'Marked as shipped (the email could not be sent — please contact the customer).', emailed ? 'ok' : 'error');
          loadOrders();
        } catch (err) {
          status(escapeHtml(err.message), 'error');
          f.querySelector('button').disabled = false;
        }
      }),
    );
  } catch (err) {
    $('#orders').innerHTML = '';
    status(escapeHtml(err.message), 'error');
  }
}

// ---------- Products ----------
async function loadProducts() {
  try {
    ({ products } = await call('/api/admin/products'));
    $('#products').innerHTML =
      '<thead><tr><th></th><th>Name</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>' +
      products
        .map(
          (p) => `<tr>
            <td><img src="${escapeHtml(p.images[0] || placeholderImage)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px"></td>
            <td>${escapeHtml(p.name)}</td>
            <td>${money(p.priceCents, p.currency)}</td>
            <td>${p.stock === null ? '<span class="muted">Made to order</span>' : p.stock === 0 ? '<span class="issue">Sold out</span>' : p.stock}</td>
            <td>${p.active ? 'Visible' : '<span class="muted">Hidden</span>'}</td>
            <td><button class="btn secondary small" data-edit="${p.id}">Edit</button></td>
          </tr>`,
        )
        .join('') +
      '</tbody>';
    if (!products.length) $('#products').innerHTML = '<tr><td class="empty">No products yet — add your first one!</td></tr>';
    document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editProduct(products.find((p) => p.id === b.dataset.edit))));
  } catch (err) {
    status(escapeHtml(err.message), 'error');
  }
}

function renderImages() {
  $('#images').innerHTML = images
    .map((src, i) => `<figure><img src="${escapeHtml(src)}" alt=""><button type="button" data-rm="${i}" aria-label="Remove photo">×</button></figure>`)
    .join('');
  document.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => (images.splice(Number(b.dataset.rm), 1), renderImages())));
}

function editProduct(p) {
  const f = $('#product-form');
  f.hidden = false;
  f.reset();
  $('#form-title').textContent = p ? `Edit “${p.name}”` : 'Add product';
  f.elements.id.value = p?.id ?? '';
  f.elements.name.value = p?.name ?? '';
  f.elements.description.value = p?.description ?? '';
  f.elements.price.value = p ? (p.priceCents / 100).toFixed(2) : '';
  f.elements.stock.value = p?.stock ?? '';
  f.elements.category.value = p?.category ?? '';
  f.elements.active.checked = p?.active ?? true;
  $('#delete').hidden = !p;
  images = [...(p?.images ?? [])];
  renderImages();
  f.scrollIntoView({ behavior: 'smooth' });
}

async function saveProduct(e) {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.elements.name.value,
    description: f.elements.description.value,
    priceCents: Math.round(Number(f.elements.price.value) * 100),
    stock: f.elements.stock.value === '' ? null : Number(f.elements.stock.value),
    category: f.elements.category.value || undefined,
    active: f.elements.active.checked,
    images,
  };
  const id = f.elements.id.value;
  try {
    await call(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body });
    status('Saved. The shop updates within about a minute.', 'ok');
    f.hidden = true;
    loadProducts();
  } catch (err) {
    status(escapeHtml(err.message), 'error');
  }
}

async function uploadPhotos(e) {
  for (const file of e.target.files) {
    if (file.size > 10 * 1024 * 1024) {
      status(`${escapeHtml(file.name)} is larger than 10 MB — please resize it first.`, 'error');
      continue;
    }
    try {
      status(`Uploading ${escapeHtml(file.name)}…`);
      const { uploadUrl, imagePath } = await call('/api/admin/uploads', { method: 'POST', body: { contentType: file.type } });
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      images.push(imagePath);
      renderImages();
      status('');
    } catch (err) {
      status(escapeHtml(err.message), 'error');
    }
  }
  e.target.value = '';
}

// ---------- Boot ----------
async function init() {
  config = await getConfig();
  document.querySelectorAll('[data-shop-name]').forEach((el) => (el.textContent = config.shopName));
  $('#login').addEventListener('click', login);
  $('#logout').addEventListener('click', logout);

  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    try {
      await exchangeCode(code);
    } catch (err) {
      status(escapeHtml(err.message), 'error');
    }
  }
  token = config.devAuth ? 'dev' : store.get(TOKEN_KEY);
  const c = token && !config.devAuth ? claims(token) : null;
  if (!config.devAuth && (!c || c.exp * 1000 < Date.now())) return showSignIn();

  $('#who').textContent = c?.email ?? (config.devAuth ? 'local dev' : '');
  $('#logout').hidden = false;
  $('#app').hidden = false;

  document.querySelectorAll('[data-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
      if (tab.dataset.tab === 'products') loadProducts();
      else loadOrders();
    }),
  );
  $('#order-status').addEventListener('change', loadOrders);
  $('#new-product').addEventListener('click', () => editProduct());
  $('#cancel-edit').addEventListener('click', () => ($('#product-form').hidden = true));
  $('#product-form').addEventListener('submit', saveProduct);
  $('#upload').addEventListener('change', uploadPhotos);
  $('#delete').addEventListener('click', async () => {
    const id = $("#product-form").elements.id.value;
    if (!id || !confirm('Delete this product? Consider hiding it instead to keep its history.')) return;
    try {
      await call(`/api/admin/products/${id}`, { method: 'DELETE' });
      $('#product-form').hidden = true;
      loadProducts();
    } catch (err) {
      status(escapeHtml(err.message), 'error');
    }
  });
  loadOrders();
}

init().catch((err) => status(escapeHtml(err.message), 'error'));

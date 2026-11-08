import { api, escapeHtml, getConfig, money, placeholderImage } from './api.js';
import { cart, renderCartCount } from './cart.js';
import { track } from './rum.js';

const $ = (sel) => document.querySelector(sel);
const status = (html, kind = '') => {
  const el = $('#status');
  if (el) el.innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
};

async function init() {
  renderCartCount();
  for (const el of document.querySelectorAll('[data-year]')) el.textContent = String(new Date().getFullYear());
  try {
    const config = await getConfig();
    for (const el of document.querySelectorAll('[data-shop-name]')) el.textContent = config.shopName;
    applyShippingCopy(config);
    if (document.title.includes('Handmade Gifts')) document.title = document.title.replace('Handmade Gifts', config.shopName);
  } catch {
    /* keep defaults */
  }
  const page = document.body.dataset.page;
  if (page === 'home') return renderHome();
  if (page === 'product') return renderProduct();
  if (page === 'cart') return renderCart();
  if (page === 'success') {
    cart.clear();
    track('order_success');
  }
}

const icon = {
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

function shippingLine(config, currency = config.currency || 'usd') {
  if (config.freeShippingOverCents > 0) return `Free shipping on orders over ${money(config.freeShippingOverCents, currency)}`;
  if (config.shippingStandardCents > 0) return `Flat-rate shipping, ${money(config.shippingStandardCents, currency)}`;
  return 'Free shipping on every order';
}

function applyShippingCopy(config) {
  const line = shippingLine(config);
  const bar = document.querySelector('[data-announce]');
  if (bar) bar.textContent = `${line} · Every piece made by hand`;
  const perk = document.querySelector('[data-ship-perk]');
  if (perk) perk.textContent = config.freeShippingOverCents > 0 ? `Free shipping over ${money(config.freeShippingOverCents, config.currency || 'usd')}` : 'Shipped with care';
  const detail = document.querySelector('[data-ship-perk-detail]');
  if (detail && config.shippingStandardCents > 0) detail.textContent = `Otherwise a flat ${money(config.shippingStandardCents, config.currency || 'usd')}`;
}

function badgeFor(p) {
  if (!p.available) return '<span class="badge sold">Sold out</span>';
  if (p.lowStock) return `<span class="badge">Only ${p.lowStock} left</span>`;
  if (p.madeToOrder) return '<span class="badge mto">Made to order</span>';
  return '';
}

function card(p, i = 0) {
  const img = p.images[0] || placeholderImage;
  return `<a class="card fade-in${p.available ? '' : ' is-sold'}" style="animation-delay:${Math.min(i, 8) * 60}ms" href="/product.html?slug=${encodeURIComponent(p.slug)}">
    <div class="media"><img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" loading="lazy">${badgeFor(p)}<span class="view" aria-hidden="true">View details</span></div>
    <div class="body"><div><h3>${escapeHtml(p.name)}</h3>${p.category ? `<div class="cat">${escapeHtml(p.category)}</div>` : ''}</div><span class="price">${money(p.priceCents, p.currency)}</span></div>
  </a>`;
}

async function renderHome() {
  const grid = $('#grid');
  try {
    const { products } = await api('/api/products');
    // Available pieces first; the API order is kept within each group.
    const sorted = [...products].sort((a, b) => Number(b.available) - Number(a.available));
    renderMosaic(sorted);
    const categories = [...new Set(sorted.map((p) => p.category).filter(Boolean))];
    let active = 'All';
    const draw = () => {
      const shown = active === 'All' ? sorted : sorted.filter((p) => p.category === active);
      $('#count').textContent = `${shown.length} ${shown.length === 1 ? 'piece' : 'pieces'}`;
      grid.innerHTML = shown.length
        ? shown.map(card).join('')
        : '<div class="empty"><p>New pieces are on the workbench. Check back soon!</p></div>';
    };
    const chips = $('#chips');
    if (categories.length > 1) {
      chips.innerHTML = ['All', ...categories]
        .map((c) => `<button type="button" class="chip" aria-pressed="${c === active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
        .join('');
      chips.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cat]');
        if (!b) return;
        active = b.dataset.cat;
        chips.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        draw();
      });
    }
    draw();
  } catch (err) {
    grid.innerHTML = '';
    status(`${escapeHtml(err.message)} <button class="link-btn" onclick="location.reload()">Try again</button>`, 'error');
  }
}

/** Hero collage of up to three product photos (available pieces first). */
function renderMosaic(products) {
  const el = $('#mosaic');
  if (!el) return;
  const withPhotos = products.filter((p) => p.images[0]).slice(0, 3);
  el.innerHTML = withPhotos
    .map((p) => `<a href="/product.html?slug=${encodeURIComponent(p.slug)}" tabindex="-1"><img src="${escapeHtml(p.images[0])}" alt=""></a>`)
    .join('');
}

async function renderProduct() {
  const el = $('#product');
  const slug = new URLSearchParams(location.search).get('slug');
  if (!slug) return (location.href = '/');
  let p;
  try {
    p = await api(`/api/products/${encodeURIComponent(slug)}`);
  } catch (err) {
    el.innerHTML = '';
    return status(err.status === 404 ? 'This piece is no longer available. <a href="/">See what else is in the shop</a>.' : escapeHtml(err.message), 'error');
  }
  document.title = `${p.name} · ${document.title.split(' · ').pop()}`;
  const config = await getConfig().catch(() => ({}));
  const crumbs = $('#crumbs');
  if (crumbs) crumbs.innerHTML = `<a href="/">Shop</a><span aria-hidden="true">/</span>${p.category ? `<a href="/#shop">${escapeHtml(p.category)}</a><span aria-hidden="true">/</span>` : ''}<span aria-current="page">${escapeHtml(p.name)}</span>`;
  const images = p.images.length ? p.images : [placeholderImage];
  el.innerHTML = `
    <div class="gallery fade-in">
      <div class="main"><img class="backdrop" id="main-backdrop" src="${escapeHtml(images[0])}" alt="" aria-hidden="true"><img id="main-img" src="${escapeHtml(images[0])}" alt="${escapeHtml(p.name)}"></div>
      ${images.length > 1 ? `<div class="thumbs">${images.map((src, i) => `<button type="button" data-src="${escapeHtml(src)}" aria-current="${i === 0}" aria-label="Photo ${i + 1}"><img src="${escapeHtml(src)}" alt=""></button>`).join('')}</div>` : ''}
    </div>
    <div class="info fade-in" style="animation-delay:80ms">
      <div>
        ${p.category ? `<div class="eyebrow">${escapeHtml(p.category)}</div>` : ''}
        <h1>${escapeHtml(p.name)}</h1>
        <div class="row"><span class="price">${money(p.priceCents, p.currency)}</span>${badgeFor(p)}</div>
      </div>
      ${
        p.available
          ? `<div class="buy">
              <div class="qty"><button type="button" data-step="-1" aria-label="Decrease quantity">−</button><input id="qty" type="number" min="1" max="${p.lowStock || 20}" value="1" aria-label="Quantity"><button type="button" data-step="1" aria-label="Increase quantity">+</button></div>
              <button class="btn" data-testid="add-to-cart" id="add">Add to cart</button>
            </div>`
          : '<button class="btn block" data-testid="add-to-cart" disabled>Sold out</button>'
      }
      <div id="added" role="status" aria-live="polite"></div>
      ${p.madeToOrder ? '<p class="muted" style="margin:0">Made to order. Please allow extra time for crafting before it ships.</p>' : ''}
      ${p.description ? `<div class="description">${escapeHtml(p.description)}</div>` : ''}
      <ul class="facts">
        <li>${icon.hand}Made by hand, one at a time</li>
        <li>${icon.box}${escapeHtml(shippingLine(config, p.currency))}</li>
        <li>${icon.lock}Secure checkout by Stripe</li>
      </ul>
    </div>`;

  el.querySelectorAll('.thumbs button').forEach((b) =>
    b.addEventListener('click', () => {
      $('#main-img').src = b.dataset.src;
      $('#main-backdrop').src = b.dataset.src;
      el.querySelectorAll('.thumbs button').forEach((x) => x.setAttribute('aria-current', String(x === b)));
    }),
  );
  const qty = $('#qty');
  el.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => {
      qty.value = String(Math.max(1, Math.min(Number(qty.max), Number(qty.value) + Number(b.dataset.step))));
    }),
  );
  $('#add')?.addEventListener('click', () => {
    const n = Math.max(1, Math.min(Number(qty.max), Number(qty.value) || 1));
    cart.add(p, n);
    track('add_to_cart', { productId: p.id, quantity: n });
    $('#added').innerHTML = `<div class="notice ok fade-in">Added to your cart. <a href="/cart.html">View cart &amp; check out</a></div>`;
  });
}

async function renderCart() {
  const el = $('#cart');
  const config = await getConfig().catch(() => ({}));
  if (new URLSearchParams(location.search).get('cancelled')) {
    status('Checkout was cancelled — your cart is still here whenever you are ready.');
    track('checkout_cancelled');
  }

  const draw = () => {
    const items = cart.items();
    if (!items.length) {
      el.innerHTML = '<div class="empty"><p>Your cart is empty.</p><a class="btn" href="/#shop">Browse gifts</a></div>';
      return;
    }
    const currency = items[0].currency;
    const subtotal = items.reduce((s, i) => s + i.priceCents * i.quantity, 0);
    const threshold = config.freeShippingOverCents > 0 ? config.freeShippingOverCents : 0;
    const free = threshold > 0 && subtotal >= threshold;
    const shippingCents = free ? 0 : (config.shippingStandardCents ?? 0);
    const meter = threshold
      ? `<div class="ship-meter"><span>${free ? 'Your order ships free.' : `You're ${money(threshold - subtotal, currency)} away from free shipping.`}</span><div class="bar"><span style="width:${Math.min(100, (subtotal / threshold) * 100)}%"></span></div></div>`
      : '';
    el.innerHTML = `
      <div class="lines">
        ${items
          .map(
            (i) => `<div class="line">
              <img src="${escapeHtml(i.image || placeholderImage)}" alt="">
              <div><a href="/product.html?slug=${encodeURIComponent(i.slug)}"><strong>${escapeHtml(i.name)}</strong></a>
                <div class="muted" style="font-size:.88rem">${money(i.priceCents, i.currency)} each</div>
                <div class="row" style="margin-top:10px">
                  <div class="qty"><button type="button" data-id="${i.productId}" data-step="-1" aria-label="Decrease">−</button><input value="${i.quantity}" readonly aria-label="Quantity"><button type="button" data-id="${i.productId}" data-step="1" aria-label="Increase">+</button></div>
                  <button class="link-btn" data-remove="${i.productId}">Remove</button>
                </div></div>
              <div class="price">${money(i.priceCents * i.quantity, i.currency)}</div>
            </div>`,
          )
          .join('')}
      </div>
      <aside class="summary">
        <h2>Order summary</h2>
        ${meter}
        <div class="split"><span class="muted">Subtotal</span><span class="price">${money(subtotal, currency)}</span></div>
        <div class="split"><span class="muted">Shipping</span><span>${shippingCents ? money(shippingCents, currency) : 'Free'}</span></div>
        <div class="split" style="border-top:1px solid var(--line);padding-top:14px"><strong>Estimated total</strong><span class="total">${money(subtotal + shippingCents, currency)}</span></div>
        <button class="btn block" id="checkout" data-testid="checkout">${icon.lock}Checkout securely</button>
        <div class="muted" style="font-size:.84rem;text-align:center">You'll enter your address and payment on Stripe's secure page.</div>
      </aside>`;

    el.querySelectorAll('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        const item = cart.items().find((i) => i.productId === b.dataset.id);
        cart.setQuantity(b.dataset.id, (item?.quantity ?? 0) + Number(b.dataset.step));
        draw();
      }),
    );
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => (cart.remove(b.dataset.remove), draw())));
    $('#checkout').addEventListener('click', checkout);
  };

  async function checkout() {
    const btn = $('#checkout');
    btn.disabled = true;
    btn.textContent = 'Starting secure checkout…';
    status('');
    track('checkout_started', { items: cart.count() });
    try {
      const { url } = await api('/api/checkout', {
        method: 'POST',
        body: { items: cart.items().map(({ productId, quantity }) => ({ productId, quantity })) },
      });
      location.assign(url);
    } catch (err) {
      track('checkout_error', { code: err.code, status: err.status });
      status(escapeHtml(err.message), 'error');
      btn.disabled = false;
      btn.innerHTML = `${icon.lock}Checkout securely`;
      if (err.code === 'UNAVAILABLE' || err.code === 'OUT_OF_STOCK') refreshCart();
    }
  }

  // Remove items that were deleted or sold out since they were added, and refresh prices.
  async function refreshCart() {
    try {
      const { products } = await api('/api/products');
      const byId = new Map(products.map((p) => [p.id, p]));
      const changed = [];
      for (const item of cart.items()) {
        const p = byId.get(item.productId);
        if (!p || !p.available) {
          cart.remove(item.productId);
          changed.push(`${item.name} is no longer available and was removed.`);
        } else if (p.priceCents !== item.priceCents) {
          cart.remove(item.productId);
          cart.add(p, item.quantity);
          changed.push(`The price of ${p.name} changed to ${money(p.priceCents, p.currency)}.`);
        }
      }
      if (changed.length) status(changed.map(escapeHtml).join('<br>'));
      draw();
    } catch {
      /* keep the cart as-is */
    }
  }

  draw();
  refreshCart();
}

init();

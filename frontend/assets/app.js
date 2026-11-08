import { api, escapeHtml, getConfig, money, placeholderImage } from './api.js';
import { cart, renderCartCount } from './cart.js';
import { track } from './rum.js';

const $ = (sel) => document.querySelector(sel);
const status = (html, kind = '') => {
  const el = $('#status');
  if (el) el.innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
};

// One shared request for the catalog: header, footer and page content all use it.
let productsPromise;
const loadProducts = () => (productsPromise ??= api('/api/products').then((r) => r.products));
const categoriesOf = (products) => [...new Set(products.map((p) => p.category).filter(Boolean))];
const categoryUrl = (c) => `/?cat=${encodeURIComponent(c)}#shop`;
const productUrl = (p) => `/product.html?slug=${encodeURIComponent(p.slug)}`;

async function init() {
  renderCartCount();
  for (const el of document.querySelectorAll('[data-year]')) el.textContent = String(new Date().getFullYear());
  setupBackToTop();
  try {
    const config = await getConfig();
    for (const el of document.querySelectorAll('[data-shop-name]')) el.textContent = config.shopName;
    const foot = $('[data-ship-foot]');
    if (foot) foot.textContent = shippingLine(config);
    if (document.title.includes('Handmade Gifts')) document.title = document.title.replace('Handmade Gifts', config.shopName);
  } catch {
    /* keep defaults */
  }
  renderCategoryLinks();
  const page = document.body.dataset.page;
  if (page === 'home') return renderHome();
  if (page === 'product') return renderProduct();
  if (page === 'cart') return renderCart();
  if (page === 'success') {
    cart.clear();
    track('order_success');
  }
}

function setupBackToTop() {
  const btn = $('[data-to-top]');
  if (!btn) return;
  const update = () => (btn.hidden = window.scrollY < 600);
  window.addEventListener('scroll', update, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0 }));
  update();
}

/** Category links in the header and footer, built from the live catalog. */
async function renderCategoryLinks() {
  try {
    const cats = categoriesOf(await loadProducts());
    const current = new URLSearchParams(location.search).get('cat');
    const links = cats.map((c) => `<a href="${categoryUrl(c)}"${c === current ? ' aria-current="page"' : ''}>${escapeHtml(c)}</a>`).join('');
    const nav = $('[data-nav-cats]');
    if (nav) nav.innerHTML = links;
    const foot = $('[data-foot-cats]');
    if (foot) foot.innerHTML = links;
  } catch {
    /* links are optional */
  }
}

function shippingLine(config, currency = config.currency || 'usd') {
  if (config.freeShippingOverCents > 0) return `Free shipping on orders over ${money(config.freeShippingOverCents, currency)}`;
  if (config.shippingStandardCents > 0) return `Flat-rate shipping, ${money(config.shippingStandardCents, currency)}`;
  return 'Free shipping on every order';
}

function availability(p) {
  if (!p.available) return { text: 'Sold out', cls: 'sold' };
  if (p.lowStock) return { text: `Only ${p.lowStock} left`, cls: 'low' };
  if (p.madeToOrder) return { text: 'Made to order', cls: '' };
  return { text: 'In stock', cls: '' };
}

function card(p) {
  const img = p.images[0] || placeholderImage;
  const a = availability(p);
  const note = a.cls ? `<div class="note ${a.cls}">${a.text}</div>` : '';
  return `<a class="card${p.available ? '' : ' is-sold'}" href="${productUrl(p)}">
    <div class="media"><img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" loading="lazy"></div>
    <div class="body">
      <h3 title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h3>
      ${p.category ? `<div class="cat">${escapeHtml(p.category)}</div>` : ''}
      <div class="price">${money(p.priceCents, p.currency)}</div>
      ${note}
    </div>
  </a>`;
}

const sortAvailableFirst = (products) => [...products].sort((a, b) => Number(b.available) - Number(a.available));

async function renderHome() {
  const grid = $('#grid');
  try {
    const sorted = sortAvailableFirst(await loadProducts());
    const categories = categoriesOf(sorted);
    renderHero(sorted, categories);

    const params = new URLSearchParams(location.search);
    let active = categories.includes(params.get('cat')) ? params.get('cat') : 'All';
    const filters = $('#filters');

    const draw = () => {
      const shown = active === 'All' ? sorted : sorted.filter((p) => p.category === active);
      const inStock = shown.filter((p) => p.available).length;
      $('#shop-title').textContent = active === 'All' ? 'Featured' : active;
      $('#stats').innerHTML = `<strong>${shown.length}</strong> ${shown.length === 1 ? 'piece' : 'pieces'} · <strong>${inStock}</strong> available now${active === 'All' && categories.length ? ` · <strong>${categories.length}</strong> ${categories.length === 1 ? 'category' : 'categories'}` : ''}`;
      grid.innerHTML = shown.length
        ? shown.map(card).join('')
        : '<div class="empty"><p>New pieces are on the workbench. Check back soon!</p></div>';
      filters.querySelectorAll('.filter').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.cat === active)));
    };

    if (categories.length > 1) {
      filters.innerHTML = ['All', ...categories]
        .map((c) => `<button type="button" class="filter" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
        .join('');
      filters.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cat]');
        if (!b) return;
        active = b.dataset.cat;
        const url = new URL(location.href);
        if (active === 'All') url.searchParams.delete('cat');
        else url.searchParams.set('cat', active);
        history.replaceState(null, '', url);
        draw();
      });
    }
    draw();
  } catch (err) {
    grid.innerHTML = '';
    status(`${escapeHtml(err.message)} <button class="link-btn" onclick="location.reload()">Try again</button>`, 'error');
  }
}

/** Split hero: two product photos side by side, with a button per category (up to two). */
function renderHero(products, categories) {
  const media = $('#hero-media');
  const photos = products.filter((p) => p.images[0]).slice(0, 2);
  if (media && photos.length) {
    media.innerHTML = [0, 1]
      .map((i) => {
        const p = photos[i] ?? photos[0];
        return `<div><img src="${escapeHtml(p.images[0])}" alt="" ${i ? 'loading="lazy"' : ''}></div>`;
      })
      .join('');
  }
  const actions = $('#hero-actions');
  if (actions && categories.length > 1) {
    actions.innerHTML = categories
      .slice(0, 2)
      .map((c) => `<a class="btn white" href="${categoryUrl(c)}">${escapeHtml(c)}</a>`)
      .join('');
  }
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
  const shopName = config.shopName || 'Handmade Gifts';
  const sep = '<span class="sep" aria-hidden="true">›</span>';
  $('#crumbs').innerHTML = `<a href="/">Shop</a>${p.category ? `${sep}<a href="${categoryUrl(p.category)}">${escapeHtml(p.category)}</a>` : ''}${sep}<span aria-current="page">${escapeHtml(p.name)}</span>`;

  const images = p.images.length ? p.images : [placeholderImage];
  const a = availability(p);
  el.innerHTML = `
    <div class="info">
      <div>
        <h1>${escapeHtml(p.name)}</h1>
        <p class="byline">by <a href="/">${escapeHtml(shopName)}</a></p>
      </div>
      ${p.description ? `<p class="description">${escapeHtml(p.description)}</p>` : ''}
      <ul class="details">
        ${p.category ? `<li>Category: ${escapeHtml(p.category)}</li>` : ''}
        <li>Availability: ${a.text}</li>
        ${p.madeToOrder ? '<li>Made to order. Please allow extra time for crafting before it ships.</li>' : ''}
        <li>${escapeHtml(shippingLine(config, p.currency))}</li>
        <li><strong>Secure checkout by Stripe</strong></li>
      </ul>
      <div class="price-block"><span class="label">Price</span><span class="price">${money(p.priceCents, p.currency)}</span></div>
      ${
        p.available
          ? `<div class="buy-row">
              <div class="qty"><button type="button" data-step="-1" aria-label="Decrease quantity">−</button><input id="qty" type="number" min="1" max="${p.lowStock || 20}" value="1" aria-label="Quantity"><button type="button" data-step="1" aria-label="Increase quantity">+</button></div>
              <button class="btn buy" data-testid="add-to-cart" id="add">Add to cart</button>
              <a class="btn" href="/cart.html">View cart</a>
            </div>`
          : `<div class="buy-row">
              <button class="btn" data-testid="add-to-cart" disabled>Sold out</button>
              <a class="btn" href="/#shop">Keep shopping</a>
            </div>`
      }
      <div id="added" role="status" aria-live="polite"></div>
      <div class="tags">${p.category ? `<a href="${categoryUrl(p.category)}">${escapeHtml(p.category)}</a>` : ''}<a href="/#shop">All pieces</a></div>
    </div>
    <div class="gallery">
      <div class="main"><img id="main-img" src="${escapeHtml(images[0])}" alt="${escapeHtml(p.name)}"></div>
      ${images.length > 1 ? `<div class="thumbs">${images.map((src, i) => `<button type="button" data-src="${escapeHtml(src)}" aria-current="${i === 0}" aria-label="Photo ${i + 1}"><img src="${escapeHtml(src)}" alt=""></button>`).join('')}</div>` : ''}
    </div>`;

  el.querySelectorAll('.thumbs button').forEach((b) =>
    b.addEventListener('click', () => {
      $('#main-img').src = b.dataset.src;
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
    $('#added').innerHTML = `<div class="notice ok">Added to your cart. <a href="/cart.html">View cart &amp; check out</a></div>`;
  });

  renderRelated(p);
}

/** Other pieces: same category first, then everything else (available first). */
async function renderRelated(p) {
  try {
    const others = sortAvailableFirst((await loadProducts()).filter((x) => x.id !== p.id));
    if (!others.length) return;
    const ranked = [...others.filter((x) => x.category && x.category === p.category), ...others.filter((x) => !x.category || x.category !== p.category)];
    $('#related-grid').innerHTML = ranked.slice(0, 8).map(card).join('');
    $('#related').hidden = false;
  } catch {
    /* related items are optional */
  }
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
                <div class="muted" style="font-size:.8rem">${money(i.priceCents, i.currency)} each</div>
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
        <div class="split" style="border-top:1px solid var(--soft-2);padding-top:12px"><strong>Estimated total</strong><span class="total">${money(subtotal + shippingCents, currency)}</span></div>
        <button class="btn buy block" id="checkout" data-testid="checkout">Checkout securely</button>
        <div class="muted" style="font-size:.78rem;text-align:center">You'll enter your address and payment on Stripe's secure page.</div>
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
      btn.textContent = 'Checkout securely';
      if (err.code === 'UNAVAILABLE' || err.code === 'OUT_OF_STOCK') refreshCart();
    }
  }

  // Remove items that were deleted or sold out since they were added, and refresh prices.
  async function refreshCart() {
    try {
      // Always fetch fresh here: this also runs after checkout reports a stock change.
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

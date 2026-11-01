// The cart lives in the browser (localStorage). Prices are re-checked by the server at checkout.
const KEY = 'shop.cart.v1';

function read() {
  try {
    const items = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable (private mode); cart lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent('cart:change', { detail: items }));
}

export const cart = {
  items: read,
  count: () => read().reduce((n, i) => n + i.quantity, 0),
  add(product, quantity = 1) {
    const items = read();
    const existing = items.find((i) => i.productId === product.id);
    if (existing) existing.quantity = Math.min(20, existing.quantity + quantity);
    else
      items.push({
        productId: product.id,
        slug: product.slug,
        name: product.name,
        priceCents: product.priceCents,
        currency: product.currency,
        image: product.images?.[0],
        quantity,
      });
    write(items);
  },
  setQuantity(productId, quantity) {
    const items = read()
      .map((i) => (i.productId === productId ? { ...i, quantity: Math.max(0, Math.min(20, quantity)) } : i))
      .filter((i) => i.quantity > 0);
    write(items);
  },
  remove(productId) {
    write(read().filter((i) => i.productId !== productId));
  },
  clear() {
    write([]);
  },
};

export function renderCartCount() {
  for (const el of document.querySelectorAll('[data-cart-count]')) el.textContent = String(cart.count());
}
window.addEventListener('cart:change', renderCartCount);
window.addEventListener('storage', renderCartCount);

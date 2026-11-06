export type CartItem = {
  sku: string;
  name: string;
  slug: string;
  priceCents: number;
  image?: string;
  coupon?: string;
  expectedTotalCents?: number;
};

const cartKey = 'mario-store-cart-v1';
const changeEvent = 'store-cart-change';

export function readCart(): CartItem[] {
  try {
    const items = JSON.parse(localStorage.getItem(cartKey) ?? '[]');
    return Array.isArray(items) ? items.filter((item) => item && typeof item.sku === 'string' &&
      typeof item.name === 'string' && typeof item.slug === 'string' && Number.isSafeInteger(item.priceCents)) : [];
  } catch { return []; }
}

export function writeCart(items: CartItem[]) {
  try {
    localStorage.setItem(cartKey, JSON.stringify(items));
  } catch { return false; }
  window.dispatchEvent(new Event(changeEvent));
  return true;
}

export function onCartChange(update: () => void) {
  window.addEventListener(changeEvent, update);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) update();
  });
  window.addEventListener('storage', (event) => {
    if (event.key === cartKey || event.key === null) update();
  });
}

export const productCount = (count: number) => `${count} ${count === 1 ? 'produto' : 'produtos'}`;

export const getAvailability = (sku: string) =>
  fetch(`/compras/api/disponibilidade?sku=${encodeURIComponent(sku)}`)
    .then((response) => response.ok ? response.json() : null).catch(() => null);

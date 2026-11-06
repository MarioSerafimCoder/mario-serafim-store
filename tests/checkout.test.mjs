import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkoutCode } from '../src/lib/checkout.ts';

Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, writable: true, configurable: true });

test('repetir checkout com armazenamento bloqueado preserva a tentativa na mesma aba', (t) => {
  const storage = {
    getItem() { throw new Error('Storage blocked'); },
    setItem() { throw new Error('Storage blocked'); },
  };
  t.mock.property(globalThis, 'sessionStorage', storage);
  const key = 'store-cart-checkout:REAL-1:1299';
  const first = checkoutCode(key);
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(checkoutCode(key), first);
  assert.notEqual(checkoutCode(key + '|REAL-2:800'), first);
});

test('checkout retoma a tentativa persistida e salva novos códigos internamente', (t) => {
  const code = crypto.randomUUID();
  const values = new Map([['previous', code]]);
  t.mock.property(globalThis, 'sessionStorage', {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  assert.equal(checkoutCode('previous'), code);
  const next = checkoutCode('new');
  assert.equal(values.get('new'), next);
  assert.equal(checkoutCode('new'), next);
});

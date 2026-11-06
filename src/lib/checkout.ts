const attempts = new Map<string, string>();

export async function deliveryCheckoutCode(key: string, email?: string) {
  if (!email) return checkoutCode(key);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  return checkoutCode(key + ':' + fingerprint);
}

export function checkoutCode(key: string): string {
  let code = attempts.get(key);
  if (code) return code;
  try { code = sessionStorage.getItem(key) ?? undefined; } catch {}
  code ??= crypto.randomUUID();
  attempts.set(key, code);
  try { sessionStorage.setItem(key, code); } catch {}
  return code;
}

const attempts = new Map<string, string>();

export function checkoutCode(key: string): string {
  let code = attempts.get(key);
  if (code) return code;
  try { code = sessionStorage.getItem(key) ?? undefined; } catch {}
  code ??= crypto.randomUUID();
  attempts.set(key, code);
  try { sessionStorage.setItem(key, code); } catch {}
  return code;
}


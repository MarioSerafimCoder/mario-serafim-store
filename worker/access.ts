import type { Env } from './types.ts';

type Keys = { expires: number; values: JsonWebKey[] };
const keyCache = new Map<string, Keys>();

function decode(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
}
function claims(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decode(value)));
}

export function accessConfigured(env: Env) {
  return Boolean(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ADMIN_ACCESS_ISSUER ?? '') &&
    /^[a-f0-9]{64}$/.test(env.ADMIN_ACCESS_AUD ?? '') && /^[^\s@]+@[^\s@]+$/.test(env.ADMIN_EMAIL ?? ''));
}

export async function verifyAccess(request: Request, env: Env) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 8192 || !accessConfigured(env)) return null;
  const denied = (reason: string) => {
    if (env.MP_MODE === 'test') console.warn('Access: ' + reason);
    return null;
  };
  const issuer = env.ADMIN_ACCESS_ISSUER!;
  let step = 'leitura do JWT';
  try {
    const [header, payload, signature, ...rest] = token.split('.');
    if (!header || !payload || !signature || rest.length) return null;
    const { alg, kid } = claims(header);
    const { iss, aud, exp, nbf, email, type, sub } = claims(payload);
    const now = Date.now() / 1000;
    if (alg !== 'RS256' || typeof kid !== 'string') return denied('algoritmo ou chave');
    if (iss !== issuer || type !== 'app' || !Array.isArray(aud) || !aud.includes(env.ADMIN_ACCESS_AUD)) return denied('emissor, tipo ou audiência');
    if (typeof exp !== 'number' || exp <= now || (nbf !== undefined && (typeof nbf !== 'number' || nbf > now))) return denied('validade');
    if (typeof sub !== 'string' || !sub || typeof email !== 'string' || email.toLowerCase() !== env.ADMIN_EMAIL!.toLowerCase()) return denied('identidade');

    let cache = keyCache.get(issuer);
    if (!cache || cache.expires <= Date.now()) {
      step = 'busca de chaves';
      const response = await fetch(issuer + '/cdn-cgi/access/certs', { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      if (!response.ok) return denied('consulta de chaves');
      const { keys } = await response.json() as { keys: JsonWebKey[] };
      if (!Array.isArray(keys)) return denied('formato de chaves');
      cache = { values: keys, expires: Date.now() + 300_000 };
      keyCache.set(issuer, cache);
    }
    const jwk = cache.values.find((key) => (key as JsonWebKey & { kid?: string }).kid === kid && key.kty === 'RSA');
    if (!jwk) return denied('chave desconhecida');
    step = 'importação de chave';
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    step = 'assinatura';
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signature), new TextEncoder().encode(header + '.' + payload))
      ? email.toLowerCase() : denied('assinatura inválida');
  } catch (error) {
    return denied(step + ' (' + (error instanceof Error ? error.name : 'erro') + ')');
  }
}

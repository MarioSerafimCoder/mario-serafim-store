import { imageIdPattern, skuPattern, slugPattern, statuses, versionPattern, type Details, type ProductRow, type Status, type StoreDB } from './catalog.ts';

export class AdminError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function plain(input: unknown, label: string, max: number, required = false) {
  if (typeof input !== 'string' || input.length > max || (required && !input.trim())) {
    throw new AdminError(label + ': preencha um valor válido.');
  }
  return input.trim();
}

function lines(input: unknown, label: string) {
  const values = plain(input, label, 1800).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (values.length > 30 || values.some((item) => item.length > 160)) throw new AdminError(label + ': limite de 30 itens de 160 caracteres.');
  return values;
}

export function httpsUrl(input: string, label: string) {
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* report a field error */ }
  throw new AdminError(label + ': informe uma URL HTTPS.');
}

export function priceInCents(value: unknown) {
  const price = plain(value, 'Preço', 10, true);
  if (!/^\d{1,6}(?:[,.]\d{1,2})?$/.test(price)) throw new AdminError('Informe o preço em reais, por exemplo 49,90.');
  const [whole, decimals = ''] = price.split(/[,.]/);
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}

export function validateProduct(input: Record<string, unknown>) {
  const sku = plain(input.sku, 'SKU', 80, true);
  const slug = plain(input.slug, 'Slug', 100, true);
  const name = plain(input.name, 'Nome', 127, true);
  const category = plain(input.category, 'Categoria', 80);
  const version = plain(input.version, 'Versão', 40, true);
  const status = input.status;
  if (!skuPattern.test(sku) || sku.startsWith('DEMO-')) throw new AdminError('Use letras maiúsculas, números e hífens no SKU.');
  if (!slugPattern.test(slug) || slug.startsWith('demo-')) throw new AdminError('Use letras minúsculas, números e hífens no slug.');
  if (!versionPattern.test(version)) throw new AdminError('Versão inválida. Use, por exemplo, 1.0.');
  if (typeof status !== 'string' || !Object.hasOwn(statuses, status)) throw new AdminError('Estado de publicação inválido.');
  if (!Array.isArray(input.images) || input.images.length > 12) throw new AdminError('Use até 12 prévias.');
  const images = input.images.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new AdminError('Prévia inválida.');
    const image = item as Record<string, unknown>;
    const src = plain(image.src, 'Endereço da prévia', 700, true);
    const width = Number(image.width), height = Number(image.height);
    if (![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 8000)) {
      throw new AdminError('Dimensões inválidas para uma prévia.');
    }
    return { src: /^\/midia\/[a-f0-9-]{36}$/.test(src) ? src : httpsUrl(src, 'Prévia'), width, height, alt: plain(image.alt, 'Texto alternativo', 200, true) };
  });
  const details: Details = {
    summary: plain(input.summary, 'Resumo', 300),
    description: plain(input.description, 'Descrição', 16000),
    images,
    includes: lines(input.includes, 'Conteúdo do pacote'),
    formats: lines(input.formats, 'Formatos'),
    requirements: lines(input.requirements, 'Requisitos'),
    license: { type: plain(input.licenseType, 'Tipo de licença', 100), summary: plain(input.licenseSummary, 'Licença', 1800) },
    featured: input.featured === true,
  };
  const product = { sku, slug, name, category, version, status: status as Status, price: priceInCents(input.price), details };
  if (product.status === 'published' || product.status === 'coming_soon') validatePublication(product);
  return product;
}

export function validatePublication({ category, details }: { category: string; details: Details }) {
  if (!category || !details.summary || !details.description || !details.images.length ||
      !details.includes.length || !details.formats.length || !details.license.type || !details.license.summary) {
    throw new AdminError('Complete categoria, resumo, descrição, capa, conteúdo, formatos e licença antes de publicar.');
  }
}

export function findProduct(db: StoreDB, sku: string) {
  return db.prepare('SELECT * FROM products WHERE sku=?').bind(sku).first<ProductRow>();
}

export function audit(db: StoreDB, actor: string, action: string, target: string, changesOnly = false) {
  return db.prepare('INSERT INTO admin_events(actor, action, target) SELECT ?,?,?' + (changesOnly ? ' WHERE changes()=1' : '')).bind(actor, action, target);
}

export async function saveProduct(db: StoreDB, actor: string, input: Record<string, unknown>, sku?: string) {
  const p = validateProduct(input);
  if (sku && p.sku !== sku) throw new AdminError('O SKU é permanente.');
  if (!sku && p.status === 'archived') throw new AdminError('Salve o produto antes de arquivar.');
  for (const { src } of p.details.images) {
    if (src.startsWith('/midia/') && !await db.prepare('SELECT id FROM product_images WHERE id=?').bind(src.slice(7)).first()) {
      throw new AdminError('Uma das prévias enviadas não está disponível.');
    }
  }
  const revision = Number(input.revision);
  if (sku && (!Number.isSafeInteger(revision) || revision < 1)) throw new AdminError('Revisão inválida.');
  const write = sku
    ? db.prepare(`UPDATE products SET slug=?,name=?,category=?,price_cents=?,version=?,status=?,details=?,updated_at=date('now'),revision=revision+1
        WHERE sku=? AND revision=? AND (status <> 'archived' OR ? = 'archived') RETURNING sku`)
      .bind(p.slug,p.name,p.category,p.price,p.version,p.status,JSON.stringify(p.details),p.sku,revision,p.status)
    : db.prepare('INSERT INTO products(sku,slug,name,category,price_cents,version,status,details) VALUES(?,?,?,?,?,?,?,?) RETURNING sku')
      .bind(p.sku,p.slug,p.name,p.category,p.price,p.version,p.status,JSON.stringify(p.details));
  try {
    const [result] = await db.batch([write, audit(db, actor, sku ? 'produto.editado' : 'produto.criado', p.sku, true)]);
    if (!result.results.length) throw new AdminError('O produto mudou. Reabra a edição antes de salvar.', 409);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new AdminError('O SKU ou o slug já está reservado.', 409);
    throw error;
  }
  return p.sku;
}

export async function productAction(db: StoreDB, actor: string, sku: string, action: string, input: Record<string, unknown>) {
  const current = await findProduct(db, sku);
  if (!current) throw new AdminError('Produto não encontrado.', 404);
  if (current.revision !== input.revision) throw new AdminError('O produto mudou. Atualize a página.', 409);
  if (action === 'duplicar') {
    const suffix = crypto.randomUUID().slice(0, 8);
    const copySku = current.sku.slice(0, 71).replace(/-+$/, '') + '-' + suffix.toUpperCase();
    const copySlug = current.slug.slice(0, 91).replace(/-+$/, '') + '-' + suffix;
    await db.batch([db.prepare(`
      INSERT INTO products(sku,slug,name,category,price_cents,version,status,details)
      VALUES(?,?,?,?,?,?,'draft',json_set(?, '$.featured', json('false')))
    `).bind(copySku, copySlug, current.name.slice(0, 120) + ' (cópia)', current.category, current.price_cents, current.version, current.details),
    audit(db, actor, 'produto.duplicado', copySku)]);
    return copySku;
  }
  const transitions: Partial<Record<Status, Record<string, Status>>> = {
    draft: { publicar: 'published', arquivar: 'archived' },
    coming_soon: { publicar: 'published', despublicar: 'draft', arquivar: 'archived' },
    published: { despublicar: 'draft', arquivar: 'archived' },
    archived: { restaurar: 'draft' },
  };
  const next = Object.hasOwn(transitions[current.status] ?? {}, action) ? transitions[current.status]?.[action] : undefined;
  if (!next) throw new AdminError('Ação indisponível neste estado.', 409);
  if (next === 'published') validatePublication({ category: current.category, details: JSON.parse(current.details) });
  const [result] = await db.batch([
    db.prepare("UPDATE products SET status=?,revision=revision+1,updated_at=date('now') WHERE sku=? AND revision=? RETURNING sku").bind(next, sku, current.revision),
    audit(db, actor, 'produto.' + action, sku, true),
  ]);
  if (!result.results.length) throw new AdminError('O produto mudou. Atualize a página.', 409);
  return sku;
}

export function imageMime(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  const at = (start: number, signature: number[]) => signature.every((byte, index) => view[start + index] === byte);
  if (view.length < 32) return null;
  if (at(0, [137,80,78,71,13,10,26,10]) && at(12, [73,72,68,82])) return 'image/png';
  if (at(0, [255,216,255])) return 'image/jpeg';
  if (at(0, [82,73,70,70]) && at(8, [87,69,66,80])) return 'image/webp';
  return null;
}

export async function publicImage(db: StoreDB, id: string, admin = false) {
  if (!imageIdPattern.test(id)) return new Response(null, { status: 404 });
  const image = await db.prepare(`SELECT mime,bytes FROM product_images WHERE id=?
    AND (?=1 OR EXISTS(SELECT 1 FROM products p, json_each(p.details,'$.images') image
      WHERE p.status IN ('published','coming_soon') AND json_extract(image.value,'$.src')=?))`)
    .bind(id, admin ? 1 : 0, '/midia/' + id).first<{ mime: string; bytes: ArrayBuffer | number[] }>();
  if (!image) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const bytes = Array.isArray(image.bytes) ? new Uint8Array(image.bytes) : image.bytes;
  return new Response(bytes, { headers: {
    'content-type': image.mime, 'cache-control': admin ? 'private, no-store' : 'public, max-age=60', 'x-content-type-options': 'nosniff',
  } });
}

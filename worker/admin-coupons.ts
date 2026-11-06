import { formatPrice } from '../src/lib/format.ts';
import { AdminError, audit, findProduct, priceInCents } from './admin-data.ts';
import { date, empty, html } from './admin-ui.ts';
import { skuPattern, type StoreDB } from './catalog.ts';
import { couponPattern, type Coupon } from './coupons.ts';

export async function saveCoupon(db: StoreDB, actor: string, data: Record<string,unknown>) {
  const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
  const {kind, value, expires, maxUses, active, revision} = data;
  if (!couponPattern.test(code) || (kind!=='percent' && kind!=='fixed') || typeof active!=='boolean' ||
      !Number.isInteger(revision) || Number(revision)<0 || !Number.isInteger(maxUses) || Number(maxUses)<1 || Number(maxUses)>100000) {
    throw new AdminError('Confira código, tipo, limite e estado.');
  }
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new AdminError('Informe a data de validade.');
  const end = Date.parse(expires + 'T00:00:00Z');
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0,10)!==expires) throw new AdminError('Data de validade inválida.');
  const expiry = end/1000 + 86400 + 10800;
  if (active && expiry <= Date.now()/1000) throw new AdminError('Use uma data futura para ativar o cupom.');
  const sku = typeof data.sku === 'string' ? data.sku.trim().toUpperCase() : '';
  if (sku && (!skuPattern.test(sku) || sku.length>80 || !await findProduct(db,sku))) throw new AdminError('SKU não encontrado.');
  const amount = kind==='percent' && typeof value==='string' && /^\d{1,2}$/.test(value) ? Number(value) : kind==='fixed' ? priceInCents(value) : 0;
  if (!amount) throw new AdminError('Use uma porcentagem de 1 a 99 ou um valor positivo em reais.');
  const values = [kind,amount,expiry,Number(maxUses),sku||null,Number(active)];
  const statement = revision === 0
    ? db.prepare('INSERT INTO coupons(kind,value,expires_at,max_uses,sku,active,code) VALUES(?,?,?,?,?,?,?) RETURNING code').bind(...values,code)
    : db.prepare(`UPDATE coupons SET kind=?,value=?,expires_at=?,max_uses=?,sku=?,active=?,revision=revision+1
      WHERE code=? AND revision=? AND ? >= (SELECT COUNT(*) FROM orders WHERE coupon_code=?) RETURNING code`)
      .bind(...values,code,Number(revision),Number(maxUses),code);
  try {
    const [written] = await db.batch([statement,audit(db,actor,'cupom.salvo',code,true)]);
    if (!written.results.length) throw new AdminError('O cupom foi alterado ou o limite é menor que os usos registrados.',409);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new AdminError('Já existe um cupom com esse código.',409);
    throw error;
  }
  return {saved:true};
}

function couponForm(row?: Coupon) {
  const expiry = row ? new Date((row.expires_at-10800-86400)*1000).toISOString().slice(0,10) : '';
  const value = row ? row.kind==='fixed' ? (row.value/100).toFixed(2).replace('.',',') : row.value : '';
  return `<form method="post" data-coupon><input type="hidden" name="revision" value="${row?.revision ?? 0}">
    <div class="fields"><label>Código <input name="code" value="${html(row?.code)}" maxlength="24" required${row?' readonly':''}></label>
    <label>Tipo <select name="kind"><option value="percent">Porcentagem</option><option value="fixed"${row?.kind==='fixed'?' selected':''}>Valor em reais</option></select></label>
    <label>Desconto <input name="value" inputmode="decimal" value="${value}" required maxlength="10"></label>
    <label>Validade (horário de Brasília) <input name="expires" type="date" value="${expiry}" required></label>
    <label>Limite de usos <input name="maxUses" type="number" min="1" max="100000" value="${row?.max_uses ?? 1}" required></label>
    <label>SKU opcional <input name="sku" value="${html(row?.sku)}" maxlength="80"></label></div>
    <label class="check"><input type="checkbox" name="active"${row?.active?' checked':''}> Cupom ativo</label><button class="primary">Salvar cupom</button></form>`;
}

export async function couponsPage(db: StoreDB, enabled: boolean, checkout: boolean, offset: number) {
  if (!enabled) return empty('Os cupons serão disponibilizados neste ambiente após validação do checkout.');
  const { results } = await db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM orders WHERE coupon_code=c.code) AS uses
    FROM coupons c ORDER BY c.code LIMIT 31 OFFSET ?`).bind(offset).all<Coupon>();
  return `<section class="panel"><h2>Novo cupom</h2>
    <p class="helper">Cada pedido criado com um cupom reserva um uso, mesmo se o pagamento não for concluído. O total cobrado precisa ser de pelo menos R$ 1,00.</p>
    ${checkout?'':'<p class="helper">O checkout está desativado neste ambiente. Os cupons ficam disponíveis para configuração e testes controlados.</p>'}
    ${couponForm()}</section>
    <section class="panel"><h2>Cupons cadastrados</h2>${results.length?results.slice(0,30).map(row=>`<details class="coupon-row">
    <summary><strong>${html(row.code)}</strong> · ${row.kind==='percent'?row.value+'%':formatPrice(row.value)} · ${!row.active?'Inativo':row.expires_at<=Date.now()/1000?'Vencido':row.uses>=row.max_uses?'Limite atingido':'Ativo'} · ${row.uses}/${row.max_uses} usos · até ${date(row.expires_at-1)}</summary>
    ${couponForm(row)}</details>`).join(''):empty('Nenhum cupom cadastrado.')}
    <nav class="pager" aria-label="Paginação">${offset?`<a href="?offset=${Math.max(0,offset-30)}">← Anteriores</a>`:''}${results.length>30?`<a href="?offset=${offset+30}">Próximos →</a>`:''}</nav></section>`;
}

const paths = {
  home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-6h6v6"/>',
  orders: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M8 12h8m-8 4h5"/>',
  products: '<path d="m12 3 9 5v8l-9 5-9-5V8zm0 9 9-4m-9 4L3 8m9 4v9"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  reports: '<path d="M4 4v16h16M8 15v-3m5 3V8m5 7V5"/>',
  discounts: '<path d="M3 4h9l9 9-8 8-9-9z"/><circle cx="8" cy="8" r="1"/>',
  apps: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2"/>',
  external: '<path d="M14 4h6v6m0-6-9 9m7 0v7H4V6h7"/>',
  logout: '<path d="M12 4H4v16h8m-3-8h12m-4-4 4 4-4 4"/>',
} as const;

function icon(name: keyof typeof paths) {
  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function navigation(active: string, logout: string) {
  const link = (url: string, label: string, glyph?: keyof typeof paths) =>
    `<a href="${url}"${active === url ? ' aria-current="page"' : ''}>${glyph ? icon(glyph) : ''}<span>${label}</span></a>`;
  const products = ['/admin/produtos','/admin/produtos/novo','/admin/produtos/categorias','/admin/arquivos'];
  return `<aside class="admin-sidebar">
  <details class="admin-navigation" open><summary>Menu do painel</summary>
  <nav aria-label="Painel"><p class="nav-label">Gerenciamento</p>
    ${link('/admin','Início','home')}${link('/admin/pedidos','Pedidos','orders')}
    <details class="nav-products"${products.includes(active) ? ' open data-active' : ''}>
      <summary>${icon('products')}<span>Produtos</span></summary><div class="nav-sub">
      ${link(products[0],'Todos os produtos')}${link(products[1],'Novo produto')}${link(products[2],'Categorias')}${link(products[3],'Arquivos digitais')}
      </div></details>
    ${link('/admin/clientes','Clientes','people')}${link('/admin/relatorios','Relatórios','reports')}
    ${link('/admin/descontos','Descontos','discounts')}${link('/admin/integracoes','Apps e integrações','apps')}
    <p class="nav-label">Canais de venda</p>${link('/admin/loja-online','Loja online','store')}
  </nav><nav class="aux" aria-label="Preferências e sessão">
  ${link('/admin/configuracoes','Configurações','settings')}${link('/','Visualizar loja','external')}${link(logout,'Sair','logout')}
  </nav></details></aside>`;
}

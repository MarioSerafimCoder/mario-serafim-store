export const storeSupport = {
  email: 'contato@marioserafim.com.br',
  phone: '(85) 98186-6552',
  whatsapp: `https://wa.me/5585981866552?text=${encodeURIComponent('olá quero ajuda com o meu produto')}`,
} as const;

export const site = {
  name: 'Mário Serafim Store',
  tagline: 'Produtos digitais',
  description: 'Catálogo de produtos digitais de Mário Serafim.',
  nav: [
    { label: 'Produtos', href: '/produtos/' },
    { label: 'Pedidos', href: '/compras/' },
    { label: 'Sobre', href: '/sobre/' },
    { label: 'Licenças', href: '/licencas/' },
  ],
  footer: {
    store: [
      { label: 'Produtos', href: '/produtos/', external: false },
      { label: 'Sobre', href: '/sobre/', external: false },
      { label: 'Pedidos', href: '/compras/', external: false },
      { label: 'Portfólio', href: 'https://marioserafim.com.br', external: true },
    ],
    help: [
      { label: 'Central de Ajuda', href: '/contato/' },
      { label: 'Entrega digital e dúvidas', href: '/entrega-digital/' },
      { label: 'Cancelamentos e reembolsos', href: '/reembolsos/' },
    ],
    legal: [
      { label: 'Termos de uso', href: '/termos/' },
      { label: 'Privacidade', href: '/privacidade/' },
      { label: 'Licenças', href: '/licencas/' },
    ],
  },
  officialContact: '/contato/',
} as const;

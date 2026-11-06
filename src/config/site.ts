export const site = {
  name: 'Mário Serafim Store',
  tagline: 'Produtos digitais',
  description: 'Catálogo de produtos digitais de Mário Serafim.',
  nav: [
    { label: 'Produtos', href: '/produtos/' },
    { label: 'Minha compra', href: '/compras/' },
    { label: 'Sobre', href: '/sobre/' },
    { label: 'Licenças', href: '/licencas/' },
  ],
  footer: {
    store: [
      { label: 'Produtos', href: '/produtos/', external: false },
      { label: 'Sobre', href: '/sobre/', external: false },
      { label: 'Minha compra', href: '/compras/', external: false },
      { label: 'Portfólio', href: 'https://marioserafim.com.br', external: true },
    ],
    help: [
      { label: 'Contato', href: '/contato/' },
      { label: 'Entrega digital e dúvidas', href: '/entrega-digital/' },
      { label: 'Cancelamentos e reembolsos', href: '/reembolsos/' },
    ],
    legal: [
      { label: 'Termos de uso', href: '/termos/' },
      { label: 'Privacidade', href: '/privacidade/' },
      { label: 'Licenças', href: '/licencas/' },
    ],
  },
  officialContact: 'https://marioserafim.com.br/contato/',
} as const;

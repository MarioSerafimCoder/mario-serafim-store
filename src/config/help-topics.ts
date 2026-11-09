interface HelpIssue {
  id: string;
  title: string;
  guidance: string;
  link?: string;
  label?: string;
  order?: boolean;
  urgent?: boolean;
}

interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  order?: boolean;
  issues: HelpIssue[];
}

export const helpTopics: HelpTopic[] = [
  {
    id: 'compra', title: 'Preciso de ajuda com uma compra', summary: 'Pagamento, entrega e acesso aos arquivos.', order: true,
    issues: [
      { id: 'nao-recebi', title: 'Não recebi meu produto', guidance: 'Confira se o pagamento foi aprovado em Pedidos. Se estiver aprovado, procure o e-mail de entrega também em Spam e Promoções. Você pode baixar os arquivos autorizados em Pedidos.', link: '/compras/', label: 'Consultar meus pedidos', urgent: true },
      { id: 'download', title: 'Meu link de download não funciona', guidance: 'Os links por e-mail expiram. Abra Pedidos no navegador usado na compra para acessar um novo download. Em outro dispositivo, use o código de recuperação na própria página de Pedidos.', link: '/compras/', label: 'Acessar meus downloads', urgent: true },
      { id: 'pagamento', title: 'Dúvidas sobre o pagamento', guidance: 'A entrega é liberada após a aprovação pelo Mercado Pago. Consulte o status em Pedidos. Se houver divergência, envie ao suporte o número do pedido e descreva o que aparece na tela.', link: '/compras/', label: 'Conferir o pagamento' },
      { id: 'arquivo', title: 'Recebi um arquivo incorreto', guidance: 'Compare o arquivo recebido com o conteúdo descrito na página do produto. Se houver diferença, informe ao suporte o nome do produto, o arquivo recebido e o que você esperava.', link: '/compras/', label: 'Consultar meus pedidos' },
    ],
  },
  {
    id: 'produto', title: 'Tenho dúvidas sobre um produto', summary: 'Formatos, compatibilidade e instruções de uso.',
    issues: [
      { id: 'antes', title: 'Informações antes da compra', guidance: 'A página do produto reúne as prévias, o conteúdo incluído e a licença. Se alguma informação faltar, diga ao suporte qual produto você está avaliando.', link: '/produtos/', label: 'Explorar o catálogo' },
      { id: 'formatos', title: 'Compatibilidade e formatos', guidance: 'Confira os formatos e requisitos na página do produto e compare com o software e a versão que você usa.', link: '/produtos/', label: 'Consultar os produtos' },
      { id: 'utilizar', title: 'Como utilizar o produto', guidance: 'Confira os requisitos e as instruções incluídas no produto. Se precisar de ajuda, informe o nome do arquivo, o software usado e a etapa em que encontrou dificuldade.', link: '/produtos/', label: 'Consultar os produtos' },
    ],
  },
  {
    id: 'licencas', title: 'Licenças e reembolsos', summary: 'Permissões de uso, cancelamento e reembolso.',
    issues: [
      { id: 'termos', title: 'Termos de utilização', guidance: 'As permissões de uso dependem da licença descrita na página de cada produto. A página de Licenças explica como consultar essas condições.', link: '/licencas/', label: 'Ler sobre licenças' },
      { id: 'reembolso', title: 'Solicitar reembolso', order: true, guidance: 'A política explica como solicitar cancelamento ou exercer o direito de arrependimento. O download do arquivo não impede automaticamente esse direito. Para iniciar a solicitação, informe o produto e o número do pedido, se disponível.', link: '/reembolsos/', label: 'Consultar a política de reembolsos' },
      { id: 'comercial', title: 'Uso comercial do produto', guidance: 'Verifique se a licença específica do item autoriza o uso comercial que você pretende fazer. Se tiver dúvida, descreva o projeto ao suporte.', link: '/licencas/', label: 'Consultar as licenças' },
    ],
  },
  {
    id: 'outros', title: 'Outros assuntos', summary: 'Parcerias, propostas e dúvidas gerais.',
    issues: [
      { id: 'parcerias', title: 'Parcerias e propostas', guidance: 'Para enviar uma proposta, conte brevemente quem você representa, qual é a ideia e como podemos falar com você.' },
      { id: 'outras', title: 'Outras dúvidas', guidance: 'Descreva sua dúvida e inclua o nome do produto, se for relevante. Isso ajuda o suporte a entender o contexto.' },
    ],
  },
];

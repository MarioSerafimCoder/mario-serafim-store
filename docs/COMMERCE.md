# Checkout e entrega digital

A vitrine Astro continua estática. O Worker intercepta `/compras/api/*` e `/compras/retorno/*`. O catálogo de compra é derivado dos produtos publicados e exclui SKUs `DEMO-*` e slugs `demo-*`. O preço e o arquivo são validados no servidor antes de criar o pedido.

A aplicação `Check-out-pro` usa Checkout Pro com a API de Orders. Use a [documentação da integração](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/overview) e a [referência de webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/notifications?scope=prod).

## Homologação

- Execute `npm ci`, `npm run check`, `npm run build` e `npm test`.
- Use `wrangler d1 migrations apply DB --env homologacao --remote` para aplicar migrations.
- Publique com `wrangler deploy --env homologacao`. O ambiente começa com `CHECKOUT_ENABLED=false`.
- No painel Mercado Pago, configure o tópico `orders_v2` no ambiente **Teste** e a URL `https://mario-serafim-store-homologacao.marioserafim-da.workers.dev/compras/api/webhook`.
- Defina `MP_SELLER_ID` com o ID do vendedor do ambiente. Instale `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `STORE_SESSION_SECRET` por `wrangler secret put <NOME> --env homologacao` ou pelo painel da Cloudflare. Use valores distintos em produção. A chave de sessão deve ter pelo menos 32 caracteres aleatórios. Guarde o token no cofre do Worker.
- Use a credencial de vendedor de teste indicada para **Checkout Pro com Orders** e um comprador de teste separado. Confirme o ID do vendedor, o prefixo da order de teste, o retorno e o webhook com uma compra simulada oficial antes de habilitar produção.
- Quando o R2 estiver disponível, use um bucket privado exclusivo para homologação e vincule-o como `FILES`. Cadastre um produto de homologação apenas no build desse ambiente, envie seu arquivo ao bucket e habilite o SKU em `fulfillment`. Só então habilite `CHECKOUT_ENABLED` em homologação.

## Produção e operação

- Use um banco D1 de produção distinto, aplique `migrations/0001_commerce.sql` e vincule-o como `DB`. Configure um bucket R2 privado de produção como `FILES`, com acesso público desabilitado.
- Cadastre o arquivo comercial em uma chave imutável por SKU e versão e habilite a linha correspondente em `fulfillment`. Campos obrigatórios são `sku`, `version`, `object_key`, `filename` e `enabled`. Não substitua objetos vinculados a pedidos já criados.
- Configure os secrets e o ID do vendedor de produção. A URL de webhook de produção é `https://loja.marioserafim.com.br/compras/api/webhook`. A configuração do domínio de produção deve ser mantida no Worker que atende a loja.
- Antes de habilitar vendas, confirme a homologação oficial, Pix e cartão habilitados na conta, arquivos privados e textos comerciais revisados. Ative `CHECKOUT_ENABLED=true` apenas com produtos reais publicados e entregáveis.
- O comprador guarda o código de recuperação apresentado antes do redirecionamento e consulta `/compras/`. O Worker valida a sessão, confirma o status novamente no Mercado Pago e serve o arquivo protegido com uma autorização de cinco minutos.
- Para investigar pedidos, consulte `orders` e `order_events` por ID interno. O status aprovado é o direito de acesso, revogado após estorno ou contestação. O cron reconcilia pedidos recentes e o comprador pode solicitar atualização pelo botão.
- Para suspender novas vendas, publique `CHECKOUT_ENABLED=false`. Preserve os secrets, as tabelas e os objetos para reconciliação e acesso de compradores existentes. Guarde o identificador do deploy anterior e use rollback do Worker se precisar recuperar a vitrine.

O R2 exige ativação da assinatura na conta. O catálogo real está vazio. A vitrine pública de demonstração segue separada e as simulações automatizadas não substituem os testes oficiais do Mercado Pago.

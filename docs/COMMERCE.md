# Checkout e entrega digital

A vitrine Astro e o checkout leem o mesmo catálogo D1 nos Workers publicados. O Worker intercepta `/compras/api/*` e `/compras/retorno/*`. O catálogo de compra exclui SKUs `DEMO-*` e slugs `demo-*`. O preço e o arquivo são validados antes de criar o pedido. Quando o preço visto pelo comprador diverge do D1, o Worker pede que ele recarregue a página.

A aplicação `Check-out-pro` usa Checkout Pro com a API de Orders. Use a [documentação da integração](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/overview) e a [referência de webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/notifications?scope=prod).

Nas páginas de produto, **Comprar agora** inicia um pedido individual e redireciona diretamente ao Mercado Pago. **Adicionar ao carrinho** guarda os produtos neste navegador; finalizar o carrinho envia uma única Order, com até dez produtos. O Worker revalida preço, publicação, arquivo privado e cupons de cada linha antes de criar a cobrança. A aprovação e os estornos são conciliados para todas as linhas do carrinho; cada arquivo aprovado continua sendo baixado separadamente em `/compras/`.

## Homologação

- Execute `npm ci`, `npm run check`, `npm run build` e `npm test`.
- Use `wrangler d1 migrations apply DB --env homologacao --remote` para aplicar migrations.
- A migration `0005_cart_checkout.sql` adiciona o registro do pagamento agregado e vincula as linhas do carrinho aos pedidos. A migration `0006_commercial_identity.sql` adiciona campos opcionais de identificação comercial em `store_settings`; preencha-os no painel apenas após validar os dados. Aplique as migrations pendentes antes de publicar esta versão.
- Publique com `npm run deploy:homologacao`. O ambiente começa com `CHECKOUT_ENABLED=false`.
- No painel Mercado Pago, configure o evento **Order (Mercado Pago)** no ambiente **Teste** e a URL `https://mario-serafim-store-homologacao.marioserafim-da.workers.dev/compras/api/webhook`.
- Defina `MP_SELLER_ID` com o ID do vendedor do ambiente. Instale `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `STORE_SESSION_SECRET` por `wrangler secret put <NOME> --env homologacao` ou pelo painel da Cloudflare. Use valores distintos em produção. A chave de sessão deve ter pelo menos 32 caracteres aleatórios. Guarde o token no cofre do Worker.
- Use a credencial de vendedor de teste indicada para **Checkout Pro com Orders** e um comprador de teste separado. Confirme o ID do vendedor, o prefixo da order de teste, o retorno e o webhook com uma compra simulada oficial antes de habilitar produção.
- Quando o R2 estiver disponível, use um bucket privado exclusivo para homologação e vincule-o como `FILES`. Cadastre um produto no painel desse ambiente, envie seu arquivo e permita novas entregas. Só então habilite `CHECKOUT_ENABLED` em homologação.

## Conteúdo institucional

`/contato/` encaminha ao canal público do portfólio, a menos que uma URL de atendimento confirmada seja configurada no painel. `/entrega-digital/` descreve o fluxo observado e reúne as perguntas frequentes. Termos, privacidade, licenças e reembolsos estão marcados como conteúdo preliminar sem indexação enquanto dados e condições comerciais aguardam validação. Não preencha CPF/CNPJ, endereço ou e-mail por suposição; os campos são opcionais e exibidos publicamente quando completos.

### Cupons

`COUPONS_ENABLED=true` libera o módulo no ambiente configurado. O formulário público também depende de um checkout disponível para o SKU. O cupom reduz o valor do item e o total enviado à Orders API na mesma proporção. A reconciliação verifica esse total gravado no pedido. Cada pedido com cupom consome uma reserva, inclusive em abandono. Antes de habilitar cupons em produção, valide um pagamento de teste com desconto, reconciliação e entrega no R2.

## Produção e operação

- Use um banco D1 de produção distinto, aplique `migrations/0001_commerce.sql` e vincule-o como `DB`. Configure um bucket R2 privado de produção como `FILES`, com acesso público desabilitado.
- Cadastre o arquivo comercial em uma chave imutável por SKU e versão e habilite a linha correspondente em `fulfillment`. Campos obrigatórios são `sku`, `version`, `object_key`, `filename` e `enabled`. Não substitua objetos vinculados a pedidos já criados.
- Configure os secrets e o ID do vendedor de produção. A URL de webhook de produção é `https://loja.marioserafim.com.br/compras/api/webhook`. A configuração do domínio de produção deve ser mantida no Worker que atende a loja.
- Antes de habilitar vendas, confirme a homologação oficial, Pix e cartão habilitados na conta, arquivos privados e textos comerciais revisados. Ative `CHECKOUT_ENABLED=true` apenas com produtos reais publicados e entregáveis.
- O redirecionamento ao Mercado Pago é direto. A chave de recuperação fica armazenada na sessão do navegador; após o retorno, `/compras/` valida a sessão, confirma o status novamente no Mercado Pago e mostra um botão de download individual por arquivo com autorização de cinco minutos.
- Para investigar pedidos, consulte `orders` e `order_events` por ID interno. O status aprovado é o direito de acesso, revogado após estorno ou contestação. O cron reconcilia pedidos recentes e o comprador pode solicitar atualização pelo botão.
- Para suspender novas vendas, publique `CHECKOUT_ENABLED=false`. Preserve os secrets, as tabelas e os objetos para reconciliação e acesso de compradores existentes. Guarde o identificador do deploy anterior e use rollback do Worker se precisar recuperar a vitrine.

O Worker de homologação está publicado com D1 e os quatro valores protegidos `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_SELLER_ID` e `STORE_SESSION_SECRET`. O simulador oficial confirmou o recebimento do webhook de teste. A compra de teste com entrega privada segue pendente porque o R2 exige ativação da assinatura na conta. O catálogo real está vazio e a vitrine pública de demonstração segue separada, com vendas desativadas.

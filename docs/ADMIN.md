# Administração da loja

Acesse [o painel](https://loja.marioserafim.com.br/admin) e escolha **Cloudflare** para entrar com a conta do proprietário. O Access protege `/admin` e suas subrotas. A sessão do aplicativo dura 30 minutos. O Worker valida assinatura, emissor, audiência, validade e e-mail a cada operação. **Sair** encerra a sessão do Cloudflare Access.

Em **Produtos → Novo produto**, informe nome, SKU, slug e preço. Salve o rascunho. Preencha categoria, resumo, descrição, capa, conteúdo, formatos e licença antes de publicar. Use **Prévia salva** para conferir o resultado. A primeira imagem é a capa. Use **Despublicar** ou **Arquivar** para retirar da vitrine. Restaurar devolve o produto ao estado de rascunho. O SKU é permanente, e os slugs públicos anteriores redirecionam para o atual quando o produto está na vitrine.

A home, a listagem, as páginas de produto e o sitemap leem o D1. A revisão do catálogo muda junto com o registro e invalida as páginas em cache em todos os pontos de presença. As prévias JPEG, PNG e WebP enviadas pelo editor ficam no D1 e recebem URL pública enquanto associadas a produtos visíveis. O catálogo Markdown real estava vazio na migração. As três entradas de demonstração permanecem apenas como fixtures no repositório.

## Operação técnica

- Use `npm run check`, `npm run build` e `npm test`. O build estático preserva a validação das coleções Markdown para prévias locais e fixtures. `npm run build:worker` gera o Worker Astro para o catálogo operacional.
- Use `wrangler d1 migrations apply DB --config wrangler.jsonc --env homologacao --remote` para o D1 de teste e o mesmo comando sem `--env homologacao` para o banco de produção. Os bancos são distintos. As tabelas comerciais `orders`, `order_events` e `fulfillment` continuam sendo usadas.
- A migration `0002_admin.sql` acrescenta `products`, `product_slugs`, `product_images`, `catalog_revision`, `store_settings`, `admin_events` e `admin_rate`. Pedidos guardam o SKU, o título, o preço e o arquivo do momento da compra. Arquivamento e alterações de preço não modificam pedidos anteriores.
- Use `npm run deploy:homologacao` e, após validar, `npm run deploy:producao`. O script verifica o Worker, o D1 e o domínio antes do envio. Guarde o ID da última versão saudável para rollback. O Worker que atende o domínio mantém o nome histórico.
- As audiências do Access são distintas. Configure `ADMIN_EMAIL` como secret em cada Worker. Não coloque o e-mail autorizado em arquivos públicos. O Access mantém uma política de igualdade de e-mail para o proprietário.
- O painel apenas consulta a situação do checkout. A habilitação depende do fluxo em [COMMERCE.md](COMMERCE.md). Para entrega digital, o R2 deve estar vinculado a `FILES` sem acesso público. Faça upload por SKU e versão, confira a disponibilidade e permita novas entregas na área **Arquivos digitais**. Cada versão tem uma chave imutável. Arquivar um produto ou bloquear novas vendas de uma versão preserva os direitos dos pedidos anteriores.
- A conta atingiu a cota gratuita de agendamentos. O cron de homologação permanece ativo. Antes de abrir vendas, disponibilize um agendamento para produção e valide a reconciliação completa. O webhook e a atualização pelo comprador continuam implementados.

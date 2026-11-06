# Mário Serafim Store · Etapa 1

## Base técnica

- Astro estático, TypeScript, Tailwind CSS e Content Collections. A compilação gera `dist/`.
- `wrangler.jsonc` aponta para Cloudflare Workers Static Assets e usa `404.html` para rotas desconhecidas.
- Base [Codrops / Isle Thorne Collective](https://github.com/codrops/isle-thorne-collective/tree/0d859ac0f3f69e8051e22873ba1eeb328f95c736), revisão `0d859ac0f3f69e8051e22873ba1eeb328f95c736`. MIT preservada em `LICENSE`.
- Instrument Sans é servida localmente sob OFL 1.1. O build inclui os avisos de licença em `avisos-legais.txt`.

## Rotas

- `/` apresenta a loja e exibe os produtos destacados quando houver algum.
- `/produtos/` lista o catálogo. A ordenação aparece a partir de dois produtos e o filtro, a partir de duas categorias.
- `/produtos/[slug]/` mostra descrição, detalhes, licença e prévias otimizadas.
- `/sobre/` e `/licencas/` apresentam o criador e o licenciamento.
- `/termos/` e `/privacidade/` têm uma estrutura para revisão, com `noindex`.
- `/404` usa a página de erro gerada em `dist/404.html`.

## Catálogo

Crie um Markdown por produto em `src/content/products/`. Coloque as prévias em `src/assets/products/` e referencie-as por caminho relativo. Apenas prévias podem entrar no projeto. O corpo do Markdown é a descrição detalhada.

Exemplo de estrutura para preencher durante a edição de um rascunho.

```md
---
sku: SKU-ESTAVEL
slug: slug-do-produto
name: Nome do produto
summary: Resumo curto para o catálogo e o compartilhamento.
category: Nome da categoria
priceCents: 0
currency: BRL
images:
  - src: ../../assets/products/nome-da-previa.png
    alt: Descrição da prévia
includes: [Conteúdo incluído]
formats: [Formato digital]
requirements: []
license:
  type: Tipo da licença
  summary: Resumo das condições de uso
version: "1.0"
updatedAt: "2026-11-05"
featured: false
status: draft
---

Descrição detalhada do produto.
```

- Mantenha o SKU original em edições. SKU e slug são únicos, inclusive entre rascunhos.
- Use maiúsculas, números e hífens no SKU. Use minúsculas, números e hífens no slug.
- Use centavos inteiros em `priceCents` e informe `updatedAt` como texto no formato AAAA-MM-DD.
- `draft` é o padrão e fica fora da vitrine, das rotas e do sitemap. `coming_soon` exibe “Em breve”. `published` exibe o preço. Nos dois estados públicos, a compra está indisponível.
- `src/content.config.ts` valida os campos. `src/lib/shop.ts` valida unicidade e descrição, reúne a leitura do catálogo e define URLs.
- O catálogo começa vazio. Os avisos do Astro sobre a coleção vazia são esperados até a primeira entrada.

## Desenvolvimento e interface

Com Node.js 22.12 ou superior e npm disponível, execute `npm ci`.

- `npm run dev` abre a vitrine local.
- `npm run check` verifica os tipos e carrega as coleções.
- `npm run build` gera o site e valida as regras do catálogo.
- `npm run preview` serve o build localmente.
- `npm test` compila um projeto temporário com fixtures e verifica as rotas e a publicação.

O Sol pode editar `src/pages/`, `src/components/`, `src/layouts/BaseLayout.astro`, `src/config/site.ts` e `src/styles/global.css`. Os tokens incluem `paper`, `brand`, `brand-deep`, `font-sans` e os tamanhos `text-label`, `text-copy`, `text-body`, `text-title` e `text-heading`. A galeria usa imagens responsivas sem script. Antes da abertura, revisar apresentação, identidade, prévias, licenças e textos legais.

## Contratos para fases futuras

A vitrine desta etapa não coleta pedidos, recebe pagamentos, autentica clientes nem libera arquivos. Não há Worker executável, credenciais ou armazenamento persistente.

| Dado | Contrato reservado |
| --- | --- |
| Produto | `sku` imutável e independente do slug |
| Preço | `priceCents` inteiro e `currency: BRL`. O servidor deve consultar a fonte autorizada e fixar esses valores no pedido. |
| Disponibilidade | `status` controla exposição pública. O servidor deve verificar se o produto pode ser vendido antes de criar o pedido. |
| Pedido | `orderId` opaco, gerado no servidor e vinculado ao SKU e ao preço confirmado |
| Pagamento | `paymentReference` do Mercado Pago vinculada ao pedido; reconciliar pelo servidor com valor e moeda |
| Liberação | `orderId` e SKU identificam a autorização de entrega; só conceder após confirmação autenticada no servidor, de modo idempotente |

Na fase Mercado Pago, validar a origem da confirmação e consultar o provedor no servidor. Preço, retorno de navegação e estado de pagamento fornecidos pelo navegador não autorizam cobrança ou entrega. Os arquivos de entrega precisarão de armazenamento privado, separado das prévias públicas.

## Interface da etapa 2

- A home apresenta até três destaques. Categorias e relacionados são derivados do catálogo público.
- Para incluir uma FAQ, acrescente o título Markdown `### Perguntas frequentes` e as respostas no corpo do produto. A página cria um atalho quando encontra o título.
- A arte do hero é vetorial e editorial. As prévias da galeria devem vir dos produtos reais.

## Demonstração publicada

- Em 05/11/2026, o domínio `loja.marioserafim.com.br` foi vinculado ao Worker `mario-serafim-store-demo-ed0faa` como domínio personalizado.
- As três entradas e suas capas estão em `tests/demo/`. A publicação usa uma cópia temporária com essas entradas, um aviso de demonstração e o cabeçalho `X-Robots-Tag: noindex, nofollow`.
- O catálogo normal em `src/content/products/` segue separado dos dados de teste. Antes do lançamento, substituir o build de demonstração no Worker por um build com produtos reais e revisar a indexação.

## Checkout Pro

O Worker, as migrations e a interface de compras estão no repositório. A homologação e a configuração de produção seguem o [guia de operação do checkout](COMMERCE.md).

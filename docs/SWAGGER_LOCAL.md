# Swagger local na edição experimental

Swagger UI é uma página para consultar o contrato HTTP e executar requisições. Ele não substitui o painel de carga: um serve para explorar endpoints; o outro analisa resultados dos experimentos.

## Estado atual

Implementado somente como opção da edição experimental, sem alterar o bootstrap/API financeiros originais nem o pacote essencial. A especificação OpenAPI 3.0.3 é mantida manualmente em `scripts/swagger/openapi.json`. Swagger UI **5.34.0** e sua dependência estão fixados em `scripts/swagger/package.json` e `bun.lock` próprios.

Não adicionamos autenticação, novas regras financeiras ou dependência Swagger ao package.json principal. A imagem local serve os assets instalados, sem CDN ou validador remoto no navegador. O servidor Swagger recusa NODE_ENV=production e exige o modo financeiro local explícito e o usuário de banco restrito.

## Iniciar e acessar

Na pasta `entrega_teste`, com a configuração `.env` correspondente ao seu volume:

```sh
sh entrega.sh init
sh entrega.sh up
sh swagger.sh up
```

`init` preserva um arquivo existente; não rotaciona senha de banco. Se o volume já existe, use a senha original. `swagger.sh up` troca somente o serviço API para uma imagem local com documentação; banco, worker e dados são preservados.

Portas padrão:

- Swagger: **http://127.0.0.1:3000/docs**.
- Contrato JSON: **http://127.0.0.1:3000/openapi.json**.
- Prontidão: **http://127.0.0.1:3000/health/ready**.
- Relatórios: **http://127.0.0.1:38080**, iniciado separadamente com `sh experimento.sh dashboard`.

Se a porta da API foi alterada no `.env`, ajuste essas URLs. O Swagger usa a mesma origem da API, sem habilitar CORS globalmente. O “Try it out” envia requisições reais e POSTs criam dados sintéticos na demonstração; não é uma simulação.

## Roteiro de estudo

1. Abra `GET /health/live`, clique **Try it out** e depois **Execute**: espere HTTP 200.
2. Em `POST /wallets`, use um playerId UUID novo e saldo `"100.00"`. Execute e copie o `id` da resposta.
3. Em `POST /wagering/transactions`, preencha a carteira e o mesmo jogador; use BET `"25.00"`, provedor/identidade externa próprios e uma chave idempotente, por exemplo `swagger-local:bet-002`.
4. Execute: saldo esperado `75.00`. Repita chave/corpo sem alterações: replay true, sem outro débito.
5. Mude a quantia mantendo chave/identidade: HTTP 409, sem reaplicar efeito. Não troque apenas a chave da mesma identidade externa esperando uma operação nova.
6. Consulte carteira, ledger e reconciliação; a consulta atual reflete o saldo presente e o replay preserva seu resultado histórico.

Os valores de exemplo no formulário não são gerados automaticamente para cada envio. Repetir jogador/moeda na criação resulta em conflito 409. Para outra rodada, use novas identidades e uma carteira apropriada; não altere a chave de um comando já registrado para tentar corrigir seu conteúdo.

Dinheiro é texto decimal, como `"25.00"`. LOSS exige zero; demais tipos externos exigem positivo. REFUND/ROLLBACK exigem referência integral válida; WIN pode ter referência opcional. OPENING é somente interno.

## Voltar ao modo anterior

```sh
sh swagger.sh off
```

Isso restaura o serviço API pelo fluxo normal `entrega.sh up`, sem apagar volume. Para parar a demonstração, `sh entrega.sh stop`. Para parar o painel/carga, `sh experimento.sh stop`.

Swagger não participa do caminho medido pelo runner: os testes de carga criam suas próprias instâncias, filas e schemas. API da demonstração e infraestrutura de carga são separadas para não poluir as carteiras usadas manualmente. Os experimentos ainda compartilham o host e não validam capacidade universal.

## Validação

- Três testes unitários: contrato textual de dinheiro, cabeçalho obrigatório/status distintos, cobertura de dez caminhos/identidades e recusa em produção antes de conectar ao banco.
- Assets, JSON OpenAPI e readiness com HTTP 200.
- Chrome headless renderizou os dez caminhos e executou GET /health/live via Try it out, com HTTP 200.
- Chamadas locais criaram carteira e BET, confirmaram replay, conflito 409 e reconciliação consistente.

A especificação é manual: mudanças futuras nos controllers precisam ser refletidas nela. Não há geração automática por decorators @nestjs/swagger nesta opção local. O uso do pacote de assets segue a [instalação oficial do Swagger UI](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/) e sua [configuração](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/).

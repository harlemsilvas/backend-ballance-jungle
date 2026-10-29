# Eventos de integração e hash canônico

Implementados em 26/10/2026. Este documento descreve o contrato local e seus limites; publisher também implementado (MESSAGING.md); idempotência persistente e gravação na outbox agora implementadas nos casos de uso descritos em FINANCIAL_PROCESSING.md.

## 1. Normalização compartilhada

Código: `src/application/wager-request.ts`.

- `prepareWagerCommand(body, idempotencyKey)` é usado pelo adaptador HTTP implementado. A chave deve vir explicitamente do header; nunca substituída pelo valor recomendado.
- `prepareSqsWagerRequest(envelope)` valida o envelope WagerTransactionRequested, separa a chave no campo data e chama o mesmo normalizador.
- `normalizeWagerPayload` valida formato e tipos, rejeita campos desconhecidos, OPENING e referências nulas/undefined explícitas. Não normaliza identificadores por trim: espaços nas bordas são rejeitados para evitar associações silenciosas.
- Contratos externos deste normalizador aceitam somente BRL, conforme redução de escopo permitida. Money continua multi-moeda e os testes de conflito usam outras moedas.
- Regras como BET positiva, LOSS zero, exigência/tipo da referência e valor de reversão permanecem na factory WagerTransaction; o normalizador não aplica uma operação financeira.

Envelope SQS requer messageId, type, occurredAt e data, sem campos extras. occurredAt deve ser ISO UTC canônico com milissegundos, como `2026-10-26T12:00:00.000Z`. CorrelationId/atributos de broker não devem ser injetados no corpo de negócio; adaptadores mantêm a correlação em contexto separado. Mensagens com outro contrato exigirão uma versão explícita, sem descartar campos desconhecidos silenciosamente.

## 2. Algoritmo exato do hash

1. Validar o corpo e reconstruir somente providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money e a referência opcional.
2. Money.from rejeita entradas inválidas e produz amount com duas casas. Assim, `25`, `25.0` e `25.00` geram `25.00`; não há arredondamento de escala excedente.
3. Se a referência não foi enviada, omitir a chave. null e undefined explícitos são inválidos.
4. Ordenar recursivamente as chaves com a ordenação padrão de strings JavaScript (UTF-16). Os nomes de campos deste contrato são ASCII. Serializar chaves e valores string com JSON.stringify; unir com vírgula e dois-pontos, sem espaços.
5. Codificar o JSON resultante em UTF-8, calcular SHA-256 e representar digest como 64 caracteres hexadecimais minúsculos.

É uma canonicalização restrita a este contrato (strings e objetos), não uma implementação genérica de RFC 8785. Não há normalização Unicode de valores: dois identificadores com formas Unicode diferentes continuam diferentes. Não há números monetários no JSON. Os objetos resultantes são cópias congeladas, inclusive money.

Excluídos do hash: Idempotency-Key/idempotencyKey, messageId, occurredAt de transporte, correlationId, receipt handles e IDs internos. Metadados não são ignorados se vierem como campos extras do body: são rejeitados e devem permanecer no contexto do adaptador.

### Vetor conhecido

Entrada de negócio:

```json
{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"wallet-1","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}
```

JSON canônico:

```json
{"externalTransactionId":"tx-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","roundId":"round-1","walletId":"wallet-1"}
```

SHA-256:

```text
12c5795427591de8e251ce67cd108dde35f710ff85790f627c4d3739ff3f2b3d
```

O valor esperado foi calculado independentemente com Python hashlib e fixado no teste, evitando que a função seja seu próprio oráculo. Alterar campos de negócio muda o hash; mudar apenas chave idempotente/messageId/timestamp não muda. Mudanças futuras na normalização precisam preservar replay de transações existentes ou introduzir versão/migração explícita do contrato.

## 3. Envelope dos eventos

Código: `src/domain/events/`.

Classe abstrata IntegrationEvent<T> com classe concreta por evento. eventType e version=1 ficam no tipo. Envelope: eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt ISO, version e data. CausationId ausente é omitido, sem null.

Decisão: aggregateId é walletId nos quatro eventos, para agrupar a cadeia financeira da wallet. transactionId continua explícito em data. EventContext recebe IDs e instante do caso de uso; a factory não gera IDs novos a cada serialização. A outbox já persiste; o publisher republica o mesmo envelope/eventId.

| Classe | Pré-condição da factory | Conteúdo principal |
|---|---|---|
| WagerTransactionProcessed | status PROCESSED e processedAt definido | identidade, kind, MoneyProps, processedAt e referência interna opcional; inclui LOSS |
| WagerTransactionRejected | status REJECTED e failureCode definido | identidade, MoneyProps e failureCode |
| WagerTransactionPendingReference | status PENDING_REFERENCE e referência externa definida | identidade, MoneyProps e referência externa |
| WalletBalanceChanged | wallet/ledger compatíveis e lançamento válido positivo | direção, MoneyProps, saldos antes/depois e walletVersion |

Dados são copiados e congelados recursivamente. Money é convertido com toJSON para MoneyProps; o envelope rejeita instâncias de classes, Date dentro de data, undefined, bigint, valores não finitos e ciclos. Datas de contexto são serializadas e getters devolvem cópias. Chamadas repetidas a toJSON preservam conteúdo e identidade.

## 4. Limites das factories

Criar um evento não o grava ou publica. A factory valida a fonte observada, mas não verifica commit SQL, correspondência persistente entre ledger/transação nem uniqueness de eventId. O caso de uso e schema devem estabelecer essas garantias.

A factory de pendência pode ser chamada mais de uma vez: o caso de uso implementado emite somente ao entrar em PENDING_REFERENCE, sem emitir em cada tentativa. A factory de saldo exige um lançamento compatível, mas não substitui controle transacional de versão. Duplicatas e reordenação continuam possíveis no transporte.

Gerar hash não reserva uma chave. Idempotência efetiva foi implementada nos casos de uso com UNIQUE, comparação transacional, tratamento de races e snapshot persistido. O hash isolado continua sem reservar uma chave.

## 5. Executar testes no Bash

```bash
# Na raiz do repositório, com Bun 1.4.4 no PATH
bun test ./tests/unit/wager-request.test.ts
bun test ./tests/unit/integration-events.test.ts
bun test ./tests/unit
bun run typecheck
bun run build
```

Esses testes são unitários e dispensam Docker. Os comandos para executar a suíte estão no [README](../README.md#testes), e o escopo está em [TEST_STRATEGY.md](TEST_STRATEGY.md).

TransportHash do envelope SQS e inbox atômica: [MESSAGING.md](MESSAGING.md).

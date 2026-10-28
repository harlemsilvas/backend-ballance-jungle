# Contratos implementados e interpretações

Contratos implementados na camada HTTP e validados em schema isolado; ativação operacional descrita em HTTP_API.md. Formatos de entrada e endpoints constam no [enunciado](CHALLENGE.md).

## HTTP

| Situação | Status |
|---|---|
| Wallet criada | 201 |
| Transação processada/replay processado, consultas e reconciliação | 200 |
| Aceite PENDING/PENDING_REFERENCE | 202 |
| DTO inválido, header ausente ou OPENING externo | 400 |
| Recurso de consulta inexistente | 404 |
| Chave divergente, identidade externa duplicada com outra chave, wallet duplicada | 409 |
| Rejeição de negócio persistida | 422 |
| Falha transitória de infraestrutura | 503 |
| Falha permanente interna/FAILED | 500 |

Replay preserva status de negócio, saldo e códigos originais; pendentes evoluem conforme arquitetura. Respostas de erro incluem `code`, `correlationId` e, quando persistidos, `transactionId`, `status`, `failureCode`. Erros de programação não devem virar rejeição financeira. GET de uma transação existente retorna 200 com seu estado, inclusive REJECTED/FAILED.

## Taxonomia inicial

| Código | Significado e ação |
|---|---|
| INVALID_PAYLOAD | Corrigir contrato antes de reenviar |
| IDEMPOTENCY_CONFLICT | Mesma chave e conteúdo diferente; investigar integração |
| EXTERNAL_TRANSACTION_CONFLICT | Identidade já associada a outra chave |
| WALLET_ALREADY_EXISTS | Consultar wallet existente |
| WALLET_NOT_FOUND | Comando rejeitado; corrigir identificação |
| PLAYER_MISMATCH / CURRENCY_MISMATCH | Corrigir vínculo/moeda |
| INSUFFICIENT_FUNDS | BET rejeitada por saldo; replay não reconsidera |
| BALANCE_LIMIT_EXCEEDED | Crédito excede a capacidade monetária; rejeição auditável, sem ledger |
| REVERSAL_INSUFFICIENT_FUNDS | Reversão rejeitada por saldo; requer ação operacional |
| REFERENCE_MISMATCH / REFERENCE_KIND_INVALID | Referência incompatível |
| REFERENCE_NOT_PROCESSED | Referência terminal sem aplicação |
| REFERENCE_EXPIRED | Referência não processada dentro do TTL |
| REVERSAL_ALREADY_APPLIED | Reversão do mesmo tipo já processada |
| INFRASTRUCTURE_UNAVAILABLE | Reenvio com a mesma chave, com backoff |
| PERMANENT_INFRASTRUCTURE_FAILURE | FAILED auditável; intervenção necessária |

Valores inválidos são erros de contrato. Referência ausente dentro do TTL é pendência, não rejeição. A entidade WagerTransaction já usa a taxonomia de rejeição/falha e a comparação de payload; hash canônico e preparação HTTP/SQS implementados; mapeamento HTTP e conflitos persistentes também implementados e testados. A preparação externa aceita BRL e rejeita outras moedas com UNSUPPORTED_CURRENCY.

## Paginação e reconciliação

Ledger com keyset por `(created_at, id)`, ordem crescente, índice `(wallet_id, created_at, id)` e cursor opaco codificado com versão, posição e wallet. Validar escopo e formato; limite default 50 e máximo 100 implementados. Sem promessa de snapshot entre páginas; ordem é estável e ledger imutável. Cursor não é credencial.

Reconciliação inclui OPENING, soma créditos menos débitos com aritmética exata e usa snapshot consistente. Diferença é `storedBalance - calculatedBalance`, podendo ser negativa. Divergência gera log, métrica e `consistent: false`, sem reparo automático.

Contrato de eventos e hash implementado: [EVENTS_AND_HASH.md](EVENTS_AND_HASH.md).

OpenWallet e processamento/replay já implementados como casos de uso, com controllers financeiros validados em schema isolado. Detalhes em [FINANCIAL_PROCESSING.md](FINANCIAL_PROCESSING.md). Wallet inexistente é erro antes da aceitação, sem transação com FK inválida; mapeado para 404 no adaptador HTTP.

Contrato HTTP atual e limitações de identidade: [HTTP_API.md](HTTP_API.md).

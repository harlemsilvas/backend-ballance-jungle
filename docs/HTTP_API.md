# API HTTP, consultas e reconciliação

Implementada em 26/10/2026 e validada contra PostgreSQL/LocalStack isolados. O bootstrap compilado foi testado. Nenhuma migration ou credencial persistente foi aplicada/criada no banco de desenvolvimento nesta etapa.

## Endpoints implementados

| Método e rota | Resultado |
|---|---|
| POST /wallets | 201; wallet criada, abertura financeira atômica quando positiva |
| GET /wallets/:walletId | 200; saldo atual e versão |
| POST /wagering/transactions | 200 processada/replay, 202 pendente, 422 rejeitada |
| GET /wagering/transactions/:transactionId | 200 para registro existente, inclusive REJECTED/FAILED |
| GET /providers/:providerId/wagering/transactions/:externalId | Consulta por identidade externa |
| GET /wallets/:walletId/ledger?limit=50&cursor=... | Entradas e nextCursor opaco ou null |
| POST /wallets/:walletId/reconciliation | 200; comparação em snapshot, sem reparo |
| GET /health/live | 200 enquanto processo responde |
| GET /health/ready | 200 com PostgreSQL/SQS alcançáveis; 503 se dependência falhar |
| GET /metrics | Contador Prometheus de divergências da reconciliação |

Health fica fora do guard de identidade. Readiness consulta SELECT 1 e ListQueues no emulador, sem enviar mensagens. A observabilidade foi ampliada para status, duplicatas, retries, DLQ, locks, lag e latência; ver OBSERVABILITY.md.

## Contratos e erros

Wallet aceita somente playerId UUID e initialBalance com amount string/currency. Campos extras são rejeitados. Submissão exige Idempotency-Key explícita e reutiliza o normalizador e o caso de uso existentes; dinheiro numérico, OPENING externo, UUIDs malformados e campos desconhecidos retornam 400.

| Situação | HTTP |
|---|---|
| Payload/cursor inválido | 400 |
| Provedor autenticado diverge do providerId solicitado | 403 |
| Wallet/transação não encontrada | 404 |
| Wallet duplicada, chave divergente ou identidade externa com outra chave | 409 |
| Rejeição financeira persistida | 422, incluindo replay da rejeição |
| Aceite aguardando referência | 202 |
| Infraestrutura transitória indisponível/conflito esgotado de lock | 503 |
| Falha interna inesperada | 500 |

Erro de contrato/infraestrutura contém code e correlationId, sem SQL, credenciais ou mensagem interna. Rejeição aceita retorna transactionId/status/failureCode/balance/idempotentReplay. Um GET de transação rejeitada continua 200: o recurso foi encontrado, embora a operação financeira tenha sido rejeitada.

X-Correlation-Id recebido é preservado quando utilizável (até 200 caracteres); ausente/inválido gera UUID. A resposta devolve o header e erros/logs usam a mesma correlação. Payload financeiro completo não é logado.

## Cursor estável com microssegundos

Ledger usa keyset por (created_at,id), ordem crescente e limite default 50/máximo 100. Cursor base64url contém versão, wallet, timestamp UTC com seis casas fracionárias e UUID. É opaco por contrato, sem promessa de criptografia ou autorização. Wallet diferente, formato inválido e parâmetros inesperados são rejeitados.

**Decisão:** timestamp do cursor vem de SQL to_char, preservando microssegundos. Passar pelo Date do JavaScript descartaria os três últimos dígitos e poderia repetir/pular lançamentos. Um teste grava entradas separadas por um microssegundo e percorre todas as páginas sem duplicidade. Paginação não cria snapshot entre páginas; o ledger é imutável e a ordenação é estável.

## Reconciliação sem falso positivo de concorrência

MikroFinancialQueries.reconcile usa REPEATABLE READ: saldo e SUM do ledger enxergam o mesmo snapshot. Diferença é storedBalance - calculatedBalance, como Money assinado. Não exige lock da wallet para leitura. Um teste mantém uma movimentação não confirmada e verifica saldo consistente antes e após o commit.

Se houver divergência: consistent=false, resposta com saldos/diferença, log JSON com código/walletId/correlationId e incremento de contador por processo. Nenhum UPDATE de reparo é feito. O teste simula corrupção desativando triggers somente no schema descartável, verifica resposta/contador e restaura o fixture no finally. O papel normal de execução não pode desativar esses mecanismos.

## Identidade e modo local

Autenticação OIDC continua adiada. ProviderIdentityPort e guard permitem resolver identidade externa e comparar providerId de corpo/rota. O adaptador LocalDevelopmentIdentity é explicitamente no-op, para a demonstração local. O teste injeta identidade conhecida e verifica rejeição de provider incompatível.

Não há JWT/senhas próprios. Associação/autorização de acesso a uma wallet sem providerId na rota ainda dependerá do desenho com IdP; não anunciar autenticação de produção pronta. O bootstrap financeiro só aceita AUTH_MODE=local-development e recusa esse modo se NODE_ENV=production. Bind padrão é 127.0.0.1; o Compose usa HTTP_HOST=0.0.0.0 dentro do container e publica a porta somente no localhost do host.

## Inicialização e banco

Por padrão FINANCIAL_API_ENABLED=false: `bun run start` disponibiliza somente liveness, sem abrir banco financeiro. Para ativar rotas financeiras é necessário preparar o banco alvo com as três migrations e um papel de runtime restrito, depois configurar:

```dotenv
FINANCIAL_API_ENABLED=true
AUTH_MODE=local-development
DB_HOST=127.0.0.1
DB_PORT=5546
DB_NAME=ballance
DB_USER=<papel_runtime_nao_proprietario>
DB_PASSWORD=<senha_local_do_runtime>
SQS_ENDPOINT=http://127.0.0.1:4567
```

Não inserir placeholders literalmente nem divulgar a senha. Configuração exemplificada, não aplicada. O startup verifica privilégios administrativos, propriedade/herança de propriedade, permissão de modificar ledger e presença da taxonomia da segunda migration. Recusa conta administrativa, proprietário e schema não preparado. Não executa schema sync, migrations ou criação de papéis automaticamente.

O teste confirma a recusa da conta administrativa e usa um papel NOLOGIN temporário, isolado em pool próprio, para validar grants e criação financeira. O overlay Compose agora oferece provisionamento explícito em schema financial; os testes HTTP continuam usando recursos isolados sem alterar public.

## Comandos Bash já validados

```bash
cd /home/harlem/projetos/backend-challenge
export PATH="$HOME/.bun/bin:$PATH"
docker compose ps
bun test tests/integration/financial-http.test.ts
bun test tests/unit tests/integration
bun run typecheck
bun run build
```

A suíte HTTP inicia servidores em portas locais livres e os encerra. Prepara/remove schema e papel próprios. Não depende de API já iniciada. Registro histórico da etapa HTTP: 163 testes, zero falhas, 589 assertions (105 unitários e 58 integração), incluindo 14 HTTP.

Para o modo liveness padrão:

```bash
bun run start
```

Em outro terminal:

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/health/live
```

Encerrar com Ctrl+C. Após preparar/configurar o runtime e ativar FINANCIAL_API_ENABLED, os exemplos abaixo exercitam dados sintéticos no banco local escolhido:

```bash
curl --fail-with-body -sS http://127.0.0.1:3000/health/ready
curl --fail-with-body -sS http://127.0.0.1:3000/wallets   -H 'Content-Type: application/json'   -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Copiar o id retornado para a variável Bash:

```bash
WALLET_ID='UUID_RETORNADO_PELA_CRIACAO'
curl --fail-with-body -sS "http://127.0.0.1:3000/wallets/$WALLET_ID"
curl --fail-with-body -sS "http://127.0.0.1:3000/wallets/$WALLET_ID/ledger?limit=50"
curl --fail-with-body -sS -X POST "http://127.0.0.1:3000/wallets/$WALLET_ID/reconciliation"
```

Repetir a criação com o mesmo player/moeda retorna 409. Os exemplos curl financeiros dependem da preparação operacional; a cobertura desses endpoints foi executada pela suíte isolada, não no public local.

## Pendências

IdP real e benchmark continuam pendentes. Runtime e empacotamento local estão no README da solução. Scheduler/claims e prova de SIGTERM com runtime temporário foram concluídos. Consumidor/inbox/publisher e testes reais de crash/ack já implementados em MESSAGING.md. Métricas/logs obrigatórios foram concluídos em OBSERVABILITY.md. Nenhum benchmark foi executado.

Observabilidade atual e coleta por fonte: [OBSERVABILITY.md](OBSERVABILITY.md). Scheduler: [REFERENCE_SCHEDULER.md](REFERENCE_SCHEDULER.md).

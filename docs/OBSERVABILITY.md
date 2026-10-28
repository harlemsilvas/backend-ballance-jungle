# Observabilidade: logs, métricas e saúde

Implementada nos entrypoints HTTP e workers em 26/10/2026. Domínio permanece independente; aplicação recebe uma porta Telemetry. Uso programático pode injetar a implementação no-op para testes, enquanto os entrypoints operacionais usam PrometheusTelemetry.

## Logs JSON

Cada linha possui timestamp UTC, level, event e as chaves correlationId, messageId, transactionId, walletId e providerId. Identificadores desconhecidos/não aplicáveis aparecem como null, sem inventar um messageId para uma chamada HTTP. Entradas de consumidor carregam o messageId lógico do envelope; eventos de scheduler usam a transação como correlação de recuperação.

Eventos cobrem commit, replay, falha de entrada/processamento, retries SQL, ack, DLQ, publicação e recuperação de referência. O publisher usa identidade do envelope e dados disponíveis; WalletBalanceChanged não carrega providerId, portanto esse identificador pode estar ausente nesse log específico. Logs de processamento financeiro possuem o vínculo conhecido.

Há whitelist de campos e limite de tamanho de strings. Payload, amount, balance, password, token, SQL e texto livre de exceções não são emitidos. Falha do destino de logs não muda o resultado financeiro. Credenciais do teste operacional são geradas em memória e não aparecem nos logs ou métricas.

## Métricas implementadas

| Métrica | Tipo/labels | Significado |
|---|---|---|
| wager_transactions_total | counter, status | Resultados confirmados de processamento; abertura positiva também conta |
| wager_transactions_stored | gauge, status | Quantidade realmente armazenada no banco, por estado |
| wager_wallets_opened_total | counter | Aberturas confirmadas |
| wager_duplicates_total | counter, layer | Replay financeiro, duplicata inbox ou conflito inbox |
| wager_retries_total | counter, component | Retries agendados no banco/consumer/publisher/scheduler |
| wager_dlq_messages_total | counter, reason | Encaminhamentos confirmados à DLQ por erro permanente/esgotamento |
| wager_dlq_visible_messages | gauge | Quantidade visível aproximada informada pelo SQS |
| wager_lock_conflicts_total | counter, kind | Deadlock, timeout ou serialização |
| wager_wallet_lock_wait_seconds | histogram | Espera da operação de lock SQL da wallet |
| wager_processing_duration_seconds | histogram, operation | Latência dos casos open_wallet/process/resume, incluindo retries |
| wager_outbox_published_total | counter | Confirmação de publishedAt com posse válida |
| wager_outbox_pending | gauge | Eventos ainda sem publishedAt, inclusive leased/em retry |
| wager_outbox_lag_seconds | gauge | Idade do evento não publicado mais antigo; zero se nenhum |
| wager_reference_claims_total | counter, outcome | Claims concluídos, perdidos, devolvidos ou com erro |
| wager_reconciliation_divergences_total | counter | Reconciliações inconsistentes |
| wager_metrics_collection_success | gauge, source | 1/0 para coleta DB/SQS |
| wager_metrics_collection_errors_total | counter, source | Falhas da coleta |

Labels aceitam somente categorias fixas. IDs de wallet/player/provider/message não viram labels. Isso limita cardinalidade; os IDs ficam nos logs para investigação.

## Semântica dos contadores e dados duráveis

Counters/histograms são por processo e reiniciam com ele. Eles não dão garantia de idempotência nem substituem o ledger. wager_transactions_total conta resultados confirmados de tentativas: uma pendência reavaliada pode contar novamente como PENDING_REFERENCE; replay terminal incrementa duplicatas, sem novo resultado financeiro.

Gauges de status/backlog/lag são lidos no PostgreSQL a cada scrape e sobrevivem à reinicialização do registry. São o complemento durável para auditoria de estado. Uma queda entre commit e atualização de um counter pode perder essa amostra local; o estado confirmado continua no banco e aparece nos gauges.

Se várias instâncias expõem o mesmo banco, não somar seus gauges globais: usar um alvo de coleta ou max. Para counters de processos diferentes, agregar as taxas. O scraper deve identificar cada alvo por instance/job.

## Coleta e falhas

/metrics atualiza gauges em consulta SQL e atributos da DLQ. Número de mensagens do SQS é aproximado e não constitui reconciliação financeira. Coleta não envia mensagens nem altera saldo/ledger.

Falha de uma fonte preserva a última amostra, marca collection_success=0 e incrementa erro. Não apresentar lag zero como se estivesse saudável quando o banco está indisponível. O endpoint continua expondo os dados disponíveis; health/ready sinaliza dependências separadamente.

Histograms têm buckets cumulativos em segundos, incluindo +Inf, sum e count. Dados usados nesses indicadores são durações/contagens, não valores monetários convertidos para number.

## Endpoints

API financeira: GET /metrics, /health/live e /health/ready no listener da API. A ativação padrão continua liveness-only até configurar FINANCIAL_API_ENABLED e runtime restrito.

Workers: mesmos endpoints no servidor NestJS separado em WORKER_METRICS_PORT (default 9101). Bind padrão em 127.0.0.1; HTTP_HOST=0.0.0.0 no Compose permite comunicação interna, com porta do host restrita a localhost. Readiness verifica PostgreSQL e SQS. No desligamento, drenar trabalhos, fechar servidor de métricas e então encerrar clientes/pool.

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/metrics
curl --fail --silent --show-error http://127.0.0.1:9101/metrics
curl --fail --silent --show-error http://127.0.0.1:9101/health/ready
```

Os curls operacionais exigem os serviços configurados/iniciados. Nos testes, listeners usam portas livres e são encerrados no finally.

## Exemplos PromQL para estudo

Prometheus/dashboard não foram instalados nesta etapa; exemplos de consulta, não benchmark executado:

```promql
sum by (status) (rate(wager_transactions_total[5m]))
sum by (component) (rate(wager_retries_total[5m]))
max(wager_outbox_pending)
max(wager_outbox_lag_seconds)
max(wager_dlq_visible_messages)
histogram_quantile(0.95, sum by (le) (rate(wager_processing_duration_seconds_bucket{operation="process"}[5m])))
```

Não atribuir p95/throughput a testes unitários. É necessário gerar carga e registrar ambiente/metodologia para um benchmark válido.

## Executar os testes manualmente

```bash
cd /home/harlem/projetos/backend-challenge
export PATH="$HOME/.bun/bin:$PATH"
bun test tests/unit/telemetry.test.ts
bun test tests/integration/observability.test.ts
bun test tests/integration/messaging.test.ts
bun test tests/integration/worker-entrypoint.test.ts
bun test tests/unit tests/integration
bun run typecheck
bun run build
```

Provas: logs filtrados e IDs; labels limitados; histogramas; resultados pós-commit e duplicatas; coleta durável após registry novo; falha de coleta; timeout real PostgreSQL com retry; endpoints API/workers; métricas consumer/publisher com SQS real; login restrito e SIGTERM no entrypoint.

## Decisões e limites

A implementação Prometheus é pequena e específica, sem dependência adicional; testes verificam seu formato/categorias. Logs são JSON direto em stdout, apropriados ao redirecionamento do ambiente. Exportação OpenTelemetry, dashboard, armazenamento externo de logs e alertas não foram adicionados, pois são opcionais no enunciado.

Instrumentação cobre os requisitos obrigatórios, mas não é benchmark nem garantia de publicação exatamente uma vez. Provisionamento restrito e empacotamento estão implementados e foram validados em projeto Compose isolado (DELIVERY.md). [Scheduler e claims](REFERENCE_SCHEDULER.md).

Registro histórico da etapa de scheduler/observabilidade: **202 testes passaram, 788 assertions**, typecheck e build aprovados. São 110 unitários e 92 integração.


## Medição exploratória do custo da coleta

O pacote 2 adicionou um runner separado da aplicação, comparando /metrics ligado/desligado nos três processos. [Método](LOAD_TESTS.md) e [resultados](LOAD_RESULTS.md) registram uma única repetição, caches aquecidos e limites de atribuição. Nenhum coletor, counter, gauge ou comportamento de falha de produção foi alterado.

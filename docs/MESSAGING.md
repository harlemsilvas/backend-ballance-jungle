# Consumidor SQS, inbox atômica e publisher da outbox

Implementados e validados em 26/10/2026, usando PostgreSQL/LocalStack reais em recursos exclusivos de teste. Não houve consumo/publicação nas filas de desenvolvimento, aplicação de migration no public ou criação de credencial persistente.

## Componentes

| Arquivo | Responsabilidade |
|---|---|
| application/financial-ports.ts | InboxReceipt e operações acceptInbox/completeInbox na FinancialSession |
| application/financial-use-cases.ts | Mesmo processamento HTTP/SQS, com inbox opcional na transação |
| infrastructure/persistence/mikro-financial-unit-of-work.ts | Reserva/dedup da inbox e conclusão no commit financeiro |
| infrastructure/messaging/sqs-wager-consumer.ts | Polling, visibilidade, ack, retries, DLQ e drenagem |
| infrastructure/persistence/outbox-store.ts | Claims SQL, lease/token, retry e confirmação condicional |
| infrastructure/messaging/outbox-publisher.ts | Envio fora da transação financeira e recuperação |
| bootstrap/workers.ts | Inicialização explícita e sinais SIGINT/SIGTERM |
| tests/integration/messaging.test.ts | 17 testes reais de mensageria e falhas |

Caminhos relativos a src/, exceto tests/. Não foi necessária nova migration: as tabelas e campos de lease já existiam.

## Dois níveis de identidade

**Financeiro:** idempotencyKey + hash canônico do subconjunto de negócio. Repetir o comando em outra mensagem não altera a operação nem sua resposta histórica.

**Transporte:** UNIQUE(consumerName,messageId) + transportHash. messageId é o do envelope da aplicação, não o MessageId atribuído pelo SQS. transportHash usa SHA-256 do JSON canônico do envelope validado inteiro, incluindo a chave idempotente, tipo e occurredAt. Ordem das chaves e espaços do JSON não interferem; mudar o valor de um campo interfere. Amount textual diferente também muda o envelope, ainda que normalize para o mesmo Money financeiro.

ReceiptHandle, ApproximateReceiveCount, MessageGroupId e outros atributos do broker não entram nesse hash: mudam entre entregas sem mudar o envelope. Dois grupos FIFO diferentes com o mesmo envelope continuam deduplicados pelo banco.

Mesma mensagem e hash divergente é INBOX_PAYLOAD_CONFLICT e vai à DLQ, sem sobrescrever a inbox original. Outra mensagem com o mesmo comando financeiro recebe sua própria inbox, mas usa o resultado financeiro já persistido.

## Commit e ack

```mermaid
sequenceDiagram
  participant Q as SQS
  participant C as Consumidor
  participant DB as PostgreSQL
  Q->>C: mensagem e ReceiptHandle
  C->>DB: BEGIN; reservar/travar inbox
  C->>DB: caso de uso e lock da wallet
  C->>DB: wallet + transação + ledger + outbox + inbox processada
  C->>DB: COMMIT
  DB-->>C: confirmado
  C->>Q: DeleteMessage (ack)
```

ProcessWagerTransaction.execute recebe InboxReceipt opcional e executa tudo na mesma FinancialSession. Não há transação externa separada chamando execute. Reserva inicial precede lock de wallet; uma colisão de inbox desfaz a tentativa inteira e reconsulta a vencedora. HTTP mantém o mesmo caminho financeiro sem inbox.

Erro antes do commit desfaz inclusive a inbox. Queda depois do commit e antes do ack deixa operação/inbox confirmadas: redelivery retorna replay e pode fazer ack sem outro movimento/evento.

PENDING_REFERENCE também pode receber ack: pendência e agendamento foram persistidos junto com a inbox. A continuidade pertence ao caso de uso resume/scheduler SQL implementado, sem depender de reter a mensagem SQS. O teste entrega REFUND antes de BET e retoma a pendência após a referência.

## Visibilidade, erros e DLQ

Consumidor processa uma mensagem por instância/poll, permitindo escalar processos. Defaults: visibility timeout 30s, heartbeat aproximadamente a cada 10s, long polling 1s e limite de cinco recebimentos. Os testes usam timeout de 1s para exercitar redelivery. Opções inválidas são recusadas.

| Situação | Tratamento |
|---|---|
| PROCESSED, REJECTED ou aceite pendente confirmado | Ack após commit |
| Falha transitória antes do commit | Rollback; mudar visibilidade com backoff exponencial |
| Contrato inválido, conflito de inbox/idempotência ou outro erro permanente de entrada | Encaminhar à DLQ e só depois apagar original |
| Erro repetido até limite de recebimentos | Encaminhar à DLQ |
| Falha no envio à DLQ | Não apagar original; redelivery após visibilidade |
| Falha no ack após commit | Redelivery continua segura pela inbox/identidade financeira |

DLQ preserva corpo original e atributos de diagnóstico failureCode, failureClass e sourceMessageId. Não inclui texto livre de exceções ou SQL. Envio FIFO usa dedup ID estável; queda entre enviar DLQ e apagar origem pode duplicar entrega, mas não efeitos financeiros.

Falha de infraestrutura que não confirmou transação não é registrada falsamente como FAILED financeiro. Ao esgotar retries, a mensagem/DLQ auditam essa falha. Estados FAILED de transações já persistidas continuam terminais; não há caminho que transforme um commit financeiro em rejeição por falha de ack.

Heartbeats em andamento são coordenados antes de devolver/alterar visibilidade, para não sobrescrever a liberação com uma renovação atrasada.

## Claims e publicação

OutboxStore usa transação SQL curta com FOR UPDATE SKIP LOCKED e lease. Somente publishedAt nulo, nextAttemptAt vencido e lease ausente/expirado são elegíveis. Attempts incrementa a cada claim, inclusive quando o processo morre antes do envio. Defaults: lote até 10 e lease 30s.

1. Confirmar claim/token no banco.
2. Enviar evento ao broker fora da transação financeira e do claim.
3. Renovar lease durante o envio.
4. Marcar publishedAt somente se id/token ainda pertencem ao publisher e lease está válido.

Outro publisher pode assumir após expiração; token antigo não pode confirmar esse trabalho. Falha de envio libera lease e agenda backoff persistente com jitter, teto de cinco minutos. Não há descarte silencioso de evento por atingir limite de tentativas.

O envelope e eventId não mudam na republicação. Na fila FIFO de eventos, MessageGroupId=aggregateId e MessageDeduplicationId=eventId. FIFO é otimização; consumidores ainda precisam dedup persistente. Claims concorrentes não garantem ordem de publicação por wallet.

Queda depois de enviar e antes de marcar publishedAt permite duplicata. Um teste usa fila Standard para expor a duplicata sem a janela de dedup do FIFO, confirma mesmo eventId e demonstra dedup por inbox persistente downstream. Essa inbox downstream do teste é uma demonstração; não foi criado um consumidor genérico de eventos na aplicação.

## Drenagem e sinais

stop interrompe novos polls/claims e tenta concluir trabalho até o prazo padrão de cinco segundos. Consumidor sem tempo devolve visibilidade e suprime ack tardio; publisher libera a posse e suprime marcação tardia. O token no banco protege mesmo se houver resposta de rede atrasada.

Bootstrap conecta SIGINT/SIGTERM à drenagem e encerra cliente/pool ao final. Métodos de drenagem foram testados em sucesso e deadline, com gates determinísticos. Quedas nas janelas críticas foram testadas com SIGKILL real de filhos Bun. Prova operacional posterior executou o entrypoint real de scheduler com login temporário restrito e SIGTERM; rollout com credenciais persistentes continua para a entrega.

## Comandos Bash

Testes isolados, disponíveis agora com containers saudáveis:

```bash
cd /home/harlem/projetos/backend-challenge
export PATH="$HOME/.bun/bin:$PATH"
docker compose ps
bun test tests/integration/messaging.test.ts
bun test tests/unit tests/integration
bun run typecheck
bun run build
```

Somente as janelas de crash:

```bash
bun test tests/integration/messaging.test.ts -t SIGKILL
```

A suíte cria/remove schema e filas próprios por cenário. O teste do publisher adianta lease expirado no schema isolado em vez de esperar 30s; crash e envio ao SQS são reais. O teste de DLQ espera visibilidade pelo long polling, sem sleeps arbitrários. Filhos de crash são encerrados; não executar helpers manualmente contra filas de desenvolvimento.

Execução final: 180 testes, zero falhas, 680 assertions em 12 arquivos. São 105 unitários e 75 integração, dos quais 17 novos de mensageria. Typecheck/build aprovados. Worker compilado recusou conta administrativa e encerrou corretamente antes de operar filas.

## Iniciar workers de desenvolvimento após provisionamento

Requer as mesmas DB_* restritas e duas migrations da API, SQS_ENDPOINT local e filas existentes. O comando não aplica migration nem cria papel/fila. O endpoint local é validado; não há configuração AWS de produção nesta etapa.

```bash
bun run build
WORKER_MODE=all bun run worker
```

Ou separar em terminais/processos:

```bash
WORKER_MODE=consumer bun run worker
```

```bash
WORKER_MODE=publisher bun run worker
```

Filas padrão: wager-transactions.fifo, wager-transactions-dlq.fifo e wager-events.fifo. Nomes podem ser configurados por WAGER_QUEUE_NAME, WAGER_DLQ_NAME e EVENT_QUEUE_NAME. Encerrar com Ctrl+C ou SIGTERM. Os entrypoints e a stack Compose foram validados com runtime restrito em projeto/volume isolados (DELIVERY.md). O ambiente de desenvolvimento original/public não foi provisionado.

## Pendências

Scheduler automático e observabilidade foram implementados nas etapas seguintes, descritas em REFERENCE_SCHEDULER.md e OBSERVABILITY.md. Provisionamento explícito e entrega reproduzível estão implementados e validados em projeto isolado; ver DELIVERY.md. Consumidor/publisher e testes de crash estão implementados; não equivalem a benchmark ou validação AWS real.

A configuração atual exige três migrations; reference_jobs e modo all são descritos em [REFERENCE_SCHEDULER.md](REFERENCE_SCHEDULER.md).

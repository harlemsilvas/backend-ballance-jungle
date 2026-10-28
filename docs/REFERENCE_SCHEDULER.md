# Scheduler automático de referências

Implementado em 26/10/2026. O worker seleciona referências vencidas e chama o mesmo caso de uso resume já usado nos testes financeiros. Não precisa reenviar nem reter a mensagem SQS original.

## Por que uma tabela separada

Migration202610260003ReferenceJobs adiciona reference_jobs, com uma linha por transação, token, vencimento do lease e número de claims. Não altera as migrations anteriores nem os lançamentos financeiros.

Os triggers financeiros travam a wallet ao alterar uma transação. Atualizar a própria transação para reservar trabalho poderia adquirir lock da transação antes da wallet e criar uma inversão com o processamento normal. A tabela separada permite reservar o job em uma transação curta, sem tocar na wallet.

## Sequência e posse

1. Descobrir PENDING_REFERENCE sem job, com INSERT ON CONFLICT DO NOTHING.
2. Selecionar vencidas com FOR UPDATE OF job SKIP LOCKED e lease ausente/expirado.
3. Confirmar token/lease no banco e encerrar a transação de claim.
4. Retomar o caso de uso: wallet primeiro; em seguida validar/travar o job por token ainda válido.
5. Aplicar domínio, ledger, resposta e outbox; limpar a posse na mesma transação financeira.

Claim seleciona apenas nextReferenceAttemptAt vencido, salvo pendência acima do TTL que precisa de avaliação mesmo se o próximo agendamento estiver no futuro. O lease em vigor continua respeitado.

Durante a aplicação, o lock SQL do job protege a posse até o commit. Um token que expirou enquanto esperava a wallet é rejeitado como REFERENCE_CLAIM_LOST. Outro scheduler pode assumir lease expirado; uma instância antiga não aplica novamente a transação.

## Quedas e encerramento

Se morrer após o claim, a transação continua pendente e o lease expira. Se morrer durante a aplicação antes do commit, o PostgreSQL desfaz o conjunto. Se o commit ocorreu, o estado terminal imutável impede uma segunda movimentação.

stop impede novos claims e tenta drenar até cinco segundos. Ao vencer o prazo, devolve jobs disponíveis. A liberação usa SKIP LOCKED para não ficar bloqueada em um job que está dentro da seção financeira; se a conexão morrer, esse trabalho pode ser assumido quando o lease expirar.

## Backoff e TTL

Tentativas e nextReferenceAttemptAt continuam na transação financeira. O backoff tem base 1s × 2^tentativas, jitter até 249ms e teto de cinco minutos. Lease padrão: 30s; lote padrão: até dez. Erros de infraestrutura no resume desfazem a tentativa e deixam o job recuperável com cooldown persistido.

TTL de 24h, contado desde a criação aceita, não reinicia após queda. Se a referência continua ausente/pendente quando a transação é avaliada após esse prazo, a operação vira REJECTED/REFERENCE_EXPIRED e grava evento na outbox. Uma referência já processável segue as regras do domínio. TTL é a política de espera pela referência; não remove histórico nem reinicia a identidade financeira.

Uma pendência reavaliada não repete o evento de entrada em PENDING_REFERENCE. Falhas de infraestrutura não são rejeições financeiras fictícias.

## Modos dos workers

- all: consumidor + publisher + scheduler, padrão atual.
- scheduler: somente recuperação de referências.
- consumer: somente consumidor.
- publisher: somente publisher.
- both: consumidor + publisher, mantido por compatibilidade; não inclui scheduler.

Cada processo expõe observabilidade em WORKER_METRICS_PORT, padrão 9101. Usar portas diferentes para processos separados. Configuração DB_SCHEMA é validada e defaults para public; testes usam schemas exclusivos.

## Executar no Bash

Testes isolados, disponíveis com containers saudáveis:

```bash
cd /home/harlem/projetos/backend-challenge
export PATH="$HOME/.bun/bin:$PATH"
bun test tests/integration/reference-scheduler.test.ts
bun test tests/integration/worker-entrypoint.test.ts
bun run typecheck
bun run build
```

Após provisionar o banco de desenvolvimento com três migrations e runtime restrito:

```bash
WORKER_MODE=all WORKER_METRICS_PORT=9101 bun run worker
```

Ou scheduler separado:

```bash
WORKER_MODE=scheduler WORKER_METRICS_PORT=9103 bun run worker
```

Não é necessário provisionar o public para executar os testes. Eles criam/removem seus schemas e filas. O teste operacional cria login restrito temporário com senha gerada em memória, executa o entrypoint real, verifica processamento/métricas e envia SIGTERM; remove login e grants ao final.

## Evidências

Dez testes focados: migration up/down/up; ignorar futuras; processar vencida; dois schedulers; SIGKILL após claim; token antigo; TTL; rollback e recuperação; devolução no stop; ausência de lock de wallet durante claim. O teste do entrypoint comprova execução com identidade restrita, endpoints de monitoramento e saída zero por SIGTERM.

## Custos e limites

Descoberta percorre pendências e verificação financeira reconstrói histórico da wallet; não há benchmark de throughput. Jobs concluídos são retidos, sem política de limpeza automática nesta versão. Leases são coordenação; consistência financeira permanece no caso de uso/schema. Não foi aplicada migration ao public nem criado runtime persistente nesta etapa.

Logs/métricas: [OBSERVABILITY.md](OBSERVABILITY.md). Mensageria: [MESSAGING.md](MESSAGING.md).

Registro histórico da etapa de scheduler/observabilidade: **202 testes passaram, 788 assertions**, typecheck e build aprovados. São 110 unitários e 92 integração.

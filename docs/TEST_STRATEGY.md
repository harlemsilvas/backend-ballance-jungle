# Estratégia de testes — entrega para avaliação

Inclui a suíte financeira e os controles do runner de carga. Consulte o [registro de validação desta entrega](VALIDACAO_CANDIDATA.md) e o [README](../README.md) para executar a suíte isolada com `sh entrega.sh test`. Os relatórios históricos não são medições desta montagem.

## Unidade

Money: entradas inválidas, escala, normalização sem arredondamento, limites, imutabilidade, operações e moedas diferentes. Wallet: saldo não negativo e versão. Transações: todos os kinds, referências, valor integral, reversão por tipo, estados terminais e rehydrate. Ledger: direção e aritmética. Hash: ordem das chaves, ausência de metadados e divergência de negócio.

## Integração

Migrations up/down/up em banco descartável; SQL direto para cada UNIQUE/CHECK/FK/trigger e papel de aplicação sem permissão de mutar ledger. Demonstrar proteção de saldo/ledger também fora do repositório ORM. Injetar falha antes do commit e verificar ausência de efeitos parciais, inclusive inbox/outbox. Testar abertura zero e positiva, replay após outras operações, rejeições sem ledger e reconciliação durante escrita.

SQS: redelivery, mesmo messageId com payload divergente, mensagens inválidas, retries, DLQ e indisponibilidade. Outbox: queda antes do envio, depois do envio e antes da marcação, lease expirado e dois publishers. Verificar eventId estável e consumidor idempotente. Referências: ausência, pendência, terminal rejeitada, ciclos, TTL e reinício mantendo agendamento.

## Concorrência obrigatória

1. Mesma BET 50 vezes em paralelo: um débito, um resultado original.
2. Duas BET de 80.00 sobre 100.00: uma PROCESSED, uma REJECTED, saldo 20.00 e um débito; distinguir crédito OPENING na contagem.
3. Wallets distintas em paralelo: progresso independente, sem lock global.
4. Pelo menos três processos reais simultâneos compartilhando banco nas provas financeiras; SQS real nos testes de consumidor/publishers, com cenários e processos identificados nas evidências.
5. Matar worker após commit e antes de ack: redelivery sem segundo efeito.
6. Dois publishers sobre a mesma outbox: recuperação e nenhuma perda; duplicata permitida e deduplicada.
7. REFUND/ROLLBACK antes da referência: pendência seguida de resultado correto.
8. Reiniciar processos e verificar saldo, ledger, inbox, terminais e publicação eventual.

Usar barreiras para criar disputa real e hooks explícitos para a janela de crash; não substituir por chamadas sequenciais ou sleeps arbitrários. Em todos os cenários comparar saldo com SUM de créditos menos débitos, contagem por transação, versão e eventos esperados.

## Registro de resultados

Para cada execução registrar revisão do código, versões, comando existente, ambiente, processos, duração, esperado/observado e artefatos sem segredos. Comandos existentes: `bun test tests/unit` e `bun run test:integration`. Não anunciar scripts de concorrência ou cobertura financeira ainda não implementados. Benchmark é opcional e só deve reportar números medidos com metodologia, latências e outbox lag.

Comandos de execução: [README](../README.md#testes). Motivos das decisões e limitações: [DECISIONS.md](DECISIONS.md).

Migration real e evidências SQL em [FINANCIAL_SCHEMA.md](FINANCIAL_SCHEMA.md).

Casos de uso e provas multiprocesso: [FINANCIAL_PROCESSING.md](FINANCIAL_PROCESSING.md).

Endpoints e testes HTTP: [HTTP_API.md](HTTP_API.md).

Mensageria e testes de crash: [MESSAGING.md](MESSAGING.md).

Scheduler: [REFERENCE_SCHEDULER.md](REFERENCE_SCHEDULER.md). Telemetria: [OBSERVABILITY.md](OBSERVABILITY.md).


## Runner de medição e interrupção

LOAD_TESTS.md descreve o runner opcional test:load. Ele não é disparado por bun test; a suíte inclui dois testes de controle operacional em tests/integration/load-runner.test.ts: interrupção com encerramento/limpeza dos recursos exclusivos e preservação de um schema de controle; e limite de população com auditoria do progresso parcial. Benchmark não substitui a suíte financeira.


## Experimentos 002/003

Os resultados sequenciais estão em LOAD_RESULTS_INDEX.md; a proposta posterior aos testes está em LOAD_IMPROVEMENT_PLAN.md. A regressão final foi executada após encerrar as medições, preservando SQL adversarial, replay, concorrência e crashes. O runner tem dois controles de segurança operacional: interrupção com recurso de controle preservado e orçamento de população com auditoria parcial, sem apresentar um cenário interrompido como completo.

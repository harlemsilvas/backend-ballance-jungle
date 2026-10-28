# Experimento 003 — resultados

Estado: **population-budget-exceeded**. [Registro estruturado](benchmarks/results-003.json). [Método](LOAD_TESTS.md). Brutos locais: `/tmp/ballance-load-experiment-003`. Relatório anterior: [2](LOAD_RESULTS_002.md).

Históricos: 10000; wallets no perfil spread, quando selecionado: 3; distribuições: hot; entradas: http; comandos/caso: 720; processos: 3; concorrência: 6; repetições: 1; intervalos de coleta: 5000ms, além de off. Limite de população/caso: 600000ms. Sondas SQL/caso: 5 repetições por consulta.

Este perfil executou uma repetição; não é a matriz contrabalanceada do experimento 002. Quando há segunda repetição, ela percorre a matriz inteira em ordem inversa. Cada ponto tem população nova e constraints ativas. O número de wallets altera também o total de dados; não é um controle isolado de contenção. Código financeiro e dependências não foram otimizados entre esses pontos. Hardware, versões, configuração, hashes e indicadores por caso estão no JSON.

## Casos executados, na ordem registrada

| Caso | Seed (s) | ops/s | p50 (ms) | p95 (ms) | p99 (ms) | Lock p95 (ms) | Scrape p95 (ms) |
|---|---|---|---|---|---|---|---|

## Agregação das repetições

Percentis recalculados sobre as amostras reunidas; não é média de percentis. Throughput agregado pondera duração das janelas. Intervalos mínimo/máximo por repetição constam no JSON; essa agregação não prova causalidade nem saturação.

| Histórico/distribuição/entrada/coleta(ms) | Repetições concluídas | ops/s | p50 | p95 | p99 |
|---|---|---|---|---|---|

## Limite operacional de população

A população foi interrompida após commits completos ao atingir o orçamento configurado. Não há janela medida para o ponto interrompido. Entradas alcançadas, custo observado e auditoria do histórico parcial estão no JSON. Não interpretar a ausência de amostras como throughput zero nem como falha financeira. Pontos anteriores concluídos não completam por si só a matriz solicitada.

## Conferência e limites

Cada caso concluído registra auditoria de saldo/ledger/versão, replay, inbox/outbox e DLQ. Erros, retries e conflitos, quando disponíveis, estão separados no JSON. /metrics é medido pelo endpoint real, incluindo DB e SQS; probes SELECT não representam todo o custo de PL/pgSQL/commit. HTTP e SQS medem percursos distintos. A frequência efetiva e quantidade de scrapes precisam ser consideradas, sobretudo quando a janela é menor que o intervalo.

Este arquivo preserva observações. O plano de melhoria será elaborado após encerrar os testes e revisar correção, variabilidade, planos SQL e limites operacionais; nenhuma melhoria é implementada automaticamente por este relatório.

## Fechamento revisado da tentativa

A população parou em **7.977 entradas** de uma wallet aos **600,002s**, antes de atingir a meta de 10.000. Auditoria do histórico parcial: saldo reconstruído, saldo esperado pela quantidade de BETs e versão consistentes. O diagnóstico posterior (auditoria/ANALYZE/SELECTs) levou aproximadamente **682,37ms**, separado do tempo de população.

Não houve aquecimento, janela medida, comparação off/5s ou publicação/consumo desse ponto. Não há throughput HTTP/SQS de 10.000 entradas a apresentar. Este é um limite de duração escolhido para a preparação no ambiente atual, não um teto universal de capacidade ou falha financeira. O histórico parcial foi removido somente na limpeza dos recursos exclusivos de teste.

A trajetória de população foi preservada em [population-003.json](benchmarks/population-003.json). As fontes exatas estão em [sources-003.tar.gz](benchmarks/sources-003.tar.gz). A análise conjunta, escrita após a regressão final, está em [LOAD_IMPROVEMENT_PLAN.md](LOAD_IMPROVEMENT_PLAN.md).

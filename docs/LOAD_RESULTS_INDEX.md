# Sequência dos experimentos de carga

Cada relatório preserva o resultado da sua rodada. Os próximos números são reservados em ordem; não sobrescrever resultados anteriores para incorporar uma execução nova. Índice atualizado em 28/10/2026.

| Número | Relatório | Escopo | Estado |
|---|---|---|---|
| 001 | [LOAD_RESULTS.md](LOAD_RESULTS.md) | Piloto: 100/1.000 entradas, 1/3 wallets, 120 comandos, uma repetição, coleta off/100ms | Concluído; limites metodológicos registrados |
| 002 | [LOAD_RESULTS_002.md](LOAD_RESULTS_002.md) | Matriz ampliada: 100/1.000 entradas, 1/6 wallets, 360 comandos, duas repetições com ordem invertida, coleta off/5s/15s e sondas SQL repetidas | Concluído: 48 cenários e 17.280 operações; fontes em benchmarks/sources-002.tar.gz |
| 003 | [LOAD_RESULTS_003.md](LOAD_RESULTS_003.md) | Extensão controlada para 10.000 entradas, condicionada ao custo observado de população | Encerrado por orçamento: 7.977 entradas em 600,002s, auditoria consistente; sem janela de 10.000 |
| 004 | [LOAD_RESULTS_004.md](LOAD_RESULTS_004.md) | Execução local da edição experimental: histórico 100, 1/3 wallets, HTTP/SQS, 120 comandos/caso, duas repetições e coleta off/5s | Concluído: 16 cenários e 1.920 operações; fontes em benchmarks/sources-004.tar.gz |

O plano posterior a 002/003 já está consolidado; a rodada 004 verifica a execução local do pacote experimental e não aplica otimizações. Nenhum índice, trigger ou coletor de produção é alterado automaticamente por esses testes.

A matriz ampliada e a extensão podem produzir evidência de limite operacional de população. Um ponto interrompido por orçamento deve ser registrado como incompleto, com custo/entradas observados e auditoria, sem inventar throughput ou extrapolar resultados inexistentes.

## Análise após os testes

O [plano de melhorias](LOAD_IMPROVEMENT_PLAN.md) foi consolidado após encerrar 002/003 e passar a regressão final (205 testes/819 assertions). Nenhuma otimização foi implementada. As fontes medidas estão em [sources-002.tar.gz](benchmarks/sources-002.tar.gz) e [sources-003.tar.gz](benchmarks/sources-003.tar.gz). O 001 original e seu JSON permanecem inalterados.

Conferência final: 002 auditou 109.968 lançamentos em 168 wallets; 003 preservou auditoria do histórico parcial. Regressão: 205 testes/819 assertions, typecheck/build aprovados. Nenhuma janela de 10.000 foi declarada como executada.

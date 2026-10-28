# Experimento 004 — resultados

Estado: **completed**. [Registro estruturado](benchmarks/results-004.json). [Método](LOAD_TESTS.md). Brutos locais: `/home/harlem/projetos/backend-challenge/entrega_teste/load-results/run-d6162a00-d4dd-4c3a-b1d5-a1207876f241`. Relatório anterior: [3](LOAD_RESULTS_003.md).

Históricos: 100; wallets no perfil spread, quando selecionado: 3; distribuições: hot, spread; entradas: http, sqs; comandos/caso: 120; processos: 3; concorrência: 6; repetições: 2; intervalos de coleta: 5000ms, além de off. Limite de população/caso: 60000ms. Sondas SQL/caso: 2 repetições por consulta.

Quando há segunda repetição, ela percorre a matriz inteira em ordem inversa. Cada ponto tem população nova e constraints ativas. O número de wallets altera também o total de dados; não é um controle isolado de contenção. Código financeiro e dependências não foram otimizados entre esses pontos. Hardware, versões, configuração, hashes e indicadores por caso estão no JSON.

## Casos executados, na ordem registrada

| Caso | Seed (s) | ops/s | p50 (ms) | p95 (ms) | p99 (ms) | Lock p95 (ms) | Scrape p95 (ms) |
|---|---|---|---|---|---|---|---|
| h100-hot-http-off-r1 | 2.36 | 27.16 | 183.17 | 414.11 | 457.57 | 361.98 | - |
| h100-hot-http-scrape5000-r1 | 1.91 | 27.64 | 167.54 | 472.65 | 584.34 | 399.07 | 41.48 |
| h100-hot-sqs-off-r1 | 1.75 | 20.07 | 275.85 | 454.09 | 488.63 | 4.46 | - |
| h100-hot-sqs-scrape5000-r1 | 1.94 | 19.51 | 295.53 | 436.72 | 485.58 | 4.34 | 60.93 |
| h100-spread-http-off-r1 | 4.83 | 57.29 | 100.93 | 156.51 | 231.68 | 85.91 | - |
| h100-spread-http-scrape5000-r1 | 3.90 | 60.44 | 89.54 | 154.60 | 197.03 | 80.80 | 121.18 |
| h100-spread-sqs-off-r1 | 3.82 | 27.32 | 184.57 | 459.97 | 597.97 | 8.89 | - |
| h100-spread-sqs-scrape5000-r1 | 3.67 | 38.27 | 151.66 | 223.46 | 243.07 | 5.77 | 51.70 |
| h100-spread-sqs-scrape5000-r2 | 3.56 | 37.05 | 134.30 | 286.23 | 395.92 | 6.58 | 76.89 |
| h100-spread-sqs-off-r2 | 3.86 | 35.54 | 162.98 | 251.58 | 271.80 | 6.12 | - |
| h100-spread-http-scrape5000-r2 | 3.84 | 44.07 | 123.25 | 229.90 | 256.98 | 123.46 | 62.24 |
| h100-spread-http-off-r2 | 4.83 | 53.50 | 96.06 | 207.84 | 274.02 | 128.54 | - |
| h100-hot-sqs-scrape5000-r2 | 1.26 | 21.96 | 246.28 | 425.64 | 547.60 | 5.20 | 46.40 |
| h100-hot-sqs-off-r2 | 1.40 | 22.66 | 256.62 | 348.58 | 355.45 | 4.26 | - |
| h100-hot-http-scrape5000-r2 | 1.34 | 31.91 | 184.60 | 315.86 | 433.85 | 257.55 | 58.32 |
| h100-hot-http-off-r2 | 1.35 | 31.05 | 168.34 | 363.21 | 403.71 | 307.23 | - |

## Agregação das repetições

Percentis recalculados sobre as amostras reunidas; não é média de percentis. Throughput agregado pondera duração das janelas. Intervalos mínimo/máximo por repetição constam no JSON; essa agregação não prova causalidade nem saturação.

| Histórico/distribuição/entrada/coleta(ms) | Repetições concluídas | ops/s | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 100/hot/http/0 | 2 | 28.98 | 175.69 | 397.85 | 457.57 |
| 100/hot/http/5000 | 2 | 29.62 | 176.55 | 433.85 | 548.67 |
| 100/hot/sqs/0 | 2 | 21.29 | 262.98 | 426.93 | 487.54 |
| 100/hot/sqs/5000 | 2 | 20.66 | 262.64 | 436.72 | 528.06 |
| 100/spread/http/0 | 2 | 55.33 | 100.13 | 196.79 | 273.69 |
| 100/spread/http/5000 | 2 | 50.98 | 107.29 | 197.03 | 250.26 |
| 100/spread/sqs/0 | 2 | 30.90 | 171.38 | 333.89 | 570.77 |
| 100/spread/sqs/5000 | 2 | 37.65 | 144.93 | 252.07 | 372.33 |

## Conferência e limites

Cada caso concluído registra auditoria de saldo/ledger/versão, replay, inbox/outbox e DLQ. Erros, retries e conflitos, quando disponíveis, estão separados no JSON. /metrics é medido pelo endpoint real, incluindo DB e SQS; probes SELECT não representam todo o custo de PL/pgSQL/commit. HTTP e SQS medem percursos distintos. A frequência efetiva e quantidade de scrapes precisam ser consideradas, sobretudo quando a janela é menor que o intervalo.

Este arquivo preserva observações. O plano de melhoria será elaborado após encerrar os testes e revisar correção, variabilidade, planos SQL e limites operacionais; nenhuma melhoria é implementada automaticamente por este relatório.


## Escopo desta rodada — 28/10/2026

Rodada local solicitada pelo usuário para testar a edição experimental. A demonstração financeira ficou em projeto separado; a carga usou seus próprios schemas, banco/filas e três instâncias do runner. O perfil foi histórico inicial 100, uma/três carteiras, HTTP/SQS, 120 comandos/caso, concorrência seis, duas repetições em ordem inversa, coleta off/5s e duas sondas por SELECT. São 16 cenários e 1.920 comandos medidos.

Todos os casos concluíram com zero erros técnicos/rejeições inesperadas e auditorias consistentes, incluindo replay e outbox drenada. Não foi teste de saturação nem de capacidade universal. A API Swagger não participa das instâncias medidas do runner; foi adicionada como ferramenta local separada após a medição. Os cenários não devem ser comparados com 002 como se fossem um A/B de otimização: configuração, ambiente e duração diferem.

[Fontes medidas](benchmarks/sources-004.tar.gz) preservadas e conferidas por SHA-256 antes de alterar o Dockerfile experimental para acrescentar Swagger. Git não estava disponível dentro do ZIP/imagem: revisão/estado de worktree foram registrados como nulos, com hashes exatos dos arquivos. Resultados históricos 001/002/003 não foram sobrescritos. O ambiente é local compartilhado; os relatórios mantêm variação por cenário/repetição, sem inferir quantidade de usuários suportados.

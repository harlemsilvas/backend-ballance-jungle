# Experimento 002 — resultados

Estado: **completed**. [Registro estruturado](benchmarks/results-002.json). [Método](LOAD_TESTS.md). Brutos locais: `/tmp/ballance-load-experiment-002`. Relatório anterior: [piloto 001](LOAD_RESULTS.md).

Históricos: 100, 1000; wallets independentes: 6; comandos/caso: 360; processos: 3; concorrência: 6; repetições: 2; intervalos de coleta: 5000, 15000ms, além de off. Limite de população/caso: 600000ms. Sondas SQL/caso: 5 repetições por consulta.

Os cenários da segunda repetição percorrem a matriz inteira em ordem inversa. Cada ponto tem população nova e constraints ativas. O número de wallets altera também o total de dados; não é um controle isolado de contenção. Código financeiro e dependências não foram otimizados entre esses pontos. Hardware, versões, configuração, hashes e indicadores por caso estão no JSON.

## Casos executados, na ordem registrada

| Caso | Seed (s) | ops/s | p50 (ms) | p95 (ms) | p99 (ms) | Lock p95 (ms) | Scrape p95 (ms) |
|---|---|---|---|---|---|---|---|
| h100-hot-http-off-r1 | 2.06 | 39.97 | 139.61 | 251.58 | 339.17 | 217.65 | - |
| h100-hot-http-scrape5000-r1 | 1.53 | 39.71 | 141.75 | 254.77 | 356.15 | 220.31 | 42.89 |
| h100-hot-http-scrape15000-r1 | 1.39 | 36.92 | 143.73 | 297.63 | 340.26 | 248.67 | 40.98 |
| h100-hot-sqs-off-r1 | 1.31 | 22.96 | 238.74 | 406.48 | 502.61 | 4.69 | - |
| h100-hot-sqs-scrape5000-r1 | 1.37 | 24.51 | 216.60 | 392.13 | 538.89 | 4.43 | 52.62 |
| h100-hot-sqs-scrape15000-r1 | 1.34 | 26.46 | 212.58 | 309.36 | 330.82 | 4.22 | 43.17 |
| h100-spread-http-off-r1 | 7.31 | 81.45 | 64.94 | 131.91 | 166.39 | 14.33 | - |
| h100-spread-http-scrape5000-r1 | 7.36 | 79.05 | 67.43 | 136.96 | 170.67 | 13.36 | 103.97 |
| h100-spread-http-scrape15000-r1 | 7.45 | 85.37 | 63.89 | 127.88 | 164.02 | 16.00 | 92.18 |
| h100-spread-sqs-off-r1 | 6.98 | 42.76 | 137.74 | 183.85 | 220.42 | 4.95 | - |
| h100-spread-sqs-scrape5000-r1 | 7.02 | 41.27 | 138.51 | 196.46 | 222.33 | 5.10 | 140.14 |
| h100-spread-sqs-scrape15000-r1 | 7.15 | 41.56 | 136.74 | 201.49 | 254.45 | 4.82 | 130.85 |
| h1000-hot-http-off-r1 | 20.21 | 27.58 | 209.12 | 314.88 | 395.34 | 270.71 | - |
| h1000-hot-http-scrape5000-r1 | 18.67 | 24.53 | 241.09 | 352.66 | 418.33 | 310.27 | 50.46 |
| h1000-hot-http-scrape15000-r1 | 18.55 | 28.22 | 199.32 | 310.50 | 386.95 | 267.33 | 35.77 |
| h1000-hot-sqs-off-r1 | 17.86 | 20.99 | 269.19 | 379.36 | 457.53 | 3.38 | - |
| h1000-hot-sqs-scrape5000-r1 | 18.33 | 20.88 | 273.25 | 355.48 | 388.27 | 3.36 | 58.29 |
| h1000-hot-sqs-scrape15000-r1 | 18.38 | 20.80 | 276.80 | 362.85 | 391.87 | 3.41 | 46.85 |
| h1000-spread-http-off-r1 | 132.93 | 50.67 | 106.72 | 182.61 | 223.97 | 16.77 | - |
| h1000-spread-http-scrape5000-r1 | 140.71 | 45.80 | 115.47 | 217.32 | 262.53 | 22.31 | 131.61 |
| h1000-spread-http-scrape15000-r1 | 140.67 | 58.01 | 99.92 | 138.58 | 158.71 | 13.46 | 60.71 |
| h1000-spread-sqs-off-r1 | 133.77 | 34.60 | 165.66 | 222.22 | 234.40 | 4.26 | - |
| h1000-spread-sqs-scrape5000-r1 | 130.45 | 49.94 | 115.41 | 168.23 | 204.26 | 2.11 | 39.92 |
| h1000-spread-sqs-scrape15000-r1 | 102.78 | 51.85 | 113.39 | 142.74 | 177.06 | 2.28 | 42.86 |
| h1000-spread-sqs-scrape15000-r2 | 98.32 | 53.20 | 110.20 | 139.04 | 165.93 | 2.05 | 39.46 |
| h1000-spread-sqs-scrape5000-r2 | 98.06 | 52.58 | 110.12 | 144.00 | 159.20 | 2.25 | 41.90 |
| h1000-spread-sqs-off-r2 | 98.27 | 53.07 | 110.22 | 138.17 | 153.28 | 2.31 | - |
| h1000-spread-http-scrape15000-r2 | 97.62 | 89.86 | 60.65 | 101.82 | 148.40 | 11.08 | 109.25 |
| h1000-spread-http-scrape5000-r2 | 109.64 | 53.00 | 108.96 | 154.97 | 223.60 | 11.64 | 96.80 |
| h1000-spread-http-off-r2 | 140.07 | 55.28 | 101.46 | 150.86 | 214.83 | 15.34 | - |
| h1000-hot-sqs-scrape15000-r2 | 20.37 | 16.54 | 339.67 | 541.63 | 579.13 | 4.69 | 64.73 |
| h1000-hot-sqs-scrape5000-r2 | 17.65 | 23.51 | 221.80 | 388.60 | 610.83 | 3.22 | 80.64 |
| h1000-hot-sqs-off-r2 | 20.66 | 19.64 | 241.75 | 595.83 | 653.21 | 5.00 | - |
| h1000-hot-http-scrape15000-r2 | 17.67 | 24.55 | 199.93 | 534.20 | 583.75 | 449.64 | 89.52 |
| h1000-hot-http-scrape5000-r2 | 17.11 | 21.54 | 236.34 | 533.99 | 883.04 | 433.23 | 97.47 |
| h1000-hot-http-off-r2 | 20.36 | 18.67 | 232.69 | 628.89 | 937.93 | 541.21 | - |
| h100-spread-sqs-scrape15000-r2 | 15.24 | 18.85 | 300.22 | 483.97 | 609.45 | 12.31 | 139.23 |
| h100-spread-sqs-scrape5000-r2 | 9.07 | 32.65 | 171.24 | 276.28 | 322.85 | 5.94 | 110.89 |
| h100-spread-sqs-off-r2 | 7.56 | 38.19 | 155.88 | 275.03 | 314.30 | 6.20 | - |
| h100-spread-http-scrape15000-r2 | 8.39 | 67.98 | 80.07 | 148.93 | 211.15 | 14.22 | 107.84 |
| h100-spread-http-scrape5000-r2 | 8.13 | 64.98 | 81.25 | 173.13 | 235.93 | 20.04 | 424.31 |
| h100-spread-http-off-r2 | 10.38 | 64.66 | 89.41 | 147.00 | 197.25 | 16.37 | - |
| h100-hot-sqs-scrape15000-r2 | 2.21 | 22.27 | 238.53 | 463.55 | 601.06 | 5.02 | 57.20 |
| h100-hot-sqs-scrape5000-r2 | 1.32 | 24.14 | 219.64 | 406.32 | 546.32 | 4.52 | 52.57 |
| h100-hot-sqs-off-r2 | 1.20 | 24.92 | 217.55 | 379.21 | 425.04 | 4.47 | - |
| h100-hot-http-scrape15000-r2 | 1.33 | 31.59 | 174.69 | 338.34 | 383.16 | 287.49 | 46.62 |
| h100-hot-http-scrape5000-r2 | 1.08 | 35.25 | 156.01 | 331.80 | 380.70 | 269.52 | 51.26 |
| h100-hot-http-off-r2 | 1.36 | 36.57 | 144.63 | 310.45 | 401.27 | 257.85 | - |

## Agregação das repetições

Percentis recalculados sobre as amostras reunidas; não é média de percentis. Throughput agregado pondera duração das janelas. Intervalos mínimo/máximo por repetição constam no JSON; essa agregação não prova causalidade nem saturação.

| Histórico/distribuição/entrada/coleta(ms) | Repetições concluídas | ops/s | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 100/hot/http/0 | 2 | 38.19 | 142.17 | 278.24 | 375.90 |
| 100/hot/http/5000 | 2 | 37.34 | 148.03 | 290.03 | 371.73 |
| 100/hot/http/15000 | 2 | 34.05 | 159.79 | 315.88 | 377.90 |
| 100/hot/sqs/0 | 2 | 23.90 | 228.58 | 395.10 | 459.41 |
| 100/hot/sqs/5000 | 2 | 24.33 | 218.17 | 403.83 | 538.89 |
| 100/hot/sqs/15000 | 2 | 24.18 | 223.60 | 394.73 | 546.62 |
| 100/spread/http/0 | 2 | 72.09 | 75.21 | 142.06 | 190.22 |
| 100/spread/http/5000 | 2 | 71.33 | 74.15 | 151.78 | 198.46 |
| 100/spread/http/15000 | 2 | 75.69 | 69.69 | 141.13 | 198.28 |
| 100/spread/sqs/0 | 2 | 40.35 | 141.87 | 249.21 | 306.18 |
| 100/spread/sqs/5000 | 2 | 36.46 | 151.85 | 254.84 | 304.68 |
| 100/spread/sqs/15000 | 2 | 25.94 | 195.51 | 420.77 | 534.34 |
| 1000/hot/http/0 | 2 | 22.26 | 215.84 | 531.18 | 801.71 |
| 1000/hot/http/5000 | 2 | 22.94 | 238.68 | 422.80 | 679.27 |
| 1000/hot/http/15000 | 2 | 26.26 | 199.81 | 456.69 | 567.79 |
| 1000/hot/sqs/0 | 2 | 20.29 | 265.05 | 531.89 | 624.84 |
| 1000/hot/sqs/5000 | 2 | 22.12 | 257.02 | 368.48 | 588.83 |
| 1000/hot/sqs/15000 | 2 | 18.42 | 307.65 | 503.21 | 556.44 |
| 1000/spread/http/0 | 2 | 52.88 | 104.45 | 169.39 | 214.83 |
| 1000/spread/http/5000 | 2 | 49.14 | 111.00 | 204.51 | 244.09 |
| 1000/spread/http/15000 | 2 | 70.50 | 83.16 | 133.24 | 155.87 |
| 1000/spread/sqs/0 | 2 | 41.89 | 138.17 | 212.52 | 231.22 |
| 1000/spread/sqs/5000 | 2 | 51.23 | 112.29 | 149.73 | 187.38 |
| 1000/spread/sqs/15000 | 2 | 52.52 | 111.56 | 140.66 | 165.93 |

## Conferência e limites

Cada caso concluído registra auditoria de saldo/ledger/versão, replay, inbox/outbox e DLQ. Erros, retries e conflitos, quando disponíveis, estão separados no JSON. /metrics é medido pelo endpoint real, incluindo DB e SQS; probes SELECT não representam todo o custo de PL/pgSQL/commit. HTTP e SQS medem percursos distintos. A frequência efetiva e quantidade de scrapes precisam ser consideradas, sobretudo quando a janela é menor que o intervalo.

Este arquivo preserva observações. O plano de melhoria será elaborado após encerrar os testes e revisar correção, variabilidade, planos SQL e limites operacionais; nenhuma melhoria é implementada automaticamente por este relatório.

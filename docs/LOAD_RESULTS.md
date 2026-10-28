# Primeira medição exploratória — 27/10/2026

Rodada executada antes de qualquer otimização de índice, trigger ou coletor. [Metodologia e reprodução](LOAD_TESTS.md), [resumo estruturado](benchmarks/baseline-20261027.json) e resultados brutos locais em `/tmp/ballance-load-baseline-20261027`. O runner gera os brutos; o resumo versionável mantém ambiente, hashes do código, percentis, contadores, auditorias e descritores dos planos, sem payloads financeiros completos ou credenciais.

## Ambiente e escopo

- Linux amd64, Intel Core i5-10300H @ 2.50GHz, oito CPUs lógicas e 8.154.411.008 bytes de RAM informados pelo SO. Máquina compartilhada, sem afinidade de CPU ou exclusividade garantida.
- Bun 1.4.4 no host; PostgreSQL 17.6-alpine e LocalStack 4.8.1 com os digests de IMAGES.md, inspecionados no projeto ballance-load-check. Containers sem limites explícitos de CPU/RAM. A imagem Bun no Dockerfile é registrada como configuração da entrega; os filhos deste experimento usam o Bun do host.
- PostgreSQL com shared_buffers=128MB, max_connections=100, fsync=on, synchronous_commit=on e autovacuum=on. Triggers/constraints e isolamento transacional originais mantidos.
- Três processos combinando API + consumidor + publisher, com runtime DB restrito e pool máximo cinco por processo, além do pool administrativo do gerador. Scheduler ausente deste perfil de BETs. Essa topologia de medição não é a topologia separada do Compose de entrega.
- Um cenário por vez; uma repetição, sempre off/on neste piloto. Cada cenário com schema/login/filas exclusivos e população nova pelos casos de uso. Não foram executadas outras suítes durante as janelas medidas; atividades externas da máquina não são controladas.
- Histórico de 100/1.000 entradas por wallet antes de seis operações de aquecimento, 120 comandos medidos, concorrência fechada de seis e scrapes configurados a cada 100ms por réplica quando ligados. Somente BETs sintéticas de 0.01, com saldo inicial sintético suficiente.
- A população somou 367,52s, fora da janela medida; startup, planos, aquecimento e drenagens também não compõem throughput. Isso não deve ser confundido com duração total do experimento.
- Base Git 9e0206c com alterações locais; hashes completos do código/configuração medidos estão no JSON. A base Git isolada não reproduz o runner ainda não commitado.

## Resultados observados

Tempos em milissegundos. ops/s é quantidade PROCESSED / duração dos comandos medidos. HTTP mede ida/resposta; SQS inclui envio, fila, processamento, ack e notificação IPC, portanto os transportes medem percursos diferentes. Percentis nearest-rank. Uma única repetição e 120 comandos não caracterizam caudas ou capacidade de produção.

| Histórico por wallet | Wallets | Entrada | Scrapes | ops/s | p50 | p95 | p99 | Lock p95 | Scrape p95 |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 1 | http | off | 32.84 | 169.78 | 285.64 | 350.35 | 247.33 | - |
| 100 | 1 | http | on | 28.81 | 197.09 | 356.74 | 375.50 | 306.46 | 58.42 |
| 100 | 1 | sqs | off | 19.83 | 279.10 | 461.32 | 524.80 | 5.64 | - |
| 100 | 1 | sqs | on | 20.68 | 282.22 | 374.08 | 396.46 | 4.51 | 47.93 |
| 100 | 3 | http | off | 55.98 | 96.54 | 177.39 | 195.66 | 102.90 | - |
| 100 | 3 | http | on | 51.97 | 108.60 | 179.79 | 210.16 | 105.12 | 148.86 |
| 100 | 3 | sqs | off | 37.81 | 157.72 | 226.02 | 251.76 | 7.82 | - |
| 100 | 3 | sqs | on | 29.65 | 198.10 | 322.13 | 357.17 | 7.18 | 105.45 |
| 1000 | 1 | http | off | 25.86 | 213.17 | 371.42 | 395.07 | 321.95 | - |
| 1000 | 1 | http | on | 21.85 | 260.60 | 432.25 | 502.82 | 371.29 | 41.56 |
| 1000 | 1 | sqs | off | 17.58 | 320.32 | 462.21 | 484.11 | 4.66 | - |
| 1000 | 1 | sqs | on | 16.14 | 364.45 | 475.01 | 489.72 | 5.18 | 40.64 |
| 1000 | 3 | http | off | 45.02 | 126.57 | 192.77 | 225.04 | 109.43 | - |
| 1000 | 3 | http | on | 39.16 | 129.27 | 251.71 | 373.76 | 162.14 | 111.74 |
| 1000 | 3 | sqs | off | 22.87 | 256.24 | 362.41 | 394.33 | 7.55 | - |
| 1000 | 3 | sqs | on | 19.32 | 284.90 | 585.12 | 717.16 | 17.04 | 127.08 |

## Correção e recuperação de recursos

Os 16 cenários concluíram com:

- 1.920 comandos medidos PROCESSED, zero rejeições de negócio e zero erros técnicos.
- 19.616 transações/lançamentos conferidos entre população, aquecimento e carga, em 32 wallets distintas ao longo dos cenários. Saldo reconstruído, saldo esperado pela quantidade de comandos, ledger e versão consistentes em todas.
- Replay representativo após outras operações em cada cenário preservando transactionId e saldo histórico do resultado persistido, sem outro lançamento.
- Inbox esperada para as entradas SQS, eventos publicados, outbox drenada e DLQ vazia.
- Zero retries e zero conflitos de lock (deadlock/timeout/serialização) nos counters dos filhos, apesar de haver espera pelos locks. Espera sem timeout não incrementa contador de conflito.
- 1.146 scrapes reais com zero falhas de fonte DB/SQS. O máximo entre snapshots pós-janela foi backlog=8 e lag=0,145628s; não são picos globais. A maior drenagem pós-janela levou 181,57ms.
- RSS ao final dos filhos entre 137.011.200 e 161.714.176 bytes por processo. CPU user/system por filho consta no JSON; RSS final não é pico de memória, e esses números não incluem memória/CPU de banco, emulador e gerador.

O teste de integração específico interrompeu a carga após o início da medição nos três processos e confirmou a remoção de schema, login e filas próprios, preservando um schema de controle. Nenhum índice, migration, domínio, caso de uso ou adaptador de produção foi alterado nesta etapa.

## Leitura dos resultados

**Contenção aparece no HTTP hot.** Por exemplo, com histórico 1.000 e scrapes desligados, p95 total foi 371,42ms e p95 da espera de lock foi 321,95ms. Esses percentis vêm de conjuntos de amostras distintos: não se deve subtraí-los nem atribuir uma fração exata do tempo a partir dessa comparação. A relação é compatível com contenção de uma wallet sob seis requisições concorrentes, conforme a arquitetura.

**O SQS reduz a disputa observada no banco para a mesma wallet.** No mesmo histórico hot/off, lock p95 foi 4,66ms; a latência ponta a ponta SQS foi 462,21ms. MessageGroupId por wallet serializa entregas no broker. Isso explica por que fila, commit e ack precisam ser medidos além do lock; não permite remover os locks/constraints que protegem concorrência HTTP e múltiplas entradas.

**Histórico maior merece continuidade da investigação.** No hot HTTP sem scrape, a observação passou de 32,84 para 25,86 ops/s entre históricos 100 e 1.000. A rodada foi ordenada e tem uma repetição, sem controle de aquecimento/temperatura/carga externa suficiente para uma inferência causal. Ela sustenta repetir/profilar o crescimento; não fornece uma função de custo ou um limite de capacidade.

**A coleta adiciona trabalho, mas o efeito não é uniforme neste piloto.** Há casos com p95 maior e throughput menor com scrapes; em hot SQS/histórico 100, o par apresentou p95 menor e throughput ligeiramente maior. Não atribuir todas as diferenças a GROUP BY: /metrics também chama SQS, disputa pools/CPU e acrescenta HTTP. O experimento não separa esses componentes. Priorizar repetições com ordem alternada, intervalos realistas de coleta e medição de cada fonte antes de alterar o coletor.

**O índice por wallet é candidato, não correção comprovada.** A sonda transaction_wallet para histórico 1.000 e três wallets realizou Seq Scan, retornou 1.000 linhas e filtrou 2.000; execução observada de 0,668ms e 188 blocos em cache no caso HTTP/off. Essa consulta não reproduz toda a função de consistência. Selecionar um terço de uma tabela de 3.000 linhas pode justificar Seq Scan. Precisamos de maior cardinalidade de wallets e comparação antes/depois para decidir o índice; ausência do índice não prova que ele domina os tempos da janela.

## Próximo experimento recomendado

Repetir a matriz com ordem alternada (LOAD_REPEATS>=2), mais wallets independentes e quantidade maior de amostras. Quando operacionalmente viável, ampliar histórico para 10.000, registrando custo de população. Comparar o custo efetivo de /metrics em intervalos realistas, o caminho financeiro completo e os SELECTs da validação. Só depois propor o pacote 3, mantendo SQL adversarial, replay e concorrência intactos.

Este relatório conclui o primeiro piloto do pacote 2, não um benchmark de capacidade/saturação, comprovação de HA ou promessa de atendimento a muitos usuários. Os limites metodológicos fazem parte da evidência. Dados brutos em /tmp podem desaparecer; o JSON revisado no repositório preserva o resumo utilizado aqui.

## Regressão e encerramento

Após a rodada, typecheck e build passaram. A suíte funcional completa terminou com **204 testes, 806 assertions, zero falhas, 18 arquivos** (44,18s), incluindo a prova de interrupção/limpeza. Foram conferidos zero schemas de teste, zero logins/conexões de carga e nenhuma fila temporária remanescente. PostgreSQL/LocalStack do projeto de medição foram parados com saída 0, preservando o volume. O ambiente original já estava parado nesta retomada e não foi alterado. Sem commit/push/deploy.

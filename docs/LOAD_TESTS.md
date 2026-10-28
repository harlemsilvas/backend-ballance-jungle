# Medição exploratória de histórico, locks e coleta

O runner `bun run test:load` implementa o primeiro experimento do pacote 2 de PLANO_CORRECOES.md (material complementar do repositório de desenvolvimento), com respaldo na seção 14 do [enunciado](CHALLENGE.md). Ele exercita código existente sem modificar domínio, casos de uso, adaptadores, migrations ou constraints. Não é executado por `bun test` nem pelo build de produção.

## Preparação e execução

Para avaliação com apenas Docker instalado, prefira `sh experimento.sh load` (curto), `sh experimento.sh load3000` (focado) ou `sh experimento.sh load-volume` (comparativo). Esses scripts preparam infraestrutura e dependências automaticamente. Os comandos Bun abaixo são a alternativa de desenvolvimento com preparação manual; não são necessários para o fluxo Docker. Para usar o perfil focado/comparativo nesse fluxo manual, substitua `bun run test:load` no exemplo por `bun run test:load3000` ou `bun run test:load:volume`, preservando as variáveis de conexão e confirmação.

Use uma infraestrutura exclusiva. O exemplo abaixo usa portas diferentes do ambiente de desenvolvimento e projeto Compose próprio, com as imagens fixadas em [IMAGES.md](IMAGES.md):

```bash
POSTGRES_PORT=35546 LOCALSTACK_PORT=34567 docker compose -p ballance-load-check up -d --wait postgres localstack
LOAD_CONFIRM=isolated DB_HOST=127.0.0.1 DB_PORT=35546 DB_NAME=ballance DB_USER=ballance DB_PASSWORD=local-development-only SQS_ENDPOINT=http://127.0.0.1:34567 TEST_SQS_ENDPOINT=http://127.0.0.1:34567 bun run test:load
```

Requer Bun 1.4.4 no PATH, dependências instaladas e permissão administrativa apenas no banco local de medição para criar os recursos temporários. O usuário administrativo não é utilizado pelos processos que recebem a carga: cada cenário cria login restrito com senha aleatória em memória, usado pelos três processos filhos. O runner exige confirmação explícita do alvo isolado, DB_HOST loopback/DB_PORT explícitos e endpoint SQS local sem credenciais na URL. Essa confirmação não identifica sozinha se o banco está ocioso: escolha o ambiente correto antes de iniciar.

Nenhuma senha de runtime é impressa ou gravada nos resultados. Não usar a conta, filas ou dados de produção. Nenhum comando do runner remove volumes, recria containers ou limpa recursos por prefixo global.

## Matriz e controles

| Variável | Default | Configuração |
|---|---|---|
| Histórico por wallet antes do aquecimento | 100 e 1.000 entradas, incluindo OPENING | LOAD_HISTORIES, lista de inteiros entre 2 e 10.000 |
| Distribuição | Uma wallet disputada e três independentes | LOAD_WALLETS altera o caso spread (2–100) |
| Transporte | HTTP e SQS, em cenários separados | Ambos executados na matriz |
| Processos filhos | 3 | LOAD_PROCESSES (3–8) |
| Concorrência oferecida | 6 requisições em andamento | LOAD_CONCURRENCY (1–100) |
| Requisições medidas por caso | 120 | LOAD_REQUESTS (6–10.000) |
| Repetições | 1, piloto exploratório | LOAD_REPEATS (1–10) |
| Coleta periódica | Desligada e ligada em cada réplica | LOAD_SCRAPE_MS (default 100ms, mínimo 20ms) |
| Arquivos de resultado | Novo diretório em /tmp com UUID | LOAD_OUTPUT deve apontar para diretório ainda inexistente |

O default gera 16 cenários: dois históricos × duas distribuições × dois transportes × coleta off/on. Na primeira repetição o par é off/on; a ordem é invertida nas repetições pares. Uma única repetição não permite separar variação temporal e efeito causal da coleta. Para conclusões de otimização, repetir o experimento, verificar variabilidade e controlar o ambiente.

Cada caso usa schema `bb_test_<uuid>`, login `bb_load_<mesmo uuid>` e três filas FIFO `bb-test-<uuid>-commands/dlq/events.fifo`. Não compartilha histórico com outro cenário. A população ocorre pelos casos de uso reais, sequencialmente, com todas as constraints ativas. Não há escrita de histórico financeiro por INSERT em massa, desativação de triggers ou reconstrução artificial de saldo. O tempo dessa população é separado em seedMs.

O conjunto usa abertura sintética positiva e somente BET de 0.01 BRL. Não modela mix de WIN/LOSS/reversões/referências; esses comportamentos continuam cobertos pela suíte funcional. Abertura e quantias são strings; cálculos de conferência financeira são numeric no PostgreSQL. Históricos maiores podem tornar a preparação demorada.

Após a população: ANALYZE das tabelas, sondas SQL e inicialização dos três processos. Cada filho compõe API NestJS + consumidor SQS + publisher, com pool de até cinco conexões, login restrito e validação `assertRuntimeDatabase`. É uma topologia de experimento, diferente dos serviços API/worker separados do Compose de entrega. O scheduler não participa porque a carga não contém referências pendentes.

Os publishers drenam a outbox da população antes do aquecimento. Há duas operações de aquecimento por processo, com nova drenagem. Depois, amostras e contadores de medição são reiniciados. Assim, o histórico no início da janela medida inclui também o aquecimento informado no relatório.

## O que é medido

- Carga de ciclo fechado: no máximo LOAD_CONCURRENCY comandos em andamento; não é taxa de chegada fixa nem prova de saturação. Throughput é PROCESSED dividido pelo tempo para concluir os comandos medidos, excluindo população, startup, aquecimento e drenagem final.
- HTTP: duração no gerador entre envio e leitura da resposta JSON, incluindo rede local e commit.
- SQS: duração no gerador entre início do envio e recebimento, por stdout do filho, do evento emitido depois de DeleteMessage confirmado. Inclui fila, processamento, ack e IPC. Não comparar diretamente esses percentis com os de HTTP como se medissem o mesmo percurso. MessageGroupId é walletId, preservando a serialização FIFO no caso hot.
- Locks e processamento: amostras da porta Telemetry existente em milissegundos, antes de agregação em buckets. O tempo de processamento inclui a unidade transacional/commit e retries; não é medição isolada do comando COMMIT ou da função PL/pgSQL.
- Scrapes reais por HTTP em /metrics nos três filhos. Rodadas não se sobrepõem; se uma rodada ultrapassar o intervalo, a frequência efetiva cai. São medidos duração, número de amostras e erros, verificando saúde das fontes DB/SQS. A rodada em andamento termina antes de fechar a coleta, sem estender o denominador do throughput.
- Backlog/lag da outbox: snapshot após o fim dos comandos e término da última coleta, mais tempo de drenagem final. Não é pico nem série temporal do backlog. Nos casos off, gauges globais não coletados do registry não devem ser interpretados como estado saudável zero; a conferência usa SQL.
- CPU dos filhos (user/system em microssegundos desde reset) e RSS ao final. A leitura ocorre depois de terminar a última coleta; são aproximações dessa janela, não custo exclusivo das transações. CPU/RAM do gerador e dos containers não são séries contínuas do runner.
- Percentis pelo método nearest-rank sobre amostras completas, sem interpolação. Contagens pequenas não permitem inferir cauda de produção.

Os filhos usam a instrumentação existente com destino de logs suprimido no adaptador de medição; apenas readiness e ack IDs trafegam pelo canal de controle. O custo de logs JSON/collector em produção não está representado integralmente. Endpoints `__load` existem somente no script filho, em listener loopback com porta efêmera, e ficam fora do build/Dockerfile da aplicação.

## Planos SQL e limitações de atribuição

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) é executado, após ANALYZE e antes da carga, para soma/cadeia do ledger, predicado de transações por wallet, contagem de status e pendência da outbox. São sondas SELECT sem escrita financeira. Não representam todos os joins/branches da função de consistência, nem um profiling completo de PL/pgSQL.

Essas sondas aquecem caches; a rodada não é de cache frio. Os índices/triggers permanecem iguais aos da entrega. A diferença hot/spread muda tanto a disputa quanto o total de linhas (mesmo histórico por wallet, wallets em quantidades diferentes), portanto não isola exclusivamente contenção. A ausência de Seq Scan após uma mudança também não seria, sozinha, prova de melhora.

A [documentação PostgreSQL 17](https://www.postgresql.org/docs/17/using-explain.html) explica o uso de EXPLAIN e os limites dos custos/planos. A decisão de índices/trigger incremental exige comparação e preservação de correção, não apenas observação de uma operação de scan.

## Conferência e limpeza

Depois de cada janela, o runner drena eventos e faz replay HTTP de uma operação já executada, comparando com seu snapshot terminal persistido. Para todas as wallets do cenário, verifica saldo reconstruído, saldo esperado pela quantidade exata de débitos, contagem de ledger prevista e versão. Confere totais de transações/ledger/inbox, outbox sem pendências e DLQ vazia. Duplicação ou perda não pode ser escondida apenas porque saldo e ledger concordam entre si.

Cenários saudáveis exigem todas as operações processadas e nenhum erro técnico, rejeição inesperada ou falha de scrape. Um erro interrompe a matriz e impede gerar summary.json final; relatórios dos casos já concluídos permanecem disponíveis. Esse perfil não é teste de rejeição de negócio ou falha deliberada: a separação dos contadores permite detectar ocorrências inesperadas.

SIGINT/SIGTERM no pai interrompem novas tarefas, aguardam as tarefas em andamento e encerram os filhos com prazo. Em finally são removidas somente filas/login/schema daquele cenário, usando nomes exatos gerados. O teste de integração `load-runner.test.ts` interrompe a carga após os três filhos iniciarem a medição e comprova a limpeza, mantendo um schema de controle intacto. Em SIGKILL do pai ou perda de banco/rede pode haver recursos residuais; identificar UUID pelo evento load_case_start e inspecionar antes de qualquer remoção manual.

O processo de medição não testa as janelas críticas de crash financeiro; a suíte de mensageria existente continua responsável por esses cenários.

## Artefatos

`environment.json` contém hardware/OS/Bun, commit-base, indicação de worktree suja, configuração, referências de imagem e hashes SHA-256 do código/configuração realmente medidos. O commit-base sozinho não identifica este experimento enquanto mudanças locais não forem commitadas. As referências de imagens registradas vêm dos arquivos locais; a inspeção dos containers usados deve complementar o registro de ambiente.

Cada caso gera JSON com amostras de latência, métricas, recursos, planos e auditoria. `summary.json` reúne casos somente após sucesso da matriz. Os arquivos não incluem comandos financeiros completos, senhas ou tokens. Um resumo revisado pode ser mantido em docs/benchmarks para discussão; os resultados brutos em /tmp são artefatos locais e não garantia de retenção permanente.

A primeira rodada está em [LOAD_RESULTS.md](LOAD_RESULTS.md); as seguintes estão no [índice sequencial](LOAD_RESULTS_INDEX.md). Nenhum índice, trigger ou coletor de produção deve ser alterado como parte desta medição.


## Extensão do protocolo — experimentos sequenciais

A partir do experimento 002, LOAD_SCRAPE_INTERVALS aceita uma lista de intervalos (por exemplo, 5000,15000). Cada ponto inclui off uma única vez, além dos intervalos solicitados; com dois históricos, duas distribuições, dois transportes, três regimes de coleta e duas repetições, a matriz tem 48 pontos. A segunda repetição percorre a matriz inteira em ordem inversa, incluindo históricos/distribuições/transportes, além dos regimes de coleta. Não mesclar essa versão do protocolo com o piloto sem identificar a diferença.

LOAD_SHAPES (hot,spread) e LOAD_TRANSPORTS (http,sqs) permitem uma extensão focada, sem afirmar que ela cobre a matriz inteira. LOAD_SQL_PROBE_REPEATS permite repetir os EXPLAINs por consulta; as sondas agora também incluem contagem de mudanças do ledger e a checagem SELECT de consistência de transações/referências, reproduzida a partir da migration. Essa sonda resolve o estado da wallet por join, enquanto a função original já possui o registro w; não é profiling exato da função PL/pgSQL nem medida isolada do commit. O custo do caminho financeiro completo continua vindo das amostras de processamento e do gerador.

LOAD_SEED_BUDGET_MS limita a população por cenário, incluindo todas as wallets desse cenário. Zero mantém a política anterior sem limite explícito. Ao atingir o limite, o runner espera um commit completo, audita saldo/ledger/versão e saldo esperado do histórico parcial, escreve um arquivo population-limit.json e encerra a matriz com código diferente de zero. Esse evento é um limite operacional planejado, não amostra de latência nem evidência de falha financeira. Não há summary.json de matriz concluída; pontos anteriores ficam preservados. Um teste de integração verifica o caminho de limite e a limpeza.

Com intervalos de 5s/15s, algumas janelas curtas podem observar apenas uma rodada de coleta. Interpretar a quantidade/frequência efetiva registrada por caso; não inferir custo contínuo a partir de uma coleta. A conclusão da rotina de scrape pode aguardar o intervalo ocioso antes de retornar: isso fica fora do denominador do throughput, mas amplia a janela aproximada de CPU/RSS lida após a coleta. Essa limitação impede tratar recursos dos filhos como custo exclusivo da janela transacional.

[LOAD_RESULTS_INDEX.md](LOAD_RESULTS_INDEX.md) mantém a sequência: o piloto original é 001 e os próximos relatórios usam LOAD_RESULTS_002.md, LOAD_RESULTS_003.md etc. O exportador scripts/load/report.ts recusa sobrescrever relatório/JSON existentes, exige o número anterior e confere os hashes do código medido. Agregações reúnem amostras e ponderam duração; não fazem média de p95. Um limite de população deve ser exportado como registro incompleto, sem preencher tempos ausentes.

A matriz ampliada usa seis wallets no caso spread, 360 comandos por caso, concorrência seis, três processos, duas repetições, coleta off/5s/15s e cinco sondas por SELECT. O limite de população por caso é 600.000ms. A extensão focada 003 mirou 10.000 e atingiu o orçamento em 7.977 entradas, com auditoria/SELECTs preservados e sem janela medida nesse volume. Não foram desativados triggers para completar a meta. O plano de melhorias virá somente depois de encerrar as medições, sem implementação imediata.


## Preservação das versões medidas

Os experimentos 002 e 003 têm fontes/configurações selecionadas preservadas em [sources-002.tar.gz](benchmarks/sources-002.tar.gz) e [sources-003.tar.gz](benchmarks/sources-003.tar.gz). Cada arquivo listado foi conferido contra o SHA-256 registrado no environment.json daquela rodada. Os bundles contêm somente arquivos conhecidos do código/configuração e metadados selecionados; não contêm .env, senhas aleatórias de runtime, banco de dados ou payloads completos. A base Git e a lista exata dos arquivos estão em MEASUREMENT_ENVIRONMENT.json dentro de cada bundle.

Isso preserva a versão do runner mesmo com o worktree ainda sem commit. O código financeiro é o mesmo nos dois experimentos; a versão 003 acrescenta ANALYZE/sondas SELECT ao diagnóstico de população interrompida e esclarece o texto do relatório para perfis focados. Esse diagnóstico ocorre depois de capturar o tempo ao atingir o limite e tem duração registrada separadamente, sem virar uma janela financeira medida. O bundle não promete repetir exatamente tempos, UUIDs ou estados de cache.

A primeira matriz ampliada (002) terminou com 48 cenários, duas repetições contrabalanceadas, 17.280 operações e 109.968 lançamentos auditados. O perfil 003 mira 10.000 entradas numa única wallet, HTTP, 720 comandos e coleta off/5s, em uma repetição de viabilidade; ele não substitui a matriz contrabalanceada nem testa seis wallets com 10.000 entradas. O limite é de dez minutos de população por ponto, sem relaxar invariantes.


## Perfis nomeados: diagnóstico 3.000 e comparação de volume

Além do runner genérico `bun run test:load` (default de histórico 100/1.000), há dois atalhos opcionais:

- `bun run test:load3000`: força histórico 3.000, hot/HTTP, 120 comandos/caso, uma repetição e coleta off/5s por padrão. É diagnóstico, não A/B com rodadas históricas.
- `bun run test:load:volume`: históricos 100/1.000/3.000, mesmos comandos/transporte/distribuição, duas repetições e coleta off/5s. São 12 casos e 1.440 comandos medidos se concluir.

Ambos usam três processos, concorrência seis e orçamento padrão de 180.000ms por população de caso. O perfil recusa histórico conflitante e orçamento nulo; o runner mantém a exigência de alvo local isolado. Overrides de outros parâmetros continuam sujeitos às validações existentes. O limite não inclui toda a matriz/startup/carga/diagnóstico, e um orçamento excedido não vira throughput zero.

`--describe` imprime apenas a configuração do perfil, sem abrir banco/fila nem iniciar carga. Os perfis não alteram os defaults do runner genérico. No pacote experimental, use `sh experimento.sh load3000` ou `sh experimento.sh load-volume`; a instalação curta mantém `sh experimento.sh load` com histórico 20 e 24 comandos/caso.

Histórico é quantidade inicial de lançamentos por carteira, incluindo OPENING, não usuários, operações simultâneas ou só tamanho do arquivo. Aquecimento e comandos medidos acrescentam histórico. A comparação fixa o perfil para variar esse tamanho, com repetição invertida; continua sendo experimento local, não prova de capacidade universal.

Estado: configuração/preview e testes unitários conferidos; o comparativo de 3.000 ainda não tem rodada medida. Quando executado e revisado, registrar o próximo RESULTS sequencial (005), sem sobrescrever 004 ou misturar percentis de protocolos diferentes. Não escolher o volume para obter um número mais atraente nem desativar constraints para completar a população.

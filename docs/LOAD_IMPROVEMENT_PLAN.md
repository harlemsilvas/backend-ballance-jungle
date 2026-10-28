# Plano após os experimentos 002 e 003

Consolidado em 27/10/2026, **depois de encerrar as medições e passar a regressão funcional**. Estado: proposta para trabalho futuro; nenhuma melhoria de índice, trigger, lock, coletor ou domínio foi implementada. A prioridade é preservar as garantias do [enunciado](CHALLENGE.md), especialmente seções 5, 6, 8, 10, 11 e 13.

## Evidência disponível

| Registro | Evidência | Limite de interpretação |
|---|---|---|
| [001](LOAD_RESULTS.md) | Piloto original, 1/3 wallets, 120 comandos e coleta de 100ms | Uma repetição e protocolo diferente do 002; não é baseline A/B de uma otimização |
| [002](LOAD_RESULTS_002.md) | 48 pontos, duas repetições em ordem inversa, 1/6 wallets, 360 comandos/caso, off/5s/15s e cinco sondas por SELECT | 17.280 operações, não saturação ou estimativa de usuários suportados; algumas janelas têm poucas coletas |
| [003](LOAD_RESULTS_003.md) | Tentativa focada de 10.000 entradas; população interrompida em 7.977 entradas e 600,002s, auditoria consistente e SELECTs preservados | Nenhuma janela de carga de 10.000 executada; limite do orçamento escolhido, não capacidade máxima universal |

A regressão posterior terminou com **205 testes, 819 assertions, zero falhas, 18 arquivos**; typecheck/build aprovados. Inclui SQL adversarial, referências, replay, concorrência entre processos, publishers, crashes e controles do runner. Os arquivos src e as migrations permaneceram iguais; a instrumentação e os relatórios novos ficam fora do build da aplicação.

O 002 auditou 109.968 transações/lançamentos em 168 wallets ao longo dos casos; não detectou erros técnicos, rejeições inesperadas, falhas de scrape, retries ou conflitos SQL. Houve espera de lock; isso é diferente de deadlock/timeout. O 003 não completou população, aquecimento, carga ou publicação: seus dados não podem ser apresentados como recuperação ponta a ponta nesse volume.

## O que os resultados sustentam

1. **O crescimento do histórico precisa de investigação prioritária.** Na população do 003, 1.001 entradas custaram 22,09s; 2.001, 58,14s; 4.001, 179,42s; 6.001, 361,47s; 7.977, 600,002s. A implementação conhecida repete soma, contagem, verificação transacional e cadeia histórica nos triggers diferidos. Esses dados sustentam aprofundar esse caminho, sem atribuir todo o custo a uma única consulta ou declarar uma lei assintótica medida.
2. **O predicado por wallet tem candidato de índice, mas ainda não há A/B.** No 002 há varreduras e filtragem de outras wallets; em uma única wallet, uma consulta pode legitimamente precisar de toda a tabela. O índice proposto não elimina a soma/cadeia de todo o histórico da mesma wallet.
3. **As sondas de validação custam mais no histórico parcial maior.** No 003, a sonda derivada de consistência transacional teve mediana de 25,633ms em cinco execuções; a cadeia, 8,124ms; contagem de mudanças, 6,279ms. São SELECTs fora da carga, em cache aquecido. A sonda de consistência resolve a wallet por join; não é o plano exato da função PL/pgSQL nem tempo isolado de commit. Não multiplicar ou subtrair percentis para estimar o custo total dos triggers.
4. **Não há efeito monotônico de coleta demonstrado.** Por exemplo, HTTP spread/histórico 1.000 apresentou throughput agregado 52,88 ops/s sem coleta, 49,14 a 5s e 70,50 a 15s; neste último regime as duas repetições variaram de 58,01 a 89,86 ops/s. Esses resultados não justificam afirmar que coleta melhora desempenho, nem que um cache dará certo ganho. /metrics inclui DB, SQS e HTTP, e o ambiente é compartilhado.

## Prioridade 0 — fechar a atribuição dos custos

Antes de escolher uma alteração invasiva, executar uma rodada focada em:

- Tempo da unidade financeira completa e tempo depois do callback antes da confirmação, com instrumentação de teste claramente identificada. Separar espera de lock, consultas, flush e confirmação quando viável; não alterar o contrato de commit/ack.
- Perfil das consultas/trigger no PostgreSQL, em ambiente exclusivo e com dados sintéticos. Incluir consumo de CPU, I/O e plano efetivamente usado pela função, além das sondas externas. Definir limites para o overhead do profiler; não registrar segredos ou payloads completos.
- Cardinalidade de wallets variando com total de linhas controlado, separada do teste de crescimento por wallet. Registrar histórico efetivo no início/fim de cada janela: as BETs acrescentam ledger durante a própria medição.
- Janelas suficientemente longas para várias coletas de 5s/15s e aquecimento maior; pelo menos mais uma repetição para melhorar a leitura da variabilidade. Isolar fontes DB/SQS do custo de renderização/transporte sem substituir o endpoint real no teste principal.

**Aceite:** relatório sequencial novo com versão/fontes, configuração, duração, amostras, planos e auditorias; efeito que seja repetível e maior que a variação observada. Não converter um percentil de poucos scrapes em garantia de latência do coletor.

## Prioridade 1 — candidato pequeno: índice por wallet

**Proposta futura:** avaliar uma migration nova com índice geral em wager_transactions(wallet_id), comparando a consulta por wallet e a validação completa no mesmo conjunto de dados. Não editar migrations já publicadas nem mudar identidades globais para facilitar o índice.

**Experimento:** controle sem índice versus candidato, com mesmos históricos, cardinalidade, distribuição, concorrência e ordem contrabalanceada. Medir o caminho financeiro completo, planos/buffers e custo de escrita/armazenamento. Não exigir Index Scan em uma tabela pequena ou em um predicado que seleciona grande parte dela.

**Aceite para adoção:** benefício reproduzível no perfil relevante, sem piora material não explicada em outros perfis, e SQL adversarial/replay/concorrência/atomicidade aprovados. Planejar criação e reversão de índice conforme o ambiente. Se escolher construção concorrente, revisar compatibilidade com o runner transacional: PostgreSQL não permite CREATE INDEX CONCURRENTLY dentro de um bloco de transação. [Documentação PostgreSQL 17](https://www.postgresql.org/docs/17/sql-createindex.html).

## Prioridade 2 — candidato estrutural, de maior risco: validação histórica

**Proposta futura, condicionada ao profiling:** reduzir revalidações completas repetidas por wallet no mesmo commit e/ou desenhar validação incremental no banco. O objetivo é diminuir trabalho crescente, sem trocar uma garantia de consistência por uma checagem eventual.

A solução precisa provar que saldo, versão, identidade, referências e cadeia permanecem corretos também para SQL direto, não apenas pelo caminho NestJS/MikroORM. Preservar ledger append-only, UNIQUE/FKs, não-negatividade, terminais e inbox/outbox atômicas. Não depender de cache em memória ou de uma flag de sessão manipulável pelo papel de runtime para dispensar validação.

**Critérios específicos:** abertura zero/positiva, primeiro movimento, múltiplos movimentos da mesma wallet na mesma transação, LOSS/rejeições/referências, SET CONSTRAINTS, savepoints/rollback, tentativas de violar cadeia/versão por SQL e concorrência entre três ou mais processos. Uma eventual reconciliação periódica continua útil, mas não substitui a garantia no commit exigida pela seção 5.9.

Implementação, se futuramente aprovada, exige migration nova, prova/revisão do desenho e plano de reversão compatível com dados existentes. Não arquivar/apagar lançamentos ou desativar triggers para obter números melhores.

## Prioridade 3 — coleta de métricas, somente após atribuição

O 002 não justifica cache imediato. Primeiro medir fontes separadamente, amostras suficientes e pools/CPU, mantendo os indicadores duráveis. Se o custo for relevante, comparar coalescência de coletas e snapshot com validade declarada, ou separação da coleta global dos counters locais, fora da transação financeira.

**Aceite futuro:** idade da amostra explícita, primeira coleta/reinício corretos, falha DB/SQS sinalizada, última amostra preservada sem mascarar indisponibilidade e sem somar gauges globais duplicados entre instâncias. Não introduzir uma linha global transacional de contadores que serialize todas as wallets. Não perder os counters por processo apenas para consultar um único alvo global.

## Itens que não entram como correção imediata

- Particionamento: não resolve por si só o histórico de uma wallet e exige redesenhar unicidade/FKs. Manter condicionado à evidência e à preservação das identidades financeiras.
- Exactly-once no broker: continua fora da promessa; preservar inbox/outbox e deduplicação downstream, conforme enunciado.
- OTel/dashboard e IdP: permanecem fora da implementação atual. Novas ferramentas não eliminam o custo observado.
- Alterar fsync, reduzir constraints, remover locks ou publicar durante a transação: não são atalhos aceitáveis para esta proposta.

## Sequência de decisão

1. Revisar as evidências e definir o perfil/SLO de interesse; não há meta obrigatória de RPS no desafio.
2. Concluir atribuição do custo e testar o índice isoladamente, se justificado.
3. Somente se necessário, desenhar/revisar a validação incremental ou a redução de verificações repetidas no banco.
4. Tratar coleta conforme custo comprovado, sem perder observabilidade obrigatória.
5. Submeter uma alteração de cada vez à regressão financeira e ao experimento comparável, guardando cada RESULTS com novo número.

Este documento não executa essas propostas. Não foi criada migration, índice ou otimização de produção. A [documentação de EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html) reforça a distinção entre planos/custos locais e o tempo total percebido pela aplicação; os limites dos experimentos permanecem parte da análise.

# Arquitetura — Backend Ballance

Implementação do [desafio](docs/CHALLENGE.md) em Bun/TypeScript strict, NestJS, PostgreSQL, MikroORM e SQS via LocalStack. API e worker são processos separados, compartilhando casos de uso e banco. O worker executa consumer, publisher e scheduler. Veja [decisões](docs/DECISIONS.md).

## Domínio e dinheiro

`src/domain` não depende de NestJS/ORM. Construtores privados e factories controlam criação e reconstrução. `rehydrate` recupera estado salvo sem reaplicar movimentos. Money usa decimal.js, entrada/saída string e operações exatas. PostgreSQL numeric sem typmod, CHECK de escala e limite rejeitam excesso de casas sem arredondamento. Nunca se converte dinheiro para number. Ledger é imutável; a carteira controla débito/crédito e versão.

Inbox e outbox usam registros persistentes, operações da sessão transacional e stores especializados; não há classes de domínio dedicadas `InboxMessage`/`OutboxMessage`. Unicidade, identidade e transições persistidas são protegidas pelo SQL; claims e leases são coordenados pelos stores. Essa adaptação preserva as garantias operacionais testadas, mas distribui a leitura dessas regras entre aplicação e persistência, em vez de uniformizar todas as entidades em factories de domínio.

Abertura positiva cria OPENING interno e crédito; abertura zero não cria lançamento. A versão inicia em 1 e aumenta somente com mudança de saldo. LOSS, rejeição e replay não alteram saldo/versão. [Schema](docs/FINANCIAL_SCHEMA.md).

## Atomicidade, concorrência e replay

READ COMMITTED com SELECT FOR UPDATE por carteira serializa operações da mesma wallet entre processos. Carteiras distintas avançam em paralelo; não há lock global. Hot wallets têm paralelismo limitado pela serialização. Conflitos recuperáveis repetem a transação completa após rollback, com limite e backoff.

Saldo, transação, ledger, inbox quando aplicável, resposta original e outbox confirmam juntos. Nenhuma chamada SQS ocorre durante a transação financeira. UNIQUE protege jogador/moeda, chave idempotente global e identidade provider/external. CHECKs, FKs e triggers diferidos verificam aritmética, saldo total, cadeia de lançamentos, referências e versões. Runtime restrito não pode alterar/excluir ledger nem executar DDL. Um administrador do banco continua sendo uma fronteira operacional.

Replays devolvem o resultado histórico persistido, mesmo depois de outras operações. Hash financeiro SHA-256 de JSON canônico não inclui a chave nem metadados de transporte. Hash da inbox protege o envelope recebido. [Processamento](docs/FINANCIAL_PROCESSING.md) e [eventos/hash](docs/EVENTS_AND_HASH.md).

## ORM, Money e estratégia transacional

**Escolha do ORM.** MikroORM 6.6.17, a opção preferencial do enunciado. Razões: Unit of Work e Identity Map explícitos, `EntityManager.fork().transactional()` com nível de isolamento declarado, `LockMode.PESSIMISTIC_WRITE` para o lock da wallet e Migrator com `up`/`down` versionados e reversíveis. O adaptador usa `allowGlobalContext: false`: cada tentativa cria seu próprio `EntityManager`, de modo que nenhum Identity Map é compartilhado entre requisições (`src/infrastructure/persistence/mikro-financial-unit-of-work.ts`). TypeORM era aceito, mas oferece esses controles de forma menos explícita para o padrão adotado; Prisma está fora do escopo. A comparação é uma justificativa de projeto, não uma medição entre os dois ORMs.

**Mapeamento do Money.** O domínio não conhece o ORM. Na persistência, `money-mapper.ts` converte entre `Money` e string; o tipo da coluna é `numeric` e o valor nunca passa por `number`. O schema aplica CHECK de escala <= 2 e limite máximo; excesso de casas é rejeitado em vez de arredondado. Moeda fica em coluna própria, reidratada junto com o valor.

**Estratégia transacional.** READ COMMITTED com `SELECT ... FOR UPDATE` na wallet (lock pessimista), `lock_timeout` de 5s e repetição limitada da transação completa para conflitos recuperáveis. A unidade de concorrência é a wallet; os demais invariantes ficam no banco (UNIQUE, CHECK e triggers). Alternativas descartadas: locking otimista com retry ou update condicionado, válidos, mas com mais tratamento de conflito sob disputa na mesma wallet. Detalhes e custo em [DECISIONS.md](docs/DECISIONS.md).

## Mensageria e recuperação

As entradas HTTP e SQS reutilizam o mesmo caso de uso. Ack após commit; rejeições auditadas recebem ack; falhas transitórias permitem redelivery; inválidos/esgotados vão para DLQ antes de remover a origem. Inbox é persistente por consumidor/messageId.

Publisher reserva outbox com SKIP LOCKED e lease/token, publica fora da transação financeira e só marca após confirmação. Queda após envio pode duplicar o mesmo eventId; consumidores downstream devem deduplicar. Não há promessa de exactly-once nem ordenação de publicação por versão da wallet entre publishers. [Mensageria](docs/MESSAGING.md).

Referências fora de ordem ficam PENDING_REFERENCE e são retomadas por scheduler com claims persistentes, backoff/jitter e TTL de 24 horas. Expiração gera rejeição auditada. Reversões integrais são únicas por referência/tipo; REFUND e ROLLBACK da mesma referência podem coexistir conforme interpretação do enunciado. [Scheduler](docs/REFERENCE_SCHEDULER.md).

## HTTP e observabilidade

Controllers delegam ao domínio/aplicação. Consultas incluem cursor de ledger e reconciliação em snapshot REPEATABLE READ; divergência é sinalizada, nunca reparada silenciosamente. Logs JSON não incluem credenciais/payload financeiro completo. Métricas Prometheus, liveness e readiness existem na API e no worker. Counters são locais ao processo; gauges globais DB/SQS não devem ser somados entre réplicas. [HTTP](docs/HTTP_API.md) e [observabilidade](docs/OBSERVABILITY.md).

## Entrega e limites

Dockerfile multi-stage, dependências exatas/bun.lock e imagens por digest. Provisionador administrativo separado aplica migrations e grants; API/worker recebem login restrito. PostgreSQL persiste em volume. Esta configuração não comprova durabilidade de mensagens após recriar LocalStack. Migrations publicadas não devem ser reescritas.

Os testes usam PostgreSQL/SQS reais e schemas/filas exclusivos, incluindo SQL adversarial, cinquenta repetições, três processos independentes e crashes em janelas controladas. O Compose de testes possui infraestrutura própria, sem portas do host e sem o volume da demonstração.

Autenticação IdP está [somente documentada](docs/AUTHENTICATION.md), conforme permitido pelo desafio. O modo local é explícito e recusado para API financeira em NODE_ENV=production. Não há JWT/OIDC nem OpenTelemetry implementados.

Esta entrega inclui **Swagger local**, **painel de relatórios de carga** e runner exploratório, com scripts e instruções no [README](README.md). O painel apresenta dados históricos/importados com filtros e gráficos; não é monitoramento operacional ao vivo. [Resultados históricos](docs/LOAD_RESULTS_INDEX.md), [comparativo recebido da VPS](docs/benchmarks/summary-volume-vps.json) e [validação desta entrega](docs/VALIDACAO_CANDIDATA.md) identificam seus próprios ambientes. A versão essencial anterior não incluía esses recursos; essa descrição histórica não define o conteúdo deste repositório.

As verificações SQL percorrem o histórico: há custo crescente por carteira e maior duração da transação sob lock. Adicionar instâncias não elimina a serialização da mesma wallet nem esse custo. As medições exploratórias não estabelecem capacidade de produção, saturação ou número de usuários suportados. O [plano de melhorias](docs/LOAD_IMPROVEMENT_PLAN.md) é uma proposta, sem otimizações de índices/triggers aplicadas por esta revisão.

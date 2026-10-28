# Arquitetura — Backend Ballance

Implementação do [desafio](docs/CHALLENGE.md) em Bun/TypeScript strict, NestJS, PostgreSQL, MikroORM e SQS via LocalStack. API e worker são processos separados, compartilhando casos de uso e banco. O worker executa consumer, publisher e scheduler. Veja [decisões](docs/DECISIONS.md).

## Domínio e dinheiro

`src/domain` não depende de NestJS/ORM. Construtores privados e factories controlam criação e reconstrução. `rehydrate` recupera estado salvo sem reaplicar movimentos. Money usa decimal.js, entrada/saída string e operações exatas. PostgreSQL numeric sem typmod, CHECK de escala e limite rejeitam excesso de casas sem arredondamento. Nunca se converte dinheiro para number. Ledger é imutável; a carteira controla débito/crédito e versão.

Abertura positiva cria OPENING interno e crédito; abertura zero não cria lançamento. A versão inicia em 1 e aumenta somente com mudança de saldo. LOSS, rejeição e replay não alteram saldo/versão. [Schema](docs/FINANCIAL_SCHEMA.md).

## Atomicidade, concorrência e replay

READ COMMITTED com SELECT FOR UPDATE por carteira serializa operações da mesma wallet entre processos. Carteiras distintas avançam em paralelo; não há lock global. Hot wallets têm paralelismo limitado pela serialização. Conflitos recuperáveis repetem a transação completa após rollback, com limite e backoff.

Saldo, transação, ledger, inbox quando aplicável, resposta original e outbox confirmam juntos. Nenhuma chamada SQS ocorre durante a transação financeira. UNIQUE protege jogador/moeda, chave idempotente global e identidade provider/external. CHECKs, FKs e triggers diferidos verificam aritmética, saldo total, cadeia de lançamentos, referências e versões. Runtime restrito não pode alterar/excluir ledger nem executar DDL. Um administrador do banco continua sendo uma fronteira operacional.

Replays devolvem o resultado histórico persistido, mesmo depois de outras operações. Hash financeiro SHA-256 de JSON canônico não inclui a chave nem metadados de transporte. Hash da inbox protege o envelope recebido. [Processamento](docs/FINANCIAL_PROCESSING.md) e [eventos/hash](docs/EVENTS_AND_HASH.md).

## Mensageria e recuperação

Consumer HTTP/SQS reutiliza o mesmo caso de uso. Ack após commit; rejeições auditadas recebem ack; falhas transitórias permitem redelivery; inválidos/esgotados vão para DLQ antes de remover a origem. Inbox é persistente por consumidor/messageId.

Publisher reserva outbox com SKIP LOCKED e lease/token, publica fora da transação financeira e só marca após confirmação. Queda após envio pode duplicar o mesmo eventId; consumidores downstream devem deduplicar. Não há promessa de exactly-once nem ordenação de publicação por versão da wallet entre publishers. [Mensageria](docs/MESSAGING.md).

Referências fora de ordem ficam PENDING_REFERENCE e são retomadas por scheduler com claims persistentes, backoff/jitter e TTL de 24 horas. Expiração gera rejeição auditada. Reversões integrais são únicas por referência/tipo; REFUND e ROLLBACK da mesma referência podem coexistir conforme interpretação do enunciado. [Scheduler](docs/REFERENCE_SCHEDULER.md).

## HTTP e observabilidade

Controllers delegam ao domínio/aplicação. Consultas incluem cursor de ledger e reconciliação em snapshot REPEATABLE READ; divergência é sinalizada, nunca reparada silenciosamente. Logs JSON não incluem credenciais/payload financeiro completo. Métricas Prometheus, liveness e readiness existem na API e no worker. Counters são locais ao processo; gauges globais DB/SQS não devem ser somados entre réplicas. [HTTP](docs/HTTP_API.md) e [observabilidade](docs/OBSERVABILITY.md).

## Entrega e limites

Dockerfile multi-stage, dependências exatas/bun.lock e imagens por digest. Provisionador administrativo separado aplica migrations e grants; API/worker recebem login restrito. PostgreSQL persiste em volume. Esta configuração não comprova durabilidade de mensagens após recriar LocalStack. Migrations publicadas não devem ser reescritas.

Os testes usam PostgreSQL/SQS reais e schemas/filas exclusivos, incluindo SQL adversarial, cinquenta repetições, três processos independentes e crashes em janelas controladas. O Compose de testes possui infraestrutura própria, sem portas do host e sem o volume da demonstração.

Autenticação IdP está [somente documentada](docs/AUTHENTICATION.md), conforme permitido pelo desafio. O modo local é explícito e recusado para API financeira em NODE_ENV=production. Não há JWT/OIDC implementado, OTel ou dashboard. As verificações SQL percorrem o histórico: há custo crescente por carteira; não se anuncia capacidade de produção. Benchmarks exploratórios e planos internos ficam no repositório de desenvolvimento e não integram este pacote essencial.

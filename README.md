# Backend Ballance — Jungle Gaming

Processador distribuído de apostas com Bun 1.4.4, TypeScript, NestJS, PostgreSQL, MikroORM e SQS via LocalStack. Implementa saldo e ledger auditáveis, idempotência persistente, inbox/outbox e concorrência entre processos.

## Executar

Requisitos: Docker Engine com Docker Compose, containers Linux e internet no primeiro build. Bun/Node não são necessários no host. No Windows, use WSL. O banco de demonstração começa vazio.

```bash
git clone https://github.com/harlemsilvas/backend-ballance-jungle.git
cd backend-ballance-jungle

# Gera .env privado com senha aleatória; não sobrescreve arquivo existente.
sh entrega.sh init
sh entrega.sh up
sh entrega.sh smoke
```

API: http://localhost:3000. Readiness: http://localhost:3000/health/ready. Métricas: http://localhost:3000/metrics e http://localhost:9101/metrics.

O provisionamento aplica migrations e cria um login restrito para API/worker. As imagens têm versões e digests fixados. Se alguma porta estiver ocupada, configure `PORT`, `WORKER_METRICS_PORT`, `POSTGRES_PORT` e `LOCALSTACK_PORT` no `.env`, conforme [.env.example](.env.example). Guarde o `.env` para reutilizar o mesmo banco.

## Testes

```bash
# TypeScript, build, unidade e integração com PostgreSQL/SQS reais.
sh entrega.sh test

# Verificação do fluxo completo na aplicação em execução.
sh entrega.sh smoke
```

A suíte usa infraestrutura e volume próprios. Inclui idempotência com 50 envios paralelos, disputa de saldo, três processos, inbox/redelivery, recuperação após falha e publishers concorrentes. [Resultados e ambiente da validação](docs/VALIDACAO_CANDIDATA.md).

## Swagger e relatórios opcionais

```bash
sh swagger.sh up             # API com Swagger: http://localhost:3000/docs
sh experimento.sh dashboard  # Painel: http://localhost:38080
```

O Swagger permite chamadas reais à API. `sh swagger.sh off` restaura a API sem Swagger. O painel contém relatórios históricos, filtros, gráficos, importação JSON e exportação CSV; não é monitoramento ao vivo. O comparativo recebido da VPS está em [summary-volume-vps.json](docs/benchmarks/summary-volume-vps.json): importe-o pelo botão do painel.

**Carga — caminho recomendado para avaliação:** execute na raiz do repositório pelos scripts Docker abaixo. Eles iniciam PostgreSQL/SQS isolados, instalam as dependências na imagem e executam o runner Bun dentro do container. Não exigem Bun no host nem a API de demonstração em execução.

| Comando | Finalidade |
| --- | --- |
| `sh experimento.sh load` | Verificação curta: histórico 20, 24 comandos por cenário. |
| `sh experimento.sh load3000` | Perfil focado: histórico 3.000 por carteira, 120 comandos por cenário. |
| `sh experimento.sh load-volume` | Comparativo 100/1.000/3.000 por carteira, 120 comandos por cenário e duas repetições. |

Para uma primeira conferência, use `sh experimento.sh load`. Cada execução salva arquivos em `load-results/run-UUID/`; após sucesso, importe seu `summary.json` no painel. A população dos perfis maiores pode levar minutos. Não execute cargas simultâneas no mesmo projeto.

**Execução direta com Bun:** `bun run test:load`, `bun run test:load3000` e `bun run test:load:volume` existem, mas **não iniciam PostgreSQL/SQS nem instalam dependências**. Exigem Bun 1.4.4, `bun install --frozen-lockfile`, infraestrutura isolada e variáveis de conexão/`LOAD_CONFIRM=isolated`, conforme [preparação detalhada](docs/LOAD_TESTS.md#preparação-e-execução). O `.env` da aplicação não substitui essa preparação. Para apenas consultar o perfil sem executar carga, use `bun run test:load3000 --describe` (com Bun instalado).

## Operação e limites

```bash
sh entrega.sh status
sh entrega.sh logs
sh entrega.sh stop       # Preserva o banco.
sh experimento.sh stop   # Encerra painel/infraestrutura de carga.
```

As portas são publicadas apenas em localhost. Em uma VPS, acesse pela sua máquina com túnel SSH:

```bash
ssh -L 3000:127.0.0.1:3000 -L 38080:127.0.0.1:38080 usuario@IP_DA_VPS
```

A autenticação está **documentada como proposta**, conforme permitido no desafio; JWT/OIDC não foi implementado. O modo local é explícito e recusado em produção. Use dados sintéticos. `.env` não é versionado; credenciais administrativas de desenvolvimento são locais e estão explícitas no Compose.

Saldo, ledger, transação, inbox e outbox confirmam atomicamente. O banco garante idempotência e locks por wallet; o broker pode entregar duplicatas. Consumidores downstream devem deduplicar por `eventId`. O PostgreSQL persiste em volume; esta configuração não promete persistência das filas após recriar o LocalStack. Os testes de carga não estabelecem capacidade de produção nem número de usuários simultâneos.

## Documentação

- [Enunciado](docs/CHALLENGE.md) e [arquitetura, decisões e trade-offs](ARCHITECTURE.md).
- [Decisões de negócio](docs/DECISIONS.md), [contratos/failureCode](docs/CONTRACTS.md) e [API HTTP](docs/HTTP_API.md).
- [Mensageria](docs/MESSAGING.md), [observabilidade](docs/OBSERVABILITY.md) e [autenticação proposta](docs/AUTHENTICATION.md).
- [Validação da entrega](docs/VALIDACAO_CANDIDATA.md), [estratégia de testes](docs/TEST_STRATEGY.md) e [relatórios de carga](docs/LOAD_RESULTS_INDEX.md).

Código sob [licença MIT](LICENSE). O enunciado preservado pertence aos seus respectivos autores. [Política de segurança](SECURITY.md).

# Validação da entrega — 28/10/2026

Esta entrega foi validada localmente em containers Linux antes da publicação. Os resultados abaixo pertencem à pasta preparada para o repositório backend-ballance-jungle. Os relatórios históricos de carga identificam seus próprios ambientes.

## Ambiente

- Docker Engine 29.9.2 e Docker Compose v5.6.1.
- Bun 1.4.4 na imagem fixada por digest; PostgreSQL 17.6 e LocalStack 4.8.1.
- Projeto de testes `ballance-avaliacao-testes`, sem portas no host.
- Demonstração `ballance-avaliacao`, volume novo e login restrito.
- Portas locais de validação: API 33000, worker 39101, PostgreSQL 35546, SQS 34567 e painel 38081. Os defaults da entrega são 3000/9101/5546/4567/38080.
- Buildx ausente neste host: o fallback automático para builder clássico concluiu os builds.

## Comandos e resultados

| Comando/verificação | Resultado observado |
| --- | --- |
| `DELIVERY_TEST_PROJECT=ballance-avaliacao-testes sh entrega.sh test` | Exit 0; typecheck/build aprovados; **215 testes, 0 falhas, 857 assertions, 21 arquivos**; execução dos testes em 45,66s, sem contar provisionamento/build. |
| `DELIVERY_PROJECT=ballance-avaliacao sh entrega.sh init` | Exit 0; .env privado criado com senha aleatória, fora do Git. |
| `DELIVERY_PROJECT=ballance-avaliacao sh entrega.sh up` | Exit 0; migrations/provisionamento concluídos, API/worker saudáveis. |
| `DELIVERY_PROJECT=ballance-avaliacao sh entrega.sh smoke` | Exit 0; evento final `DeliverySmokePassed`. |
| `EXPERIMENT_PROJECT=ballance-avaliacao-carga REPORT_PORT=38081 sh experimento.sh dashboard` | Exit 0; painel saudável e GET / com HTTP 200. |
| `DELIVERY_PROJECT=ballance-avaliacao sh swagger.sh up` | Exit 0; API saudável; /docs e /openapi.json com HTTP 200, dez paths no contrato OpenAPI. |
| Readiness API/worker | Ambos HTTP 200. |

A suíte cobre PostgreSQL e SQS reais no emulador, constraints SQL, concorrência entre processos, atomicidade, replay, inbox/outbox, recuperação e controles do runner. O smoke submete comandos e confere o fluxo da aplicação. Esta é uma síntese das saídas efetivamente observadas, não uma gravação de vídeo. O avaliador pode reproduzir tudo pelo README.

## Evidência de carga recebida da VPS

[JSON original](benchmarks/summary-volume-vps.json) preservado sem alterações. Configuração registrada: uma CPU lógica disponível, aproximadamente 4 GB de memória informados pelo sistema, históricos 100/1.000/3.000, hot/HTTP, 120 comandos por cenário, três processos, concorrência seis, coleta off/5s e duas repetições em ordem inversa.

A conferência encontrou 12 cenários e 1.440 comandos processados, zero erros técnicos e rejeições; todos os audits indicam consistência e replay. Esta evidência foi recebida da VPS e não reproduzida nesta validação local. Os hashes de origem e ambiente estão no próprio JSON. Uma tentativa posterior sem summary.json não foi consolidada. O painel importa esse arquivo pelo botão de seleção.

Histórico de 3.000 lançamentos não significa 3.000 usuários. Não há conclusão de capacidade de produção nem comparação causal entre hosts diferentes. Método, métricas e limitações adicionais estão em [LOAD_TESTS.md](LOAD_TESTS.md).

## Configuração e reprodução

O repositório inclui .env.example; `sh entrega.sh init` gera a senha local. O .env e os volumes não são distribuídos. Para repetir em um host com serviços existentes, use nomes de projeto exclusivos e portas livres. Testes e demonstração têm volumes separados; não é necessário remover volumes.

Não há autenticação JWT/OIDC implementada; a proposta está documentada conforme a alternativa prevista no desafio. Swagger e painel são opcionais, restritos ao localhost. Os resultados desta validação não equivalem a uma auditoria de segurança ou garantia de produção.

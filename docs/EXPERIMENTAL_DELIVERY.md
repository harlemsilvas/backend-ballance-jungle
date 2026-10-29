# Entrega experimental: carga e painel de relatórios

> **Registro histórico.** Este documento descreve o processo que originou esta edição no repositório de desenvolvimento. Comandos como `python3 scripts/package-delivery.py --experimental` e a pasta `entrega_teste/` não existem neste repositório; aqui, os scripts `entrega.sh`, `experimento.sh` e `swagger.sh` ficam na raiz e os comandos de uso estão no [README](../README.md).

Edição de 28/10/2026, validada localmente a partir de ZIP extraído em diretório temporário, sem montar os fontes do desenvolvimento nos containers. O pacote essencial `entrega.zip` permanece preservado.

## Gerar e executar

`python3 scripts/package-delivery.py --experimental` cria `entrega_teste/` e `entrega_teste.zip` e recusa sobrescrever edições existentes. O destinatário segue o README do ZIP; precisa de Docker/Compose e internet inicial, sem Bun/Node/Python/Git no host.

Na pasta extraída:

```sh
sh experimento.sh dashboard
sh entrega.sh test
sh experimento.sh load
```

Painel: **http://127.0.0.1:38080**. Também é possível abrir `reports/dashboard.html` sem servidor. O painel é uma visualização de relatórios experimentais, não Grafana, OpenTelemetry ou monitoramento operacional ao vivo. Para encerrar: `sh experimento.sh stop`.

## O que foi acrescentado

- Runner de carga e dois controles de integração incluídos na edição experimental, com método/relatórios/fontes históricas.
- Painel local independente do banco, com gráficos por cenário, filtros, busca, tabela, detalhes de ambiente/tentativas incompletas e exportação CSV.
- Importação local de `summary.json` ou `results-NNN.json`, sem enviar arquivo ao servidor. Atualizar a página restaura a edição distribuída.
- Projeto de carga próprio, banco/fila sem portas do host, resultado novo por UUID e perfil curto padrão. Carga/visualização não alteram o runtime financeiro.
- Ausência de Git tratada no runner: `gitHead`/`worktreeDirty` ficam nulos, sem inventar revisão/estado limpo. Hashes dos arquivos continuam presentes.
- Quatro testes do modelo do painel verificam percentis por cenário, filtros, dados incompletos e medidas desconhecidas.

Domínio, casos de uso, schema, migrations, dependências, lockfile e Compose de produção não foram alterados. Os templates de empacotamento acrescentam apenas a infraestrutura experimental e uma tag de imagem própria.

## Validações executadas

- Typecheck/build aprovados no container extraído.
- Suíte completa experimental: **209 testes, zero falhas, 830 assertions, 19 arquivos**, em 63,55s na primeira execução completa. Inclui SQL adversarial, replay, três processos, crashes e controles de limpeza do runner. Duração não representa tempo total de download/build.
- Perfil HTTP padrão: histórico 20, 24 comandos/caso, duas repetições, off/5s; quatro cenários, **96 comandos medidos**, zero erros técnicos, auditoria consistente, replay verdadeiro e zero outbox pendente após drenagem.
- Perfil SQS adicional: histórico 5, 12 comandos/caso, uma repetição, off/1s; dois cenários, **24 comandos medidos**, com conclusão do runner e auditoria final. Não é uma nova medição de capacidade nem reprodução das matrizes históricas.
- Chrome headless: 48 linhas históricas renderizadas; filtro HTTP/hot/histórico 1.000 retorna seis cenários; 003 mostra zero janelas e a população parcial de 7.977; importação do summary HTTP acrescenta quatro cenários; CSV exporta as 52 linhas selecionadas. Testado também health HTTP e recusa de servir caminhos como `.env` ou arquivos do repositório.
- ZIP extraído com manifesto conferido. O `entrega.zip` original foi comparado por SHA-256, sem alteração.

Na montagem final foram completadas colunas de lock/retries/conflitos/lag/auditoria e repetidas as verificações no Chrome, os quatro testes unitários do painel e typecheck. A suíte completa não foi repetida depois desse ajuste exclusivamente de visualização; o código financeiro permaneceu igual. Nenhuma carga é disparada automaticamente ao abrir relatórios. Resultados novos ficam em diretório de validação, fora do ZIP distribuído.

## Limites e interpretação

O painel vem com 002, 003 e 004; o piloto 001 permanece nos documentos/JSON para consulta/importação. HTTP/SQS medem caminhos distintos; gráficos não combinam percentis ou escondem a variação entre repetições. A carga curta valida instalação, geração e leitura de arquivos; não determina usuários suportados. O experimento histórico 003 não chegou à janela de 10.000 entradas.

O lag apresentado é snapshot final, não pico durante toda a janela. Contador zero de conflitos não significa zero espera. Git sem metadados não torna um experimento idêntico a outro: compare hashes/configuração. A topologia do runner tem finalidade de experimento e difere da separação API/worker da entrega operacional.

Não houve deploy, push ou substituição do pacote essencial. A incorporação à entrega definitiva continua sendo uma decisão posterior sobre um artefato concreto e testado.


## Sessão local com Swagger e rodada 004 — 28/10/2026

A pedido do usuário, API/worker foram iniciados localmente em `ballance-experimental`; o Swagger é um bootstrap opcional em imagem própria, sem modificar os controllers ou o entrypoint de produção. Swagger UI 5.34.0 tem package/lockfile separados; instalação congelada sem scripts de instalação. [Guia local](SWAGGER_LOCAL.md). O contrato OpenAPI é manual; não há geração automática de schemas NestJS.

Rodada [004](LOAD_RESULTS_004.md) concluída com 16 cenários, 1.920 operações medidas, HTTP/SQS, histórico inicial 100, hot/spread com uma/três wallets, três processos, concorrência seis, duas repetições e coleta off/5s. Zero erros técnicos, rejeições inesperadas, retries ou conflitos SQL registrados; auditorias e replay consistentes. Fonte da medição preservada em sources-004.tar.gz antes de mudar o Dockerfile para Swagger. O runner não exerce a instância Swagger; usa suas próprias APIs/filas/banco no mesmo host.

Swagger validado por HTTP e Chrome: dez caminhos, Try it out em health/live, criação de carteira, BET, replay, conflito 409 e reconciliação. A recusa do modo em produção tem teste próprio. O painel incorpora os 16 cenários novos sem substituir os históricos e não usa o resultado como estimativa universal de usuários.

Regressão após adicionar Swagger local: **212 testes aprovados, zero falhas, 844 assertions em 20 arquivos**, com typecheck/build, em 46,15s na suíte. É evidência funcional da edição; não mede desempenho do Swagger nem capacidade da aplicação.


## Perfis de comparação de volume — configuração preparada

Adicionados `test:load3000` e `test:load:volume`, com equivalentes Docker `experimento.sh load3000`/`load-volume`. O comparativo usa históricos 100/1.000/3.000 no mesmo protocolo (hot/HTTP, 120 comandos, três processos, concorrência seis, duas repetições, off/5s), com orçamento de população por caso de 180s. `--describe` não abre recursos. Testes verificam conflitos de histórico, orçamento obrigatório e defaults, sem alterar dinheiro/locks/constraints.

Ainda não foi executada a matriz com 3.000; não há resultados desse volume no painel ou nova rodada 005. O teste funcional de cinquenta repetições é outro conceito. README oficial e experimental incluem os comandos, limitações e recomendação de executar comparativos antes da apresentação. O ZIP essencial continua preservado.

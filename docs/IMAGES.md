# Imagens fixadas e manutenção

Verificação no registry oficial Docker Hub em 26/10/2026. Mantidas as versões nominais da entrega; o conteúdo de origem é agora selecionado por tag + digest. Dockerfile usa o mesmo índice Bun nos dois estágios; compose.yaml fixa PostgreSQL e LocalStack. O overlay reutiliza a imagem da aplicação construída localmente.

| Origem | Digest do índice/manifest list |
|---|---|
| docker.io/library/postgres:17.6-alpine | sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94 |
| docker.io/localstack/localstack:4.8.1 | sha256:8c9756bddc44625cd6e890f5e4bcc29b045eebe108b268482b848f4f832ec153 |
| docker.io/oven/bun:1.4.4 | sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d |

Os digests representam índices multiplataforma, não um único manifesto de arquitetura. PostgreSQL e Bun usam OCI image index; LocalStack usa Docker manifest list v2. Todos contêm entradas linux/amd64 e linux/arm64. Entradas unknown/unknown de atestação não são plataformas executáveis. A validação operacional deste projeto cobre **linux/amd64**, neste host x86_64; a presença de manifesto arm64 não constitui teste da aplicação nessa plataforma.

A resolução consultou auth.docker.io/registry-1.docker.io com autorização pública de pull e tipos de manifesto explícitos. O SHA-256 dos bytes retornados foi calculado e conferido contra Docker-Content-Digest. Essa verificação confirma integridade do conteúdo obtido; não equivale a validar uma assinatura do publicador ou a atestar ausência de vulnerabilidades.

## Como atualizar

1. Escolher a versão ou atualização de conteúdo e consultar o índice no registry oficial. Conferir repositório, versão e plataformas; calcular/conferir o digest do manifesto retornado. Não copiar o ID local da imagem como se fosse digest do índice.
2. Comparar o novo índice com esta tabela, conferir release notes/correções e revisar o impacto. Mesmo mantendo a tag, um digest diferente pode mudar dependências da imagem.
3. Atualizar os dois FROM do Dockerfile para o mesmo Bun e as referências PostgreSQL/LocalStack em compose.yaml. Atualizar esta tabela e a data da consulta na mesma mudança. Alterações de versão devem também atualizar a stack descrita no README e validar compatibilidade.
4. Resolver/puxar as referências fixadas e construir a aplicação. Validar Compose, build, suíte de integração/unidade e smoke de entrega em outro projeto Compose com portas/volume exclusivos. Conferir as referências dos containers e a plataforma executada. ARM64 requer validação própria antes de ser anunciado como suportado operacionalmente.
5. Testar health, HTTP/SQS, replay, publicação, reconciliação, métricas e shutdown. Registrar resultados em DELIVERY/PROJECT_STATUS e revisar antes de publicar a atualização. Não recriar o ambiente de desenvolvimento nem remover volumes para executar essa verificação.

A [documentação oficial do Docker](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions) explica que tags podem mudar e que digest fixa conteúdo. A contrapartida é que correções upstream deixam de entrar automaticamente: é necessário revisar periodicamente avisos de segurança e propor atualizações explícitas. Não foi configurado robô de atualização nem scanner de vulnerabilidades neste pacote.

O build da aplicação continua dependendo de package.json/bun.lock e da disponibilidade dos registries; pinning das imagens não promete build binariamente idêntico, operação offline ou durabilidade das filas locais. [Setup e limites](../README.md) e [registro de validação](VALIDACAO_CANDIDATA.md).

# Política de segurança

Backend Ballance é uma entrega de desafio técnico para demonstração local. Relatos sobre o código atual da branch `main` podem ser enviados pelo canal abaixo. Não há compromisso de suporte a versões anteriores, prazo de resposta ou correção.

## Reportar uma vulnerabilidade

Use o [formulário privado de vulnerabilidades do GitHub](https://github.com/harlemsilvas/backend-ballance-jungle/security/advisories/new), disponível em **Security → Advisories → Report a vulnerability**. Não abra uma issue pública com detalhes exploráveis.

Inclua o commit afetado, componente, impacto esperado e passos mínimos para reprodução com dados sintéticos. Não envie senhas, tokens, dados de jogadores ou payloads financeiros reais. Evite divulgar detalhes exploráveis antes de discutir o relato de forma privada com o mantenedor.

Problemas funcionais sem implicação de segurança podem ser reportados nas issues do repositório.

## Escopo e limites atuais

- Autenticação externa e autorização completa dos recursos estão somente [documentadas](docs/AUTHENTICATION.md); o modo local é explícito e não autentica usuários ou provedores. A API financeira recusa esse modo quando `NODE_ENV=production`.
- A configuração entregue publica portas apenas no localhost do host. Não exponha a demonstração diretamente à Internet nem a utilize para movimentações reais.
- Utilize somente dados sintéticos. Credenciais administrativas de desenvolvimento e credenciais sintéticas do LocalStack não servem para produção.
- Guarde a senha de runtime em arquivo privado ou mecanismo de segredos, fora do Git. Não registre tokens, credenciais ou payloads financeiros completos em logs ou relatos.
- Health permanece aberto conforme o desafio. Métricas e infraestrutura precisam de acesso restrito em uma implantação real.
- O desenho de autenticação futura não constitui controle implementado. Os testes financeiros e de recuperação não substituem uma avaliação de segurança ou um teste de carga.

O [README](README.md) descreve execução e limites; [ARCHITECTURE.md](ARCHITECTURE.md) registra decisões e extensões propostas.

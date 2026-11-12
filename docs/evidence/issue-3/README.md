# Issue #3 — abertura autenticada

Escopo: [Issue #3](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/3), a partir do merge do PR #15 (`2555e55`). Aplicadas as skills implement e tdd nas interfaces previamente aprovadas em `docs/testing-strategy.md`.

## Evidências

- R03/R04: testes públicos de Money, Wallet e JournalEntry — factories/rehydrate, precisão exata, limite/overflow, valores inválidos, incompatibilidade de moeda e aritmética do journal.
- R05/D01: HTTP real cria abertura positiva/zero com versão 1, consulta wallet/ledger e rejeita duplicação. SQL comprova saldo reconstruído 100.00 e uma outbox, par em contas distintas e mesma moeda.
- R15: schema rejeita saldo sem journal, valores inválidos e contas de outra moeda. UPDATE/DELETE/TRUNCATE do journal são bloqueados tanto para owner (trigger) quanto para runtime (permissões). Runtime não é dono, superuser, CREATEDB ou CREATEROLE e não pode desabilitar triggers.
- R16 (abertura): falhas em cada etapa SQL e falha provocada na gravação da outbox pelo HTTP real deixam zero efeitos parciais. Retry após remover a falha confirma abertura no limite monetário.
- D02 (wallet): Authorization Code + PKCE contra Keycloak real para três humanos; Client Credentials para dois provedores. Viewer/operator não criam, provedores não criam nem consultam wallet/ledger. Fixture criptográfica adicional na fronteira HTTP verifica assinatura, issuer, audience, expiração, claims obrigatórias e isolamento de cliente/providerId.
- D03 (console inicial): navegador real faz login PKCE S256, cria wallet 123.45, lê OPENING; outra sessão viewer consulta a mesma wallet e não oferece criação. Valores continuam strings; tokens não são persistidos no localStorage.
- R02: up/down até zero/up em banco descartável, incluindo a migration financeira.

Comandos e resultados finais serão registrados após a revisão. O teste de integração usa PostgreSQL 16.6, LocalStack 4.0.3 e Keycloak 26.0.7 reais. Os testes HTTP financeiros usam credenciais de runtime em bancos descartáveis; o harness usa a credencial administrativa somente para preparar e destruir fixtures.

## Console

Direção: Pastel consumer, seed 2000304083, Manrope, sem redraw. O saldo exato e sua linha de OPENING são a evidência central. O monograma e as strings monetárias identificam o produto; não há números fictícios de dashboard. As imagens abaixo mostram dados efetivamente criados no teste, em 1440, 768 e 390 px.

- [Desktop](console-1440.png)
- [Tablet](console-768.png)
- [Mobile](console-390.png)

Limites deste ticket: apenas OPENING e versão inicial; não há processamento de apostas, consumo/publicação da outbox, reconciliação, dashboard de métricas, carga ou hospedagem. A prova completa de R15/R16/D02/D03 depende também dos próximos tickets. Não há alegação de cumprir a spec inteira.

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

Validação final em 2026-11-12, Bun 1.3.14 e Chrome instalado no host:

```sh
bun run build
# Stack isolada, com volume criado do zero:
docker compose -p jungle-issue3-validation up -d --build --wait
# DATABASE_URL de runtime + MIGRATION_DATABASE_URL administrativa de .env.example:
INTEGRATION=1 BROWSER=1 CHROME_PATH=/usr/bin/google-chrome bun test
```

Resultado: **30 pass, 0 fail, 179 expect() calls, 12 arquivos, 16.31 s**. A stack ficou healthy após provision e migrations. O ambiente anterior foi parado durante a execução e seu volume foi preservado; somente o volume da stack descartável foi removido ao final. O teste de integração usa PostgreSQL 16.6, LocalStack 4.0.3 e Keycloak 26.0.7 reais. Os testes HTTP financeiros usam credenciais de runtime em bancos descartáveis; o harness usa a credencial administrativa somente para preparar e destruir fixtures.

## Console

Direção: Pastel consumer, seed 2000304083, Manrope, sem redraw. O saldo exato e sua linha de OPENING são a evidência central. O monograma e as strings monetárias identificam o produto; não há números fictícios de dashboard. As imagens abaixo mostram dados efetivamente criados no teste, em 1440, 768 e 390 px.

- [Desktop](console-1440.png)
- [Tablet](console-768.png)
- [Mobile](console-390.png)

Limites deste ticket: apenas OPENING e versão inicial; não há processamento de apostas, consumo/publicação da outbox, reconciliação, dashboard de métricas, carga ou hospedagem. A prova completa de R15/R16/D02/D03 depende também dos próximos tickets. Não há alegação de cumprir a spec inteira.

## Revisão

### Standards

0 violações documentais; 1 observação de manutenção, não bloqueante: `Wallets` concentra validação, SQL, serialização e paginação. Oportunidade de separar os adaptadores ao estender o módulo; a transação única e o domínio independente estão preservados.

### Spec

2 achados P2, ambos corrigidos com regressão: JSON malformado agora retorna `INVALID_PAYLOAD` e correlationId mesmo antes do controller; Money interno negativo agora permite rehydrate sem aceitar negativos no parser de submissões ou em wallets.

Total inicial: Standards 1 observação (sem severidade obrigatória), Spec 2 P2. Nenhum achado funcional permanece aberto.

### Inspeção visual

Inspector em página de entrada: 0 FAIL nos três tamanhos, 1 WARN por espaço livre em desktop antes do login. Snapshot HTML capturado do console autenticado real: 0 FAIL nos três tamanhos, 1 WARN por alturas distintas entre o formulário e o conjunto saldo/ledger; mantido porque são blocos de tarefas diferentes e esticá-los criaria espaço vazio artificial. Mantido porque a tela exige autenticação e não fabrica dados financeiros antes dela. Screenshots autenticados revisados nos três tamanhos; overflow móvel corrigido, tabela usa rolagem local. Critério visual: legibilidade 8/10, hierarquia 8/10, responsividade 8/10, identidade 7/10. Limite: o console inicial prioriza a tarefa e ainda não tem navegação para funcionalidades dos próximos tickets. Sem imagens geradas, fotografias ou dados de dashboard inventados.

CI: a primeira execução identificou que a versão de Compose do runner trata um serviço one-shot explicitamente selecionado em `up --wait` como falha, mesmo com exit 0. O workflow passou a aguardar apenas PostgreSQL/SQS/Keycloak e executar `provision` com `run --rm`, propagando seu exit code diretamente.

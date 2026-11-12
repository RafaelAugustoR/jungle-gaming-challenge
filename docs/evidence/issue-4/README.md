# Issue #4 — BET HTTP idempotente

Base: `51afc7587fce1701e512942cbb4d0cc06acaa73b`, merge do PR #16. Implementação e testes seguem `docs/spec.md`, ADRs 0003–0008, 0012, 0015/0016 e as interfaces aprovadas em `docs/testing-strategy.md`. [Ciclos TDD observados](tdd.md).

## Reprodução

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres sqs keycloak
docker compose run --rm provision
bun run build
docker compose up -d --build --wait api
INTEGRATION=1 BROWSER=1 CHROME_PATH=/usr/bin/google-chrome \
  BET_EVIDENCE_PATH=/tmp/bet-concurrency.json bun test
```

Chrome é opcional: com Chromium do Playwright instalado, omita `CHROME_PATH`. A suíte usa bancos descartáveis, runtime restrito, Keycloak e SQS reais; browser consulta a API do Compose. O harness de BET inicia três processos da implementação em teste, com IPC para readiness e encerramento, sem mocks de banco, saldo, autorização ou locks. `bun run test:concurrency` executa só esse recorte; `bun run test:integration` o inclui na CI.

## Cenários e rastreabilidade

| Requisito no recorte BET | Evidência executável                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R06, R08, R20            | Domínio `Wallet.debit` e `WagerTransaction`; HTTP para débito exato, zero, insuficiência, OPENING externo inválido, estados terminais, eventos tipados e versão.                                                                                   |
| R09, R10                 | HTTP com ordem de chaves diferente inclusive em Money, divergência, chave nova/mesma identidade externa, dois provedores; recibo original de 200/422 após débito posterior; reinício de processo.                                                  |
| R12, R13, R14            | `tests/concurrency/bet.test.ts`: 50 submissões divididas entre três PIDs; duas BET 80 sobre 100; outra wallet conclui enquanto a primeira está bloqueada no PostgreSQL.                                                                            |
| R16, D01                 | PostgreSQL: falha em transação, journal, atualização da wallet, recibo e evento de resultado (após evento de saldo); rollback integral e retry com a mesma chave. Constraints exigem recibo/evento no commit e preservam partidas dobradas/cadeia. |
| R21, D02                 | HTTP/Keycloak real: 401/403, binding de provedor, humanos sem submissão, consultas por ambos os IDs com ownership, inexistência/404, contratos monetários e campos desconhecidos.                                                                  |
| R02, R15                 | Baseline completo up/down/up e upgrade/down/up preservando OPENING anterior; imutabilidade e grants de runtime; verificação em UPDATE de transação.                                                                                                |

As barreiras esperam sessões dos PIDs em `pg_stat_activity.wait_event_type='Lock'` antes de liberar o lock controlado. O polling de condição tem prazo; nenhuma ordem de apostas depende de sleep arbitrário. Na prova de independência, o teste exige que B conclua antes da liberação de A. Corridas UNIQUE usam wallets distintas, cobrindo a resolução somente após rollback.

A auditoria pela interface SQL, aprovada para invariantes do schema, compara saldo armazenado à soma NUMERIC do journal e verifica contas distintas/valores positivos (uma linha é o par de partidas, sem lado isolado representável), transações, recibos e eventos únicos. HTTP verifica o saldo/versão observável. Abertura gera seu próprio evento de saldo, por isso uma abertura + BET gera dois `WalletBalanceChanged`.

## Resultados

Execução completa: **61 pass, 0 fail, 395 expect() calls, 16 arquivos, 19.52 s**. `bun run build` e `git diff --check` passaram. [Log completo](full-suite.txt); [resultados brutos dos três processos](concurrency.json).

- PIDs iniciais: **26210, 26231, 26273**; PID após reinício: **26307**.
- 50 submissões: **1 aceite + 49 replays**, **1 BET / 1 débito / 1 recibo / 1 evento de resultado**, saldo armazenado/reconstruído **20.00**, versão **2**.
- Disputa: status **200 e 422**, **2 BET / 1 débito / 2 recibos**, um evento de aprovação e outro de rejeição, saldo armazenado/reconstruído **20.00**, versão **2**.
- Independência: outra wallet concluiu com a primeira ainda bloqueada; ambas reconciliadas por SUM NUMERIC.
- Browser real: login PKCE, criação/consulta e permissões herdadas da #3 passaram com a API atual reconstruída no Compose.
- Schema: up/down/up completo e upgrade/down/up preservando abertura, imutabilidade, rejeição de escrita parcial e timeouts reais passaram.

O Docker Desktop apresentou um bind mount antigo em `provision`; recriar apenas esse container restabeleceu a execução. Nenhum volume foi apagado. [Revisão de padrões e spec](review.md) concluída: nenhum achado pendente após as correções, incluindo retry de statement_timeout com teste red/green em PostgreSQL real.

## Limites do recorte

BET apenas. WIN/LOSS/reversões/referências, consumo SQS/inbox, publisher/leases, reconciliação por endpoint e testes de carga ficam nos tickets seguintes. Asserções contábeis SQL aqui não representam a entrega desses endpoints ou workers. Não há publicação antecipada: este fluxo só insere outbox no commit financeiro. Eventos de resultado têm sequência persistente por wallet independente da versão do saldo.

Jogador/moeda incompatíveis são validações de contexto anteriores ao aceite e retornam 400 sem consumir a chave. Rejeição financeira por insuficiência é persistida e retorna 422. Consulta de outro provedor responde 404. Recibo 422 mantém correlationId do corpo; o header acompanha a tentativa atual.

Migration 0003 é incremental e não modifica 0002. Down recusa descartar identidades externas aceitas; validação reversível ocorre em banco descartável ou com apenas aberturas, cujo histórico é preservado.

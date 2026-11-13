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
mkdir -p artifacts/issue-4
INTEGRATION=1 BROWSER=1 CHROME_PATH=/usr/bin/google-chrome \
  BET_EVIDENCE_PATH=artifacts/issue-4/concurrency.json bun test 2>&1 | tee artifacts/issue-4/full-suite.txt
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

A revisão externa tem decisões e validação rastreadas em [review-follow-up.md](review-follow-up.md). Execução local final após as correções: **65 testes passaram, 0 falhas, 436 asserções, 21.03 s**, com build e formatação válidos. O diretório versionado mantém apenas metodologia, critérios e resultados resumidos.

Na [CI do PR #17](https://github.com/RafaelAugustoR/jungle-gaming-challenge/pull/17/checks), abra a execução de `verify`: o passo de integração imprime `BET_CONCURRENCY_EVIDENCE` com PIDs e auditoria em JSON. Os logs da execução podem ser baixados pelo GitHub; o passo de navegador preserva sua própria saída. A retenção segue a configuração do repositório. Os comandos acima regeneram os mesmos arquivos localmente em `artifacts/`, ignorado pelo Git. Nenhum token ou credencial é gravado no relatório.

Resultados obrigatórios: 50 submissões com 1 aceite/49 replays e um débito; duas BET de 80 com status 200/422 e saldo 20.00; outra wallet conclui enquanto a primeira permanece bloqueada; stored balance = SUM NUMERIC do journal e pares balanceados. Reinício preserva replay. Build, autenticação/PKCE, falhas atômicas, timeout/retry e migrations fazem parte da validação.

## Limites do recorte

BET apenas. WIN/LOSS/reversões/referências, consumo SQS/inbox, publisher/leases, reconciliação por endpoint e testes de carga ficam nos tickets seguintes. Asserções contábeis SQL aqui não representam a entrega desses endpoints ou workers. Não há publicação antecipada: este fluxo só insere outbox no commit financeiro. Eventos de resultado têm sequência persistente por wallet independente da versão do saldo.

Jogador/moeda incompatíveis são validações de contexto anteriores ao aceite e retornam 400 sem consumir a chave. Rejeição financeira por insuficiência é persistida e retorna 422. Consulta de outro provedor responde 404. Recibo 422 mantém correlationId do corpo; o header acompanha a tentativa atual.

Migration 0003 é incremental e não modifica 0002. Down recusa descartar identidades externas aceitas; validação reversível ocorre em banco descartável ou com apenas aberturas, cujo histórico é preservado.

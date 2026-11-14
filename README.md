# Jungle Gaming — Distributed Wagering Processor

Solução para o [backend challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge)
(cópia consultada em [docs/research/challenge-readme.md](docs/research/challenge-readme.md)).

O serviço processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por
vários provedores de jogos, por HTTP ou por SQS, e mantém wallets com ledger em partidas dobradas.
Decisões, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

Garantias, válidas com várias instâncias, entregas repetidas, mensagens fora de ordem e processos
que morrem no meio do trabalho:

- **Sem débito ou crédito duplicado**: chave de idempotência e identidade externa únicas por
  provedor, com recibo original estável ([ADR 0008](docs/adr/0008-provider-scoped-idempotency.md),
  [ADR 0007](docs/adr/0007-stable-submission-receipt.md), [ADR 0009](docs/adr/0009-reversal-uniqueness-by-kind.md)).
- **Sem saldo negativo e sem lost update**: lock pessimista por wallet e constraints no schema
  ([ADR 0004](docs/adr/0004-wallet-pessimistic-locking.md), ARCHITECTURE.md, seções *concorrência* e *schema*).
- **Dinheiro exato**: `Money` com `decimal.js` e `NUMERIC` no banco, nunca `number`
  ([ADR 0005](docs/adr/0005-exact-money.md)); saldo sempre igual ao ledger
  ([ADR 0012](docs/adr/0012-double-entry-ledger.md)).
- **Idempotência persistente**: deduplicação no PostgreSQL, sem estado em memória
  (ARCHITECTURE.md, seção *idempotência*).
- **Inbox/outbox transacionais**: inbox, saldo, ledger, recibo e evento entram no mesmo commit; o
  ack SQS só acontece depois dele ([ADR 0013](docs/adr/0013-outbox-persistent-leases.md),
  [ADR 0014](docs/adr/0014-sqs-consumer-failures.md), ARCHITECTURE.md, seção *mensageria*).
- **Multi-instância**: API e workers sem estado local, testados com três processos simultâneos
  ([ADR 0016](docs/adr/0016-modular-monolith-mikroorm.md)).

Requisitos do desafio mapeados para implementação e testes: [docs/requirements-matrix.md](docs/requirements-matrix.md).
Somente dados fictícios; não há integração com pagamentos reais
([ADR 0001](docs/adr/0001-external-payments-outside-delivery.md)).

## Pré-requisitos

- Docker com Compose v2 (suficiente para subir e testar tudo em containers).
- [Bun](https://bun.sh) 1.3.14 para desenvolvimento e testes fora do Docker.
- Chromium para `test:browser`: `bunx playwright install --with-deps chromium` ou `CHROME_PATH=/usr/bin/google-chrome`.

## Subir tudo com Docker Compose

```sh
docker compose --profile events up -d --build
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

O Compose cria o papel restrito do banco (`provision`), aplica as migrations (`migrate`), cria as
filas FIFO com DLQ e sobe API, `command-consumer`, `reference-worker`, Prometheus e Grafana. O perfil
`events` acrescenta o `outbox-publisher` e o `event-consumer` demonstrativo; sem ele os eventos ficam
pendentes na outbox. As portas são publicadas apenas em `127.0.0.1`:

| Serviço | Endereço | Credenciais (somente locais) |
| --- | --- | --- |
| Console + API | http://localhost:3000 | usuários do realm abaixo |
| Keycloak | http://localhost:18080 | admin `admin` / `local-demo-only` |
| Grafana | http://localhost:3001 | `admin` / `local-demo-only` (`GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://localhost:9090 | — |
| PostgreSQL | `127.0.0.1:55439` | migrations `jungle` / `local-demo-only`; runtime `jungle_runtime` / `runtime-demo-only` |
| SQS (LocalStack 4.0.3) | http://localhost:4566 | `test` / `test` |

Usuários do realm `jungle`, senha `demo-only` ([ADR 0002](docs/adr/0002-demo-access-boundaries.md)):
`viewer` consulta wallets, transações, ledger e métricas; `operator` também reconcilia (sem corrigir
saldo); `demo-operator` também cria wallets e dispara cenários de demonstração. Os provedores são
clientes de máquina (Client Credentials) `provider-a` / `provider-a-demo-only` e `provider-b` /
`provider-b-demo-only`, e só enxergam as próprias transações ([ADR 0003](docs/adr/0003-provider-machine-identity.md)).

Parar sem apagar dados: `docker compose --profile events down`. Recomeçar do zero:
`docker compose --profile events down -v` (apaga os volumes **deste** projeto Compose). Escale workers
com `docker compose up -d --scale command-consumer=3` (ou `outbox-publisher`); a API publica a porta
3000, então várias APIs ficam a cargo do harness de testes ou de um balanceador.

### Roteiro de avaliação em 5 minutos

1. Abra http://localhost:3000, entre como `demo-operator` e crie uma wallet com `100.00 BRL`.
2. Em **Executar cenário**, rode **Disputa pelo saldo**: duas BET de 80 em paralelo, uma `PROCESSED`
   e outra `REJECTED` com `INSUFFICIENT_FUNDS`; saldo final `20.00`.
3. Rode **Repetição idempotente**: a mesma chave duas vezes em paralelo gera um único débito e um
   recibo com `idempotentReplay: true`.
4. Rode **Referência fora de ordem**: o REFUND chega antes da BET, recebe `202 PENDING_REFERENCE` e o
   `reference-worker` o conclui; o console mostra o recibo original ao lado do estado atual.
5. Clique em **Reconciliar ledger**: `storedBalance = calculatedBalance` e `consistent: true`.
6. Opcional: abra o dashboard **Jungle Gaming Operations** no Grafana.

O roteiro do vídeo, com falha e recuperação de processos, está em [docs/demo-script.md](docs/demo-script.md).

## Desenvolvimento local fora do Docker

```sh
bun install --frozen-lockfile
cp .env.example .env                      # endpoints do Compose em loopback
docker compose up -d --wait postgres sqs keycloak
docker compose run --rm provision         # papel jungle_runtime (idempotente)
bun run migrate:up
bun run provision:commands && bun run provision:events
bun run dev                               # API + console em :3000 (bun --watch)
bun run worker:references                 # cada worker em seu terminal
bun run worker:commands
bun run worker:outbox
bun run worker:events
```

- A configuração é validada no boot; valor ausente ou inválido encerra o processo com mensagem sanitizada.
- `bun run migrate:down` desfaz a última migration. Use apenas em banco descartável; as migrations
  recusam rollback que apagaria fatos financeiros.
- `worker:commands`, `worker:outbox` e `worker:events` aceitam `--once` para uma única iteração.
- `bun run typecheck` (TypeScript `strict`) e `bun run build` (typecheck + bundle do console em
  `frontend/dist`). Formatação: `bunx prettier --write <arquivo>`.

## Testes

| Comando | O que cobre | Infraestrutura |
| --- | --- | --- |
| `bun test` | Unidade (domínio, contratos, geradores); testes que exigem containers aparecem como *skip* | — |
| `INTEGRATION=1 bun test` | Unidade + integração + concorrência (sem o roteiro de recuperação nem o navegador) | PostgreSQL, SQS, Keycloak |
| `bun run test:integration` | `tests/integration`, `tests/concurrency` e `tests/recovery`; grava evidências em `artifacts/` (usado na CI) | PostgreSQL, SQS, Keycloak |
| `bun run test:concurrency` | 50 duplicatas, disputa 100→80+80, wallets independentes, 3 processos API, reversões concorrentes | PostgreSQL, Keycloak |
| `bun run test:recovery` | 4 fases: migrations/constraints, concorrência, entrega/recuperação e roteiro integrado com SIGKILL e restart; evidência em `artifacts/recovery/` | PostgreSQL, SQS, Keycloak |
| `bun run test:browser` | Build do console + login PKCE, permissões e cenário completo no navegador | Keycloak, Chromium |
| `bun run test:load` | Carga com 1 e 3 APIs em 3 cenários (≈15 min no padrão); falha se algum invariante quebrar. Opções em [docs/load-testing.md](docs/load-testing.md) | PostgreSQL, SQS, Keycloak |
| `STACK_URL=http://localhost:3000 bun run test:stack` | Smoke caixa-preta de um stack em execução (`STACK_USER`/`STACK_PASSWORD`, padrão `demo-operator`/`demo-only`) | stack Compose ou hospedado |
| `docker compose --profile test run --build --rm tests` | `bun test` com `INTEGRATION=1` dentro de um container | Compose |

Para rodar a infraestrutura dos testes fora do Docker, use os três primeiros comandos de
[Desenvolvimento local](#desenvolvimento-local-fora-do-docker) mais `docker compose run --rm provision`.
Os testes criam um banco descartável por suíte via `MIGRATION_DATABASE_URL` (precisa de `CREATEDB`),
filas SQS com UUID e portas efêmeras; não apagam dados do banco de demonstração. A CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) roda typecheck, unidade, `test:integration`,
a API do Compose com healthcheck, `test:stack` e `test:browser`. Estratégia completa em
[docs/testing-strategy.md](docs/testing-strategy.md).

Todo teste financeiro termina verificando `wallet.balance == saldo reconstruído pelo ledger`.

### Testes obrigatórios do §13

| Exigência | Arquivos (`tests/`) |
| --- | --- |
| `Money`: escala, arredondamento, entradas inválidas | `unit/money.test.ts` |
| Invariantes da `Wallet` | `unit/wallet.test.ts`, `unit/journal.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK | `unit/settlement.test.ts`, `unit/wallet.test.ts`, `unit/wager-transaction.test.ts` |
| Conflito de moeda | `unit/wallet.test.ts` (`CURRENCY_MISMATCH`), `unit/journal.test.ts`, `unit/settlement.test.ts` |
| Idempotency key com payload divergente | `unit/wager-transaction.test.ts`, `integration/wagering-http.test.ts` |
| Migrations e constraints | `integration/infrastructure.test.ts`, `integration/*-schema.test.ts`, `integration/wallet-chain.test.ts` |
| Atomicidade wallet/ledger/inbox/outbox | `integration/wallet-schema.test.ts`, `integration/wagering-http.test.ts`, `integration/command-idempotency.test.ts` |
| Inbox e redelivery | `integration/command-idempotency.test.ts`, `integration/command-process.test.ts`, `integration/outbox.test.ts` |
| Publishers concorrentes na mesma outbox | `integration/outbox.test.ts` |
| Retry e DLQ | `integration/command-dlq.test.ts`, `integration/sqs-capabilities.test.ts`, `integration/outbox.test.ts` |
| Recuperação após reinicialização | `recovery/integrated.test.ts`, `integration/pending-references.test.ts` |
| C1. Mesma aposta 50× em paralelo → um débito | `concurrency/bet.test.ts`, `integration/command-process.test.ts` |
| C2. Disputa pelo saldo da mesma wallet | `concurrency/bet.test.ts` |
| C3. Wallets distintas em paralelo | `concurrency/bet.test.ts`, `integration/command-process.test.ts` |
| C4. ≥ 3 processos simultâneos | `concurrency/bet.test.ts`, `concurrency/reversals.test.ts`, `integration/command-process.test.ts` |
| C5. Worker morto depois do commit e antes do ack | `integration/command-process.test.ts`, `recovery/integrated.test.ts` |
| C6. Dois publishers na mesma outbox | `integration/outbox.test.ts` |
| C7. ROLLBACK/REFUND antes da referência | `integration/pending-references.test.ts`, `integration/command-references.test.ts`, `integration/settlement-http.test.ts` |
| C8. Reinício com consistência final comprovada | `recovery/integrated.test.ts`, `concurrency/bet.test.ts` |

## API

Contrato completo no [ADR 0015](docs/adr/0015-http-response-contract.md). Erros têm `code`, `message`
e `correlationId`; toda resposta traz `X-Correlation-Id`.

| Rota | Autorização | Resultado |
| --- | --- | --- |
| `POST /wallets` | demo-operator | 201 com a wallet; abertura positiva gera lançamento OPENING e evento no mesmo commit |
| `GET /wallets/:id` | viewer+ | Estado atual |
| `GET /wallets/:id/ledger?cursor=&limit=` | viewer+ | `{ entries, nextCursor }`, limite padrão 50, máximo 100 |
| `POST /wallets/:id/reconciliation` | operator+ | `storedBalance`, `calculatedBalance`, `difference`, `consistent`; divergência vira log e métrica, nunca correção |
| `POST /wagering/transactions` | provedor | Submissão; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:id` | viewer+ ou provedor dono | Estado atual |
| `GET /providers/:providerId/wagering/transactions/:externalId` | viewer+ ou provedor dono | Mesma consulta pela identidade externa |
| `GET /wagering/transactions?walletId=&status=&kind=&providerId=` | viewer+ | Extensão para o console: listagem com `originalReceipt` |
| `POST /demo/scenarios` | demo-operator | Extensão: `duplicate`, `race`, `out-of-order` pelo endpoint real do provedor |
| `GET /internal/metrics` | viewer+ | Métricas Prometheus da API |
| `GET /health/live`, `GET /health/ready` | público | Liveness; readiness verifica PostgreSQL e SQS |

Exemplo de submissão como provedor (crie a wallet antes pelo console):

```sh
TOKEN=$(curl -s http://localhost:18080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-demo-only \
  | bun -e 'console.log((await Bun.stdin.json()).access_token)')
curl -s http://localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"<playerId>",
       "walletId":"<walletId>","roundId":"round-001","gameId":"game-001","kind":"BET",
       "money":{"amount":"20.00","currency":"BRL"}}'
```

| Status | Significado |
| --- | --- |
| 200 | `PROCESSED`; repetir a mesma requisição devolve o mesmo recibo com `idempotentReplay: true` |
| 202 | `PENDING_REFERENCE`: referência ainda ausente; o `reference-worker` conclui ou expira (TTL 15 min) |
| 422 | `REJECTED` com `failureCode` (ex.: `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`) |
| 409 | `IDEMPOTENCY_CONFLICT` (mesma chave, corpo diferente) ou `EXTERNAL_TRANSACTION_CONFLICT` (outra chave, mesmo `externalTransactionId`) |
| 400 / 401 / 403 / 404 | Payload inválido / sem token válido / sem permissão ou provedor errado / recurso inexistente |
| 503 | `INFRASTRUCTURE_UNAVAILABLE`: nada foi gravado e a chave não foi consumida; repita com a mesma chave |

Os `failureCode` estáveis e o mapeamento completo para HTTP estão em [ARCHITECTURE.md](ARCHITECTURE.md)
(seção *failureCodes/HTTP*).

## SQS

O `command-consumer` lê `wager-transactions.fifo`; após `COMMAND_MAX_RECEIVE_COUNT` (5) recebimentos o
redrive nativo envia para `wager-transactions-dlq.fifo`. A mensagem segue o §10 do desafio:
`messageId`, `type: "WagerTransactionRequested"`, `occurredAt` e `data` com os campos do HTTP mais
`idempotencyKey`. Envie com `MessageGroupId = walletId` e um `MessageDeduplicationId` (as filas não
usam deduplicação por conteúdo). O canal é interno, sem OAuth por mensagem, mas `providerId` é
validado contra `PROVIDER_CLIENTS`. Exemplo com o `awslocal` do container LocalStack:

```sh
docker compose exec sqs awslocal sqs send-message \
  --queue-url http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body "$(cat message.json)"   # envelope do §10 do desafio
```

Comportamento: o consumidor usa o mesmo caso de uso do HTTP; deduplica pela inbox persistente
`(consumer_name, message_id)`; faz `DeleteMessage` só depois do commit. Rejeições de negócio e
`PENDING_REFERENCE` são persistidas e recebem ack; falhas transitórias não recebem ack e entram em
backoff (1 s a 30 s); envelopes inválidos e conflitos de idempotência vão para a DLQ com diagnóstico
(`originalMessageId`, `transportMessageId`, `reason`, `originalBody`). A visibilidade (30 s) é renovada
a cada terço do prazo. No `SIGTERM`, o consumidor para de receber, drena por até `COMMAND_DRAIN_MS`
(20 s), depois cancela a query, espera o rollback e devolve a visibilidade.

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged`, `WagerTransactionPendingReference`) saem por `wager-events.fifo`, com DLQ
`wager-events-dlq.fifo`.

**Tratar a DLQ de comandos**: investigue pelos logs com o `messageId`, corrija a causa, reenvie o corpo
original com `MessageGroupId = walletId` e um **novo** deduplication ID (preservando `messageId` e
chave se o conteúdo for o mesmo), confirme o envio e só então apague a cópia da DLQ. Conteúdo
corrigido é uma nova mensagem; estados terminais nunca são reabertos. Detalhes em
[docs/operations.md](docs/operations.md).

## Operação

- **Outbox**: o publisher reserva a cabeça de cada wallet com `FOR UPDATE SKIP LOCKED` e lease de
  30 s; retry com backoff de 1 s a 60 s. Um evento rejeitado pelo SQS (conteúdo inválido ou tamanho)
  fica com `blocked_at` e segura só os eventos seguintes da mesma wallet. Diagnóstico SQL em
  [docs/operations.md](docs/operations.md#outbox-outbox-publisher); depois de corrigir a causa,
  reative sem alterar o payload com `bun run outbox:retry <eventId>`. Nunca marque publicação à mão.
- **Referências pendentes**: o `reference-worker` reavalia com backoff (1 s a 30 s, jitter) até o TTL
  fixado no primeiro aceite; vence como `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_READY` ou
  `REFERENCE_NOT_PROCESSED`.
- **Observabilidade**: logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e
  `providerId`, sem payload financeiro. Prometheus coleta `/metrics` de cada processo numa rede
  interna (porta `METRICS_PORT`, não publicada); a API expõe `GET /internal/metrics` para viewers.
  Grafana provisiona o dashboard **Jungle Gaming Operations**. Métricas e roteiro de diagnóstico em
  [docs/observability.md](docs/observability.md).
- **Health**: `/health/live` indica o processo; `/health/ready` responde 503 e indica a dependência
  quando PostgreSQL ou SQS caem. Workers retomam sozinhos com backoff.

## Configuração

[`.env.example`](.env.example) lista todas as variáveis com valores locais; dentro do Compose os
endpoints apontam para a rede dos containers.

| Grupo | Variáveis principais | Padrão local |
| --- | --- | --- |
| Banco | `DATABASE_URL` (runtime restrito), `MIGRATION_DATABASE_URL` (dono do schema; migrations e testes) | porta 55439 |
| SQS | `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | LocalStack |
| Identidade | `KEYCLOAK_ISSUER`, `KEYCLOAK_JWKS_URL`, `KEYCLOAK_TOKEN_URL`, `PROVIDER_CLIENTS`, `DEMO_PROVIDER_CLIENT_SECRETS` | realm `jungle` |
| Financeiro | `FINANCIAL_LOCK_TIMEOUT_MS`, `FINANCIAL_STATEMENT_TIMEOUT_MS`, `FINANCIAL_DEADLINE_MS` | 3000 / 5000 / 15000 |
| Referências | `REFERENCE_TTL_MS`, `REFERENCE_BASE_MS`, `REFERENCE_MAX_MS`, `REFERENCE_POLL_MS`, `REFERENCE_BATCH_SIZE` | 900000 / 1000 / 30000 / 500 / 50 |
| Comandos SQS | `COMMAND_QUEUE_NAME`, `COMMAND_VISIBILITY_SECONDS`, `COMMAND_DRAIN_MS`, `COMMAND_MAX_RECEIVE_COUNT`, `COMMAND_RETRY_*` | `wager-transactions.fifo`, 30 s, 20 s, 5 |
| Outbox | `OUTBOX_QUEUE_NAME`, `OUTBOX_LEASE_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_RETRY_*`, `OUTBOX_POLL_MS` | `wager-events.fifo`, 30 s, 20, 500 ms |
| Observabilidade | `PORT`, `METRICS_PORT`, `METRICS_NETWORK_SUBNET`, `PROBE_TIMEOUT_MS`, `GRAFANA_ADMIN_*` | 3000, 0 (listener desligado), `172.31.20.0/24`, 2000 |

Se `172.31.20.0/24` conflitar com outra rede Docker, altere `METRICS_NETWORK_SUBNET`; o mesmo valor
define a rede de scrape e a allowlist do listener de métricas. As credenciais acima são públicas e
servem só para a demonstração local; a configuração hospedada gera as próprias.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md): visão geral, ORM, Money, domínio, concorrência, schema,
  idempotência, regras, failureCodes/HTTP, mensageria, auth, observabilidade e limitações.
- [ADRs](docs/adr/) · [Especificação](docs/spec.md) · [Glossário](CONTEXT.md) ·
  [Matriz de requisitos](docs/requirements-matrix.md) · [Estratégia de testes](docs/testing-strategy.md)
- [Operação](docs/operations.md) · [Observabilidade](docs/observability.md) ·
  [Teste de carga](docs/load-testing.md) · [Roteiro do vídeo](docs/demo-script.md)
- [Demo hospedada](deploy/hosted/README.md) (HTTPS com Caddy, Keycloak em modo produção, segredos
  gerados) e situação da submissão em [docs/submission.md](docs/submission.md).

Evidências registradas:

- [Validação da entrega](docs/evidence/issue-14/README.md): checkout limpo, revisão contra as falhas
  eliminatórias, configuração hospedada e [vídeo](docs/evidence/issue-14/demo.mp4).
- [Concorrência e recuperação integrada](docs/evidence/issue-12/README.md).
- [Carga com 1 e 3 APIs](docs/evidence/issue-13/README.md) e
  [vazão da outbox por wallet](docs/evidence/issue-27/README.md).
- [Observabilidade com falha e recuperação do PostgreSQL](docs/evidence/issue-11/README.md).
- [Console: listagem e recibo original](docs/evidence/issue-10/README.md).

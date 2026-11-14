# Jungle Gaming — Distributed Wagering Processor

Solução para o [backend challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge)
(cópia consultada em [docs/research/challenge-readme.md](docs/research/challenge-readme.md)).

O serviço processa transações de apostas de vários provedores de jogos. Ele não duplica débitos
ou créditos, não deixa o saldo ficar negativo e mantém saldo e ledger iguais. Isso vale com várias
instâncias, entregas repetidas, mensagens fora de ordem e processos que morrem no meio do trabalho.

| Tipo de item | Onde está | Exemplos |
| --- | --- | --- |
| **Requisito do README original** | [matriz R01–R25](docs/requirements-matrix.md) | Money exato, BET/WIN/LOSS/REFUND/ROLLBACK, idempotência persistente, inbox/outbox, SQS + DLQ, ≥3 instâncias, testes do §13 |
| **Decisão aprovada (spec/ADRs)** | [docs/spec.md](docs/spec.md), [docs/adr/](docs/adr/) | Lock pessimista por wallet, recibo original estável, 409 ao trocar a chave, REFUND+ROLLBACK por tipo, TTL de 15 min, contrato HTTP |
| **Diferencial opcional escolhido por nós** | [matriz D01–D05](docs/requirements-matrix.md) | Partidas dobradas, Keycloak com perfis, console, Prometheus/Grafana, teste de carga, demo hospedada e vídeo |

Visão geral da arquitetura, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md).

## Início rápido (Docker Compose)

Requisitos: Docker com Compose v2. Bun 1.3.14 só é necessário para rodar os
testes fora do container.

```sh
docker compose --profile events up -d --build
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

O Compose cria o papel restrito do banco (`provision`), aplica as migrations (`migrate`) e cria as
filas FIFO e as DLQs. Depois sobe a API e os workers. O perfil `events` inclui o publisher da
outbox e o consumidor demonstrativo de eventos. Sem esse perfil, os eventos ficam pendentes na
outbox. As portas são publicadas apenas em `127.0.0.1`:

| Serviço | Endereço | Credenciais (somente locais) |
| --- | --- | --- |
| Console + API | http://localhost:3000 | usuários do realm abaixo |
| Keycloak | http://localhost:18080 | admin `admin` / `local-demo-only` |
| Grafana | http://localhost:3001 | `admin` / `local-demo-only` (`GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://localhost:9090 | — |
| PostgreSQL | `127.0.0.1:55439` | migrations `jungle` / `local-demo-only`; runtime `jungle_runtime` / `runtime-demo-only` |
| SQS (LocalStack 4.0.3) | http://localhost:4566 | `test` / `test` |

Usuários do realm `jungle` (senha local `demo-only`; [ADR 0002](docs/adr/0002-demo-access-boundaries.md)):

| Usuário | Perfil | Pode |
| --- | --- | --- |
| `viewer` | viewer | Consultar wallets, transações, ledger e métricas da API |
| `operator` | operator | Tudo de viewer e também reconciliar (sem corrigir saldo) |
| `demo-operator` | demo-operator | Tudo de operator, criar wallets e disparar cenários de demonstração |

Os provedores são clientes de máquina (Client Credentials). `provider-a` e `provider-b` usam os
segredos `provider-a-demo-only` e `provider-b-demo-only`. Eles submetem e consultam somente as
próprias transações ([ADR 0003](docs/adr/0003-provider-machine-identity.md)). Essas credenciais são
públicas e servem apenas para a demonstração local. A hospedagem gera credenciais próprias.

Para parar sem apagar dados, use `docker compose --profile events down`. Para recomeçar do zero,
use `docker compose --profile events down -v`, que apaga os volumes **deste** projeto Compose.

### Roteiro de avaliação em 5 minutos

1. Abra http://localhost:3000, entre como `demo-operator` e crie uma wallet com `100.00 BRL`.
2. Em **Executar cenário**, escolha **Disputa pelo saldo**. Duas BET de 80% do saldo são enviadas ao mesmo
   tempo: uma fica `PROCESSED` e a outra `REJECTED` com `INSUFFICIENT_FUNDS`. O saldo final é
   `20.00`.
3. Execute **Repetição idempotente**. A mesma chave é enviada duas vezes em paralelo e gera um único débito.
   Um dos recibos tem `idempotentReplay: true`.
4. Execute **Referência fora de ordem**. O REFUND chega antes da BET e recebe
   `202 PENDING_REFERENCE`. O `reference-worker` conclui a operação, e o console mostra o recibo
   original ao lado do estado atual.
5. Clique em **Reconciliar ledger**. O resultado mostra `storedBalance = calculatedBalance` e
   `consistent: true`.
6. Opcional: abra o dashboard **Jungle Gaming Operations** no Grafana.

O roteiro do vídeo, com falha e recuperação de processos, está em
[docs/demo-script.md](docs/demo-script.md).

## Desenvolvimento e testes fora do Docker

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

Antes de iniciar o processo, a configuração é validada. Se um valor obrigatório estiver ausente ou
for inválido, o boot para com uma mensagem sanitizada.

`migrate:down` desfaz a última migration. Use esse comando somente em banco descartável. As
migrations recusam o rollback quando ele apagaria fatos financeiros. Os workers aceitam `--once`
para executar uma única iteração.

### Comandos

| Comando | O que valida | Infraestrutura |
| --- | --- | --- |
| `bun run typecheck` | TypeScript `strict` | — |
| `bun run build` | typecheck + bundle do console (`frontend/dist`) | — |
| `bun test` | Domínio, contratos e geradores. Testes que precisam de containers aparecem como *skip* | — |
| `bun test tests/unit` | Somente unidade (CI) | — |
| `bun run test:integration` | Integração, concorrência e roteiro integrado de recuperação (CI) | PostgreSQL, SQS e Keycloak |
| `bun run test:concurrency` | 50 duplicatas, disputa 100→80+80, wallets independentes e 3 processos API | PostgreSQL e Keycloak |
| `bun run test:recovery` | 4 fases: migrations/constraints, concorrência, entrega/recuperação e roteiro integrado de 18 estágios. Grava a evidência em `artifacts/recovery/` | PostgreSQL, SQS e Keycloak |
| `bun run test:browser` | Login PKCE, permissões e cenário completo no console | Keycloak e Chromium |
| `STACK_URL=http://localhost:3000 bun run test:stack` | Smoke caixa-preta de um stack em execução: cenários, worker de referências e reconciliação | stack Compose ou hospedado |
| `bun run test:load` | Experimento de carga (≈15 min no padrão); ver [docs/load-testing.md](docs/load-testing.md) | PostgreSQL, SQS e Keycloak |
| `docker compose --profile test run --build --rm tests` | Suíte com Bun dentro do container | Compose |
| `bun run demo:record [dir]` | Grava o vídeo do [roteiro](docs/demo-script.md) contra o stack local, com o JSON da execução | stack Compose + Chrome |

Os testes de integração criam um banco descartável por suíte, usando `MIGRATION_DATABASE_URL`, que
precisa de `CREATEDB`. Também criam filas SQS com UUID e usam portas efêmeras. Eles não apagam
dados do banco de demonstração nem param containers. O teste de navegador sobe a própria API em
processo e acrescenta temporariamente o callback dela ao cliente `jungle-console` do Keycloak.
Instale o Chromium com `bunx playwright install --with-deps chromium` ou aponte
`CHROME_PATH=/usr/bin/google-chrome`. O smoke `test:stack` aceita `STACK_USER` e `STACK_PASSWORD`
(padrão `demo-operator`/`demo-only`).

A CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) executa, em sequência: typecheck,
unidade, `test:integration`, a API do Compose com healthcheck e `test:browser`. O `test:stack`
ainda não está na CI e é executado manualmente contra o Compose (ver
[issue-14](docs/evidence/issue-14/README.md)). Prettier está fixado no lockfile; para formatar um arquivo, use
`bunx prettier --write <arquivo>`.

### Variáveis de ambiente

[`.env.example`](.env.example) lista todas as variáveis com os valores locais. Dentro do Compose,
os endpoints apontam para a rede dos containers.

| Grupo | Variáveis | Padrão |
| --- | --- | --- |
| Banco | `DATABASE_URL` (runtime restrito), `MIGRATION_DATABASE_URL` (dono do schema; migrations e testes) | — |
| SQS | `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | LocalStack |
| Identidade | `KEYCLOAK_ISSUER`, `KEYCLOAK_JWKS_URL`, `KEYCLOAK_TOKEN_URL`, `PROVIDER_CLIENTS`, `DEMO_PROVIDER_CLIENT_SECRETS` (somente na API) | realm `jungle` |
| Financeiro | `FINANCIAL_LOCK_TIMEOUT_MS`, `FINANCIAL_STATEMENT_TIMEOUT_MS`, `FINANCIAL_DEADLINE_MS` | 3000 / 5000 / 15000 |
| Referências | `REFERENCE_TTL_MS`, `REFERENCE_BASE_MS`, `REFERENCE_MAX_MS`, `REFERENCE_POLL_MS`, `REFERENCE_BATCH_SIZE` | 900000 / 1000 / 30000 / 500 / 50 |
| Comandos SQS | `COMMAND_QUEUE_NAME`, `COMMAND_VISIBILITY_SECONDS`, `COMMAND_CALL_TIMEOUT_MS`, `COMMAND_WAIT_SECONDS`, `COMMAND_RETRY_BASE_MS`, `COMMAND_RETRY_MAX_MS`, `COMMAND_DRAIN_MS`, `COMMAND_MAX_RECEIVE_COUNT` | `wager-transactions.fifo`, 30 s, 5 s, 2 s, 1 s, 30 s, 20 s, 5 |
| Outbox | `OUTBOX_QUEUE_NAME`, `OUTBOX_LEASE_MS`, `OUTBOX_SEND_TIMEOUT_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_MAX_MS`, `OUTBOX_POLL_MS` | `wager-events.fifo`, 30 s, 5 s, 20, 1 s, 60 s, 500 ms |
| Observabilidade | `PORT`, `METRICS_PORT`, `METRICS_NETWORK_SUBNET`, `PROBE_TIMEOUT_MS`, `DATABASE_CONNECT_TIMEOUT_MS`, `GRAFANA_ADMIN_*` | 3000, 0, `172.31.20.0/24`, 2000, 5000 |

Se a sub-rede `172.31.20.0/24` conflitar com outra rede Docker, altere `METRICS_NETWORK_SUBNET`.
O mesmo valor define a rede interna de scrape e a allowlist do listener de métricas.

## API

O contrato completo, com os códigos de status, está no
[ADR 0015](docs/adr/0015-http-response-contract.md). Toda resposta de erro tem `code`, `message` e
`correlationId`, e todas as respostas trazem o header `X-Correlation-Id`.

| Rota | Quem chama | Resultado |
| --- | --- | --- |
| `POST /wallets` | demo-operator | 201 com `id`, `playerId`, `balance` e `version: 1`. Abertura positiva gera OPENING + ledger + evento na mesma transação. 409 `WALLET_ALREADY_EXISTS` |
| `GET /wallets/:id` | viewer+ | Estado atual ou 404 |
| `GET /wallets/:id/ledger?cursor=&limit=` | viewer+ | `{ entries, nextCursor }`. Cursor opaco vinculado à wallet. Limite padrão 50, máximo 100 |
| `POST /wallets/:id/reconciliation` | operator+ | `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`. Uma divergência vira log e métrica, nunca correção |
| `POST /wagering/transactions` | cliente do provedor | Header `Idempotency-Key` obrigatório. 200 `PROCESSED`, 202 `PENDING_REFERENCE`, 422 `REJECTED` + `failureCode`, 409 conflito, 400 inválido, 503 transitório |
| `GET /wagering/transactions/:id` | viewer+ ou provedor dono | Estado atual (REJECTED retorna 200) |
| `GET /providers/:providerId/wagering/transactions/:externalId` | viewer+ ou provedor dono | Mesma consulta, pela identidade externa |
| `GET /wagering/transactions?walletId=&status=&kind=&providerId=` | viewer+ | *Extensão*: listagem paginada para o console, com `originalReceipt` ao lado do estado atual |
| `POST /demo/scenarios` | demo-operator | *Extensão*: `duplicate`, `race` ou `out-of-order` pelo endpoint real do provedor, com auditoria do ator |
| `GET /internal/metrics` | viewer+ | Métricas Prometheus da API |
| `GET /health/live`, `GET /health/ready` | público | Liveness do processo; readiness verifica PostgreSQL e SQS |

Exemplo de submissão como provedor, depois de criar uma wallet no console:

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

Repetir o mesmo comando devolve o mesmo recibo com `idempotentReplay: true`. Alterar o corpo com a
mesma chave retorna 409 `IDEMPOTENCY_CONFLICT`. Usar outra chave para o mesmo
`externalTransactionId` retorna 409 `EXTERNAL_TRANSACTION_CONFLICT`. Os códigos de falha estáveis
estão em [ARCHITECTURE.md](ARCHITECTURE.md#códigos-de-falha).

### Entrada SQS

O `command-consumer` lê `wager-transactions.fifo`, com redrive para `wager-transactions-dlq.fifo`
após 5 recebimentos. O envelope segue o §10 do desafio: `messageId`,
`type: WagerTransactionRequested`, `occurredAt` e `data` com os mesmos campos do HTTP mais
`idempotencyKey`. Envie `MessageGroupId = walletId`. O canal é interno e confiável, sem OAuth por
mensagem, mas o `providerId` continua validado contra `PROVIDER_CLIENTS`. Os eventos de integração
saem por outra fila, `wager-events.fifo`. Procedimentos de DLQ, redrive e reenvio estão em
[docs/operations.md](docs/operations.md).

## Processos

| Processo | Entrypoint | Papel |
| --- | --- | --- |
| `api` | `src/bootstrap/main.ts` | HTTP, console estático e coleta durável das métricas |
| `command-consumer` | `src/bootstrap/command-consumer.ts` | Comandos SQS com o mesmo caso de uso do HTTP, inbox e ack após commit |
| `reference-worker` | `src/bootstrap/reference-worker.ts` | `PENDING_REFERENCE`: backoff, TTL e expiração |
| `outbox-publisher` | `src/bootstrap/outbox-publisher.ts` | Publica a outbox com leases `SKIP LOCKED` (perfil `events`) |
| `event-consumer` | `src/bootstrap/event-consumer.ts` | Consumidor demonstrativo com inbox e projeção (perfil `events`) |

Todos usam a mesma imagem. Escale com `docker compose up -d --scale command-consumer=3` (ou
`outbox-publisher`). A API publica a porta 3000, então para várias APIs use o harness de testes ou
um balanceador. O diagnóstico está em [docs/observability.md](docs/observability.md) e
[docs/operations.md](docs/operations.md).

## Evidências

- [Matriz requisito → implementação → teste/evidência](docs/requirements-matrix.md)
- [Validação da entrega (#14)](docs/evidence/issue-14/README.md): checkout limpo, revisão contra as
  falhas eliminatórias, configuração hospedada e vídeo
- [Concorrência e recuperação integrada (#12)](docs/evidence/issue-12/README.md),
  [carga (#13)](docs/evidence/issue-13/README.md) e
  [observabilidade (#11)](docs/evidence/issue-11/README.md)

## Demonstração hospedada e vídeo

- A configuração reproduzível com HTTPS (Caddy), Keycloak em modo produção e segredos gerados está
  em [deploy/hosted/](deploy/hosted/README.md). Ela foi testada localmente com TLS interno. Destino,
  custo e forma de acesso ainda dependem de decisão; a situação atual está em
  [docs/submission.md](docs/submission.md).
- Roteiro do vídeo: [docs/demo-script.md](docs/demo-script.md).

## Documentação

[ARCHITECTURE.md](ARCHITECTURE.md) · [Especificação](docs/spec.md) · [Matriz](docs/requirements-matrix.md)
· [ADRs](docs/adr/) · [Glossário](CONTEXT.md) · [Estratégia de testes](docs/testing-strategy.md)
· [Carga](docs/load-testing.md) · [Observabilidade](docs/observability.md)
· [Operação](docs/operations.md) · [Entrega](docs/delivery.md) · [Submissão](docs/submission.md)

Somente dados fictícios. O projeto não integra dinheiro real nem meios de pagamento
([ADR 0001](docs/adr/0001-external-payments-outside-delivery.md)).

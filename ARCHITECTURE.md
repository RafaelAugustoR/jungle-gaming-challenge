# Arquitetura

Decisões, trade-offs e limitações da implementação entregue, organizados por tema. A fonte
normativa é o [README do desafio](docs/research/challenge-readme.md). O detalhamento está na
[especificação](docs/spec.md), nas [ADRs](#14-índice-de-adrs) e na
[matriz de requisitos](docs/requirements-matrix.md), que liga cada requisito ao código e aos testes.

## 1. Visão geral

Monólito modular NestJS 11 em Bun 1.3.14 (TypeScript `strict`), MikroORM 6.6 sobre PostgreSQL 16.6
e SQS FIFO no LocalStack 4.0.3. Todos os processos usam a mesma imagem e o mesmo núcleo
financeiro; o processo é escolhido pelo entrypoint ([ADR 0016](docs/adr/0016-modular-monolith-mikroorm.md)).

| Processo         | Entrypoint                          | Papel                                                                    |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| API              | `src/bootstrap/main.ts`             | HTTP: wallets, submissão, consultas, reconciliação, health, console      |
| command-consumer | `src/bootstrap/command-consumer.ts` | Consome `wager-transactions.fifo` (comandos `WagerTransactionRequested`) |
| reference-worker | `src/bootstrap/reference-worker.ts` | Reavalia operações `PENDING_REFERENCE` com backoff persistido            |
| outbox-publisher | `src/bootstrap/outbox-publisher.ts` | Publica a outbox em `wager-events.fifo` com leases                       |
| event-consumer   | `src/bootstrap/event-consumer.ts`   | Consumidor de demonstração: inbox de eventos e projeção por wallet       |

```
 Provedor ──HTTP + Idempotency-Key──┐          wager-transactions.fifo ──► command-consumer
 (Client Credentials)               ▼                (MessageGroupId=walletId)   │ ack só após commit
                                   API ─────► SubmitWagerTransaction ◄───────────┘
 reference-worker ──► ReprocessReferences ──┘       │
                                                    ▼
          ┌──────────── uma transação PostgreSQL (lock FOR UPDATE da wallet) ────────────┐
          │ transação · wallet (saldo+versão) · journal · recibo · inbox (SQS) · outbox  │
          │ · agenda de referência — constraints diferidas validadas no COMMIT           │
          └──────────────────────────────────────────────────────────────────────────────┘
                                                    │ (depois do commit, assíncrono)
                         outbox-publisher (SKIP LOCKED + lease) ──► wager-events.fifo ──► event-consumer
```

| Módulo             | Responsabilidade                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `shared/domain`    | `Money`, `IntegrationEvent`, `DomainError`                                                                                          |
| `modules/wallets`  | `Wallet`, `JournalEntry`, abertura, ledger paginado, reconciliação                                                                  |
| `modules/wagering` | `WagerPayload`, `WagerTransaction`, passos por tipo (`wager-step.ts`), recibos, eventos, submissão e reprocessamento de referências |
| `modules/identity` | Verificação de JWT do Keycloak e política de acesso de humanos e provedores                                                         |
| `modules/demo`     | Cenários de demonstração e auditoria do ator humano                                                                                 |
| `messaging/*`      | Consumidor de comandos, outbox, consumidor de eventos, runtime de workers, backoff, `InboxMessage`/`OutboxMessage`                  |
| `observability`    | Logger JSON sanitizado, métricas Prometheus, health                                                                                 |

O domínio não importa NestJS, MikroORM nem SQS. Os casos de uso dependem das portas `WageringStore`
e `WalletStore`, implementadas em `infrastructure/persistence`.

## 2. Stack e ORM

**MikroORM** é a opção preferencial do desafio e se encaixa no modelo de contexto por requisição:
cada requisição ou trabalho abre `orm.em.fork()` e executa `transactional()`, sem identity map
compartilhado entre requisições. Migrations são do MikroORM (`migrations/`), versionadas e reversíveis
(o teste de recuperação executa up → down até zero → up).

**Trade-off assumido:** a persistência financeira **não** usa entidades gerenciadas, Unit of Work com
change tracking, Identity Map nem `LockMode`. O ORM é configurado com `entities: []`
(`src/config/orm.ts`) e os repositórios executam SQL explícito parametrizado por `em.execute()` dentro
da transação do fork. Motivos:

- `NUMERIC` é lido como `balance::text` e escrito como string, sem passar por hidratação numérica do
  driver ou do ORM;
- a ordem dos comandos é parte da correção: `SELECT … FOR UPDATE` da wallet antes de qualquer leitura
  de decisão, `set_config('lock_timeout'/'statement_timeout')` local à transação e inserções
  dependentes antes das constraints diferidas;
- o domínio decide o estado final antes da escrita; a transação é inserida já em
  `PROCESSED`/`REJECTED`/`PENDING_REFERENCE`, sem linha `PENDING` intermediária que o flush do UoW
  produziria e o trigger de transição teria de aceitar;
- o schema (triggers, grants por coluna, constraints diferidas) é a garantia final, e o SQL explícito
  torna visível exatamente o que é escrito.

O custo é real: mapeamento manual de linhas para `rehydrate`, mais SQL para revisar, e não se
aproveita o que o desafio destaca no MikroORM (UoW, Identity Map, `LockMode`). O MikroORM fica como
gerenciador de conexão/pool, fronteira transacional e migrator. A ADR 0016 registra o monólito
modular e o contexto isolado; a justificativa do SQL explícito está aqui.

Pool de 5 conexões por processo (`DATABASE_POOL`), cada instância com o seu.

## 3. Money

Representação exata ([ADR 0005](docs/adr/0005-exact-money.md)), em `src/shared/domain/money.ts`:

- **decimal.js somente dentro de `Money`** (clone com precisão 40). O resto do código vê `Money` ou
  `MoneyProps { amount: string; currency: string }`. O valor nunca passa por `number`.
- **Entrada:** `Money.create(amount, currency)` aceita só string `^(0|[1-9]\d*)\.\d{2}$` (exatamente
  duas casas, sem sinal, expoente, espaços ou zeros à esquerda) e moeda `^[A-Z]{3}$`; senão
  `INVALID_PAYLOAD`. `0.001` é recusado, não arredondado. Limite absoluto `9999999999999999.99`
  (`AMOUNT_LIMIT_EXCEEDED`).
- **Saída:** `toProps()` sempre formata com `toFixed(2)`.
- **Reidratação:** `Money.rehydrate` aceita o texto do PostgreSQL, que pode omitir zeros finais
  (`10`, `10.5`), recusa escala > 2 e reaplica o limite.
- **Operações:** `add`/`subtract`/`negate` com verificação de moeda (`CURRENCY_MISMATCH`) e limite;
  `canAdd` permite rejeitar um crédito que ultrapassaria o limite.
- **Banco:** colunas `wagering.money_amount`, um domínio `numeric` com `check` de finitude (sem
  `NaN`/`±Infinity`), `scale(value) <= 2`, `value >= 0` e `<= 9999999999999999.99`. O `numeric` não
  tem escala fixa justamente para não coagir silenciosamente: a validação está no domínio do banco e
  no `Money`. A moeda fica em coluna separada, amarrada por FKs compostas `(id, currency)`.

Entregue em BRL; o modelo carrega a moeda e testa incompatibilidade.

## 4. Modelo de domínio

Construtores privados com factories (`create`/`open`/`record`/`enqueue`) e `rehydrate`, que
reconstrói estado persistido sem reexecutar regras de transição. Os esqueletos do §6 foram adaptados
onde indicado.

| Classe             | Arquivo                                     | Papel                                                                                                                                                                           |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Money`            | `shared/domain/money.ts`                    | Valor imutável exato                                                                                                                                                            |
| `Wallet`           | `wallets/domain/wallet.ts`                  | Raiz de agregado: saldo, versão, `debit`/`credit` que retornam nova wallet + `JournalEntry`; `open` cria wallet e, se saldo > 0, a transação `OPENING`, o lançamento e o evento |
| `WagerPayload`     | `wagering/domain/wager-payload.ts`          | Comando validado + `payloadHash`                                                                                                                                                |
| `WagerTransaction` | `wagering/domain/wager-transaction.ts`      | Máquina de estados, recibo de submissão e evento de resultado                                                                                                                   |
| `JournalEntry`     | `wallets/domain/journal-entry.ts`           | Equivalente ao `WalletLedgerEntry`, em partidas dobradas                                                                                                                        |
| `IntegrationEvent` | `shared/domain/events/integration-event.ts` | Base abstrata com `eventType`/`version` e envelope `toJSON()` do §11                                                                                                            |
| `InboxMessage`     | `messaging/domain/inbox-message.ts`         | `record` valida e representa exatamente a linha da inbox (`consumerName`, `messageId`, `payloadHash`, `transactionId`)                                                          |
| `OutboxMessage`    | `messaging/domain/outbox-message.ts`        | `enqueue(event)`/`rehydrate`: identidade, envelope serializado e `attempts`; `retryDelay(options)` calcula o backoff                                                            |

### WagerTransaction

Nasce em `PENDING` (`create`) e expõe transições explícitas: `markProcessed(at, referenceTransactionId?)`, `markPendingReference()`, `reject(code, referenceTransactionId?)`, `fail(code)`, além de `isTerminal()` e
`matchesPayload(hash)`. Uma transição inválida lança `INVALID_TRANSACTION_TRANSITION` (erro de
programação, categoria `internal`). `REJECTED` e `FAILED` exigem `failureCode`; os demais o proíbem.

| De \ Para                                     | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
| --------------------------------------------- | ------------------- | ----------- | ---------- | -------- |
| `PENDING`                                     | sim                 | sim         | sim        | sim      |
| `PENDING_REFERENCE`                           | —                   | sim         | sim        | sim      |
| `PROCESSED`, `REJECTED`, `FAILED` (terminais) | —                   | —           | —          | —        |

A mesma tabela está no trigger `wagering.transaction_transition` (seção 6), então o banco recusa uma
transição inválida mesmo vinda de fora do domínio.

**`FAILED` hoje:** existe no modelo, no `check` de status e no trigger, mas **nenhum fluxo o produz**.
Indisponibilidade nunca vira falha financeira: antes do commit vira 503/retry sem persistir nada;
no SQS, uma falha transitória esgotada vai para a DLQ por redrive, sem criar transação; uma referência
`FAILED` seria tratada como `REJECTED` (`REFERENCE_NOT_PROCESSED`). O estado fica reservado para um
erro permanente auditável que ainda não existe nesta entrega.

### JournalEntry (partidas dobradas)

Uma linha do journal contém as duas partidas: conta debitada, conta creditada, valor positivo e moeda
única, com `balanceBefore`, `balanceAfter` e `walletVersion` da wallet. Um meio par é irrepresentável
([ADR 0012](docs/adr/0012-double-entry-ledger.md)). `create` valida a aritmética
(`before ± amount = after`), que a conta do jogador é uma das partes e que as contas diferem. A
contrapartida é `OPENING` para abertura e `GAMING` para jogos; essas contas não têm saldo
materializado (totais derivados dos lançamentos), o que evita um ponto de serialização global. O
ledger da wallet exigido pelo §6.4 é a view `wagering.wallet_ledger`, que expõe só a partida da
wallet com `direction` `CREDIT`/`DEBIT`. Valor zero, `LOSS` e rejeições não geram lançamento nem
versão nova.

### Eventos

Subclasses de `IntegrationEvent`: `WagerTransactionProcessed` (inclusive LOSS),
`WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` (só quando o
saldo muda, criado a partir do `JournalEntry`). A abertura positiva é uma transação aplicada (§11):
grava `WalletBalanceChanged` (sequência 1) e `WagerTransactionProcessed` (sequência 2). Como `OPENING`
não vem de provedor, o `data` desse resultado é a variante `kind: 'OPENING'` — `transactionId`,
`walletId`, `playerId`, `money`, `balance`, sem `providerId`/`externalTransactionId`/`roundId`/`gameId`.
A subclasse `OpeningTransactionProcessed` fica no módulo de wallets (wagering depende de wallets, não o
inverso) e o consumidor valida cada variante pelo `kind`. O envelope tem `eventId`, `aggregateId` (= walletId),
`correlationId`, `causationId`, `occurredAt`, `eventType`, `version` e `data`, com valores em
`MoneyProps`.

### InboxMessage e OutboxMessage

Adaptam os esqueletos do §6.5 (o desafio permite adaptar assinaturas) e modelam apenas o estado que o banco realmente guarda; a garantia continua no schema e no SQL dos repositórios. A inbox só é gravada no fim da transação financeira, junto do efeito, então não há ciclo de vida recebida → processada em memória: o caso de uso cria `InboxMessage.record({...inbox, transactionId})` dentro da transação, e um redelivery com o mesmo `messageId` e hash diferente é conflito. A outbox é gravada via `OutboxMessage.enqueue(event)` (linha com uma única fonte, inclusive `occurred_at`); o publisher recebe a mensagem reservada e usa `retryDelay` para agendar nova tentativa. Reserva, lease, `SKIP LOCKED`, publicação (`published_at`), `blocked_at` e o vencimento (`next_attempt_at`, no relógio do banco) ficam no SQL e não são espelhados na classe, para não haver estado em memória que diverge do persistido. `fail(code)` existe no `WagerTransaction`, mas nenhum caminho de produção gera `FAILED` hoje.

- **Inbox:** `messaging.command_inbox`, PK `(consumer_name, message_id)`, `request_hash` e
  `transaction_id NOT NULL`. A linha só é inserida no fim da transação financeira bem-sucedida, então
  no banco "recebida" e "processada" coincidem (a tabela tem `received_at`, sem `processed_at`).
- **Outbox:** `wagering.outbox` com `event_id`, `aggregate_id`, `sequence` por wallet, `payload`,
  `attempts`, `next_attempt_at`, `published_at`, `lease_token`/`lease_until`, `blocked_at` e
  `last_error_code`. `retryDelay` usa o backoff compartilhado de `messaging/domain/retry-backoff.ts` (base 1 s, teto 60 s, jitter 50–100%).

## 5. Estratégia transacional e concorrência

**Lock pessimista por wallet** ([ADR 0004](docs/adr/0004-wallet-pessimistic-locking.md)): a unidade de
concorrência é a `walletId`. Escolhido em vez de optimistic locking com retry porque, com várias
instâncias disputando a mesma wallet, as decisões de saldo ficam sequenciais sem tempestade de
retries; o custo (vazão da wallet quente) foi medido (seção 13).

Fluxo de uma submissão nova (HTTP e SQS montam o mesmo `WagerCommand` e chamam o mesmo
`SubmitWagerTransaction`), tudo em **uma** transação:

1. Leitura do recibo por `(providerId, idempotencyKey)` sem lock: mesmo hash → replay; outro → 409.
2. `SELECT … FOR UPDATE` da wallet. É o único lock de saldo.
3. Nova leitura do recibo sob o lock; se a identidade externa já existe com outra chave → 409.
4. Validação de jogador/moeda, resolução da referência e passo do tipo, que decide `PROCESSED`,
   `REJECTED` + `failureCode` ou `PENDING_REFERENCE`.
5. Inserção da transação no estado decidido, `UPDATE` do saldo/versão, journal, recibo, eventos na
   outbox (sequência `max+1` por wallet, segura sob o lock), agenda de referência e, no SQS, a inbox.
6. `COMMIT`, quando as constraints diferidas são verificadas. Só então a resposta HTTP ou o
   `DeleteMessage`. Nenhuma chamada de rede ocorre dentro da transação.

| Controle                  | Valor padrão                           | Onde                                                                                                                                                                                 |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lock_timeout` local      | `FINANCIAL_LOCK_TIMEOUT_MS` = 3 s      | `set_config(..., true)` por transação                                                                                                                                                |
| `statement_timeout` local | `FINANCIAL_STATEMENT_TIMEOUT_MS` = 5 s | idem, reduzido ao tempo restante                                                                                                                                                     |
| Prazo total da operação   | `FINANCIAL_DEADLINE_MS` = 15 s         | inclui retries; esgotado → 503                                                                                                                                                       |
| Retries                   | até 3 tentativas                       | deadlock `40P01`, serialização `40001`, lock timeout `55P03`, statement timeout `57014` e violação das UNIQUE de identidade (a nova tentativa lê o vencedor como replay ou conflito) |

Não há lock global: wallets diferentes não compartilham lock e as contrapartidas são lidas sem lock.
O `reference-worker` adquire o mesmo lock de wallet e revalida tudo sob ele. A correção com múltiplas
instâncias é provada com três processos API e consumidor SQS reais disputando a mesma wallet
([evidência de recuperação](docs/evidence/issue-12/README.md)).

## 6. Garantias no schema

Verificadas em `migrations/`. O papel de runtime `jungle_runtime` não é dono das tabelas
(`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`) e recebe só os grants listados.

| Garantia                                    | Mecanismo                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Uma wallet por jogador e moeda              | `UNIQUE (player_id, currency)` em `wallets`                                                                                                                                                                                                                                                                                                                        |
| Uma abertura por wallet                     | índice único parcial `one_opening_per_wallet` (`kind = 'OPENING'`)                                                                                                                                                                                                                                                                                                 |
| Idempotência e identidade externa           | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`; `request_hash ~ '^[0-9a-f]{64}$'`; `external_identity_complete`: só `OPENING` omite a identidade externa, todo outro tipo a exige completa (NULL não escapa das UNIQUE)                                                                                                 |
| Um lançamento por transação                 | `UNIQUE journal.transaction_id`; FK `(transaction_id, wallet_id, currency, amount)` para a transação                                                                                                                                                                                                                                                               |
| Evento de resultado por transação           | trigger diferido `external_submission_consistency`: recibo para operação externa e evento de resultado (`WagerTransactionProcessed`/`Rejected`/`PendingReference`) para toda transação nesses estados, inclusive `OPENING`                                                                                                                                         |
| Versões de wallet sem duplicata             | `UNIQUE (wallet_id, wallet_version)` no journal                                                                                                                                                                                                                                                                                                                    |
| Uma reversão aplicada por referência e tipo | índice único parcial `one_reversal_per_kind (reference_transaction_id, kind) where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'`                                                                                                                                                                                                                         |
| Não-negatividade                            | domínio `money_amount` (`>= 0`) em `balance`, `amount`, `balance_before`, `balance_after`; `amount > 0` no journal; `check` em `result_balance`                                                                                                                                                                                                                    |
| Partidas válidas                            | `debit_account_id <> credit_account_id`; FKs `(conta, currency)`; trigger diferido `journal_consistency`: jogador é parte, direção compatível com o tipo, contrapartida correta, `before ± amount = after`, cadeia de versões contígua                                                                                                                             |
| Saldo = ledger                              | trigger diferido `wallet_consistency`: saldo e versão da wallet iguais ao último lançamento                                                                                                                                                                                                                                                                        |
| Transação ↔ journal                         | trigger diferido `transaction_consistency`: há lançamento sse `PROCESSED`, não-LOSS e valor > 0                                                                                                                                                                                                                                                                    |
| Recibo e evento obrigatórios                | trigger diferido `external_submission_consistency`: toda transação externa tem recibo, jogador compatível e o evento do seu status na outbox                                                                                                                                                                                                                       |
| Evento de saldo ↔ journal                   | `outbox_consistency` e `journal_consistency`: `WalletBalanceChanged` existe sse há lançamento                                                                                                                                                                                                                                                                      |
| Referência processada                       | trigger diferido `processed_reference_consistency`: contexto, valor, direção do ROLLBACK, BET sem referência, REFUND/ROLLBACK com referência                                                                                                                                                                                                                       |
| Máquina de estados                          | trigger `transaction_transition` (tabela da seção 4); `failure_code` presente sse `REJECTED`/`FAILED`; `processed_at` sse `PROCESSED`; referência resolvida imutável                                                                                                                                                                                               |
| Imutabilidade do ledger                     | triggers `immutable_record` bloqueiam `UPDATE`/`DELETE`/`TRUNCATE` em `journal`, `accounts`, `submission_receipts` e `demo_consumer.event_inbox`; `DELETE`/`TRUNCATE` em `transactions` e `outbox`; o runtime não tem grant de escrita além de `INSERT` nessas tabelas                                                                                             |
| Campos imutáveis                            | `transactions`: grant de `UPDATE` só em `status`, `failure_code`, `processed_at`, `reference_transaction_id`, `result_balance`, e o trigger recusa qualquer outra coluna; `wallets`: grant só em `balance`, `version` + trigger `wallet_identity`; `outbox`: grant só nas colunas de publicação + trigger `outbox_identity` (evento imutável, publicado não volta) |
| Atomicidade da inbox                        | `command_inbox.transaction_id NOT NULL` com FK para a transação                                                                                                                                                                                                                                                                                                    |
| Lease da outbox                             | `check ((lease_token is null) = (lease_until is null))`; `UNIQUE (aggregate_id, sequence)`, `UNIQUE (transaction_id, event_type)`                                                                                                                                                                                                                                  |

As constraints diferidas permitem inserir as linhas interdependentes em qualquer ordem e validar o
conjunto no `COMMIT`; uma transação que deixaria meio efeito financeiro falha inteira.

## 7. Idempotência

- **Escopo por provedor:** `(providerId, idempotencyKey)`, no HTTP e no SQS
  ([ADR 0008](docs/adr/0008-provider-scoped-idempotency.md)). O header `Idempotency-Key` é obrigatório
  (1–128 caracteres) e nunca é substituído por uma chave calculada.
- **Hash do payload** (`wagerPayloadHash`): SHA-256 hex de `JSON.stringify` de um objeto com chaves
  ordenadas recursivamente (sem espaços), contendo exatamente `providerId`, `externalTransactionId`,
  `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`{amount, currency}` normalizado por
  `Money.toProps()`) e, só quando presente, `referenceExternalTransactionId`. Ficam de fora a chave,
  correlação, timestamps e IDs de transporte.
- **Replay vs conflito:** mesma chave + mesmo hash → replay sem efeito; mesma chave + outro hash →
  409 `IDEMPOTENCY_CONFLICT`; mesma operação externa com outra chave → 409
  `EXTERNAL_TRANSACTION_CONFLICT` ([ADR 0006](docs/adr/0006-external-operation-key-conflict.md)).
- **Recibo imutável:** `submission_receipts` guarda status HTTP (200/202/422) e corpo da primeira
  submissão aceita. O replay devolve esse recibo, inclusive o saldo observado na época, mudando só
  `idempotentReplay: true`. Um 202 continua 202 depois que a operação conclui; os GET mostram o estado
  atual ([ADR 0007](docs/adr/0007-stable-submission-receipt.md)).
- **Erros antes do aceite não consomem a chave:** 400/403/404/409/503 não persistem nada; o provedor
  pode repetir a mesma chave depois de um 503.
- **Inbox SQS:** hash = SHA-256 de `[payloadHash, idempotencyKey]`. O mesmo `messageId` com outro
  conteúdo é `INBOX_CONFLICT` e vai para a DLQ. A deduplicação FIFO do SQS é só otimização; os testes
  variam o ID de transporte para que as duplicatas cheguem à aplicação.

Não há cache em memória: toda decisão de idempotência vem do banco.

## 8. Regras de negócio e referências

| Tipo     | Efeito                | Referência                                                                                               | Regras                                                                           |
| -------- | --------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| BET      | débito                | proibida (400)                                                                                           | `INSUFFICIENT_FUNDS` sem saldo                                                   |
| WIN      | crédito               | opcional; se informada, BET `PROCESSED` compatível ([ADR 0017](docs/adr/0017-win-optional-reference.md)) | valor pode diferir da BET; `AMOUNT_LIMIT_EXCEEDED` se o saldo passaria do limite |
| LOSS     | nenhum                | opcional, para BET                                                                                       | registra resultado e `WagerTransactionProcessed`, sem ledger                     |
| REFUND   | crédito               | obrigatória, BET                                                                                         | valor igual                                                                      |
| ROLLBACK | inverso da referência | obrigatória, BET/WIN/REFUND                                                                              | valor igual; `REVERSAL_INSUFFICIENT_FUNDS` se deixaria saldo negativo            |

- A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter o mesmo
  jogador, wallet, moeda e rodada (`REFERENCE_CONTEXT_MISMATCH`); tipo e valor errados são rejeitados
  na hora ([ADR 0010](docs/adr/0010-reference-state-policy.md)). Referenciar a si mesma é 400.
- **Unicidade de reversão por tipo** ([ADR 0009](docs/adr/0009-reversal-uniqueness-by-kind.md)):
  leitura literal do §7.4. REFUND e ROLLBACK da mesma BET são ambos aplicáveis (abertura 100, BET 20,
  REFUND 20, ROLLBACK da BET 20 → saldo 120). Documentado e testado; não afirmamos que seja regra
  universal.
- Valor zero é aceito: gera o evento de resultado, mas não ledger, versão nova nem
  `WalletBalanceChanged`. Abertura zero não cria transação `OPENING`; abertura positiva gera
  `WalletBalanceChanged` e `WagerTransactionProcessed`.

**Referências fora de ordem** ([ADR 0010](docs/adr/0010-reference-state-policy.md),
[ADR 0011](docs/adr/0011-reference-wait-policy.md)):

| Estado da referência                                        | Resultado                                         |
| ----------------------------------------------------------- | ------------------------------------------------- |
| ausente, `PENDING` ou `PENDING_REFERENCE`                   | `PENDING_REFERENCE` (202), reavaliada pelo worker |
| `REJECTED` ou `FAILED`                                      | `REFERENCE_NOT_PROCESSED` imediato                |
| `PROCESSED`                                                 | demais regras e aplicação                         |
| prazo vencido, ausente                                      | `REFERENCE_NOT_FOUND`                             |
| prazo vencido, ainda pendente ou processada depois do prazo | `REFERENCE_NOT_READY`                             |

TTL de 15 min (`REFERENCE_TTL_MS`) desde o primeiro aceite; replays não renovam. Backoff exponencial
de 1 s com teto de 30 s e jitter de 50–100%, limitado ao deadline. Deadline, tentativas e próxima
tentativa ficam em `wagering.reference_retries`, então o worker não guarda estado e sobrevive a
reinícios. **Justificativa do TTL:** é escolha do desafio, não SLA de provedor; cobre atrasos de
entrega e reentregas do SQS com folga, e é configurável (testes e demo usam prazos menores com o mesmo
algoritmo). Falha de infraestrutura não prova ausência: a pendência é adiada sem decisão terminal e o
deadline original continua valendo. Expiração, rejeição e evento são confirmados na mesma transação.

## 9. Taxonomia de `failureCode` e status HTTP

Contrato HTTP na [ADR 0015](docs/adr/0015-http-response-contract.md). Erros têm `code`, `message` e
`correlationId`; rejeições persistidas incluem `transactionId` e `failureCode`. Consultar uma transação
rejeitada retorna 200 com `status: REJECTED`.

**Rejeições de negócio persistidas (422, terminais, replay devolve o mesmo 422):**

| Código                        | Significado                                             | Reenviar?                                             |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `INSUFFICIENT_FUNDS`          | BET maior que o saldo                                   | Não com a mesma chave; nova operação se o saldo mudar |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN/REFUND deixaria saldo negativo          | Não; exige ação operacional                           |
| `AMOUNT_LIMIT_EXCEEDED`       | Crédito passaria do limite de `Money`                   | Não                                                   |
| `REFERENCE_REQUIRED`          | REFUND/ROLLBACK sem referência                          | Corrigir payload (nova chave)                         |
| `REFERENCE_KIND_MISMATCH`     | Tipo de referência não permitido                        | Corrigir payload                                      |
| `REFERENCE_CONTEXT_MISMATCH`  | Jogador, wallet, moeda ou rodada diferentes             | Corrigir payload                                      |
| `REFERENCE_AMOUNT_MISMATCH`   | Valor de REFUND/ROLLBACK diferente da referência        | Corrigir payload                                      |
| `REFERENCE_NOT_PROCESSED`     | Referência `REJECTED`/`FAILED`                          | Desistir                                              |
| `REFERENCE_NOT_FOUND`         | Referência não apareceu até o TTL                       | Desistir ou reconciliar                               |
| `REFERENCE_NOT_READY`         | Referência existia, mas não ficou `PROCESSED` até o TTL | Desistir ou reconciliar                               |
| `ALREADY_REVERSED`            | Referência já revertida por este tipo                   | Desistir                                              |

**Erros de transporte (nada persistido, a chave não é consumida):**

| Status | Códigos                                                                                                      | Reenviar?                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 400    | `INVALID_PAYLOAD`, `PLAYER_MISMATCH`, `CURRENCY_MISMATCH`, `AMOUNT_LIMIT_EXCEEDED` (entrada acima do limite) | Corrigir payload                                                      |
| 401    | `UNAUTHORIZED`                                                                                               | Renovar token                                                         |
| 403    | `FORBIDDEN`, `PROVIDER_IDENTITY_MISMATCH`, `UNKNOWN_PROVIDER`                                                | Não                                                                   |
| 404    | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`                                                                  | Não                                                                   |
| 409    | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS`                             | Não; consultar a operação ou usar a chave original                    |
| 503    | `INFRASTRUCTURE_UNAVAILABLE`                                                                                 | **Sim, com a mesma chave**                                            |
| 500    | `INTERNAL_ERROR`                                                                                             | Repetir a mesma chave; o resultado é resolvido por replay ou consulta |

Sucesso: 201 wallet criada, 200 processada, 202 `PENDING_REFERENCE`. No SQS, a categoria do erro
decide a disposição (seção 10).

## 10. Mensageria

### Comandos SQS ([ADR 0014](docs/adr/0014-sqs-consumer-failures.md))

`wager-transactions.fifo` com `MessageGroupId = walletId` (validado contra o comando). O consumidor
chama o mesmo caso de uso do HTTP e grava a inbox na mesma transação.

| Resultado                                                                                                             | Disposição                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay                                                                  | ack (`DeleteMessage`) **depois** do commit; o worker de referências assume as pendentes e libera o grupo FIFO                                                                |
| Transitório (`unavailable`, `internal`, erro inesperado)                                                              | sem ack; visibilidade devolvida com backoff (base 1 s, teto 30 s, jitter); após `maxReceiveCount` = 5, redrive nativo para a DLQ, sem virar `REJECTED`/`FAILED`              |
| Permanente (payload inválido, provedor desconhecido, wallet inexistente, `INBOX_CONFLICT`, conflitos de idempotência) | envio explícito para `wager-transactions-dlq.fifo` com `originalMessageId`, `transportMessageId`, `reason`, `originalBody`; a origem só é apagada depois do envio confirmado |

Visibilidade de 30 s renovada a cada terço; o processamento é abortado no prazo financeiro. No
SIGTERM o consumidor para de receber, drena por até `COMMAND_DRAIN_MS` (20 s), cancela a query,
aguarda o rollback e só então devolve a visibilidade. A morte entre commit e ack é provada nos testes:
a reentrega vira replay pela inbox. Mensagens SQS não carregam token OAuth; o canal é interno e
confiável, e o processamento valida provedor e relações da operação ([ADR 0003](docs/adr/0003-provider-machine-identity.md)).

### Transactional outbox ([ADR 0013](docs/adr/0013-outbox-persistent-leases.md))

- Eventos são gravados na transação financeira com `sequence` por wallet (independente de
  `wallet.version`, porque LOSS e rejeições também geram eventos). Nada é publicado antes do commit.
- O publisher reserva em transação curta, com `FOR UPDATE SKIP LOCKED`, **só o evento cabeça de cada
  wallet** (menor `sequence` não publicado), gravando `lease_token` e `lease_until` (30 s). Publica em
  `wager-events.fifo` com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`, fora da
  transação. A confirmação só ocorre se o token ainda for dono de uma lease válida.
- Falha transitória: `next_attempt_at` com backoff (1 s → 60 s). Erro de credencial/configuração pausa
  o publisher inteiro. Conteúdo inválido ou acima do tamanho máximo marca `blocked_at`: a cabeça
  bloqueada segura só aquela wallet, e `bun run outbox:retry <eventId>` a reativa. Eventos nunca são
  descartados.
- Publicar duas vezes é possível (falha entre envio e confirmação, lease expirada) e seguro: `eventId`
  estável, inbox persistente no consumidor (`demo_consumer.event_inbox`) e projeção que não regride
  (`greatest(sequence)`). Não há promessa de exactly-once no transporte.
- **Vazão medida:** o índice parcial `outbox_unpublished_by_aggregate (aggregate_id, sequence) where
published_at is null` levou a reserva de 3,3 s para ~10 ms com histórico grande; sem pausa após
  iterações produtivas, uma wallet publica ~96 eventos/s (~48 ops/s, pois cada operação processada
  gera dois eventos) e cenários distribuídos drenam em ~0,1 s
  ([evidência](docs/evidence/issue-27/README.md)). Reservar cadeias por wallet foi adiado com critério
  explícito na ADR 0013.

## 11. Autenticação

Keycloak é o IdP ([ADR 0002](docs/adr/0002-demo-access-boundaries.md),
[ADR 0003](docs/adr/0003-provider-machine-identity.md)). A API verifica RS256, issuer, audience
`jungle-api`, expiração e perfis.

- **Provedores:** Client Credentials, um cliente por provedor ligado a um `providerId` por
  `PROVIDER_CLIENTS`. `providerId` do corpo diferente do token → 403 `PROVIDER_IDENTITY_MISMATCH`,
  sem efeito financeiro. Dois provedores de demonstração testam a separação.
- **Humanos (console):** Authorization Code + PKCE S256, tokens em memória. Perfis verificados no
  backend: `viewer` consulta; `operator` também reconcilia (sem corrigir saldo); `demo-operator` também
  cria wallets e dispara cenários. Os cenários obtêm o token de provedor no servidor, passam pelo mesmo
  endpoint dos provedores e registram o ator humano em `demo.scenario_audit`.

## 12. Observabilidade

Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, mascarando
credenciais, payloads e valores. Métricas Prometheus com labels de cardinalidade limitada: transações
por status (contagem durável do banco), tentativas, duplicatas, retries por componente e motivo, DLQ,
conflitos de lock, latência, backlog e idade da outbox, referências pendentes e divergências de
reconciliação. Dashboard Grafana provisionado. Health separa liveness e readiness (PostgreSQL e SQS).
Detalhes em [docs/observability.md](docs/observability.md) e operação em
[docs/operations.md](docs/operations.md).

## 13. Trade-offs e limitações conhecidas

- **Wallet quente.** O lock por wallet serializa a wallet: ~110–127 ops/s neste host (~8–9 ms por
  transação segurando o lock), e três APIs não aumentam o teto (pioram a cauda). Wallets distribuídas
  escalam: três APIs sustentaram as 500 ops/s oferecidas; o teto com três APIs não foi medido
  ([carga](docs/evidence/issue-13/README.md)).
- **Outbox: um evento por wallet por ciclo de reserva.** Preserva a ordem por agregado, mas limita uma
  wallet a ~96 eventos/s (~48 ops/s). Acima disso, o atraso de publicação daquela wallet cresce. O
  caminho financeiro não é afetado: respostas não esperam a publicação.
- **Reserva da outbox ainda varre os pendentes da wallet** para achar a cabeça (~10 ms com 3 000
  pendentes); provável próximo limite da wallet quente.
- **Reference-worker sem lease.** Cada instância seleciona os N candidatos vencidos mais antigos sem
  lock (`REFERENCE_BATCH_SIZE` = 50). Vários workers disputam os mesmos candidatos e serializam no lock
  da wallet; o perdedor revalida e pula. Correto, mas desperdiça trabalho sob muitas instâncias.
- **SQL explícito em vez de UoW/entidades.** Controle fino e schema como garantia, ao custo de
  mapeamento manual e de não usar UoW, Identity Map e `LockMode` (seção 2).
- **`FAILED` não é produzido** (seção 4). Erros permanentes de transporte vão para a DLQ sem criar
  transação; a investigação parte do diagnóstico da DLQ, não de um registro `FAILED`.
- **Sem expurgo.** Inbox, outbox publicada, recibos e agenda de referências crescem sem retenção.
  Idempotência sem expiração foi decisão desta entrega.
- **SQS emulado.** LocalStack 4.0.3 validado para FIFO, deduplicação, visibilidade e redrive, sem
  provar equivalência total com a AWS. A demo hospedada também usa LocalStack, na rede interna.
- **Um papel de runtime.** API e workers compartilham `jungle_runtime`; logins por processo ficam como
  endurecimento posterior.
- **Medições de carga** num único host WSL2 compartilhado, gerador no mesmo host, só entrada HTTP,
  pool de 5: ordem de grandeza, não previsão de produção ([metodologia](docs/load-testing.md)).
- **Interpretações explícitas:** REFUND + ROLLBACK da mesma BET (ADR 0009), WIN com referência exige
  BET processada (ADR 0017), recibo 202 estável (ADR 0007), LOSS com referência opcional e valor zero.
- **Fora de escopo:** pagamentos reais ([ADR 0001](docs/adr/0001-external-payments-outside-delivery.md)),
  conversão cambial, reversões parciais, OpenTelemetry e multi-tenancy
  ([spec](docs/spec.md#out-of-scope)).

## 14. Índice de ADRs

| ADR                                                         | Decisão                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| [0001](docs/adr/0001-external-payments-outside-delivery.md) | Pagamentos externos fora da entrega                          |
| [0002](docs/adr/0002-demo-access-boundaries.md)             | Perfis do console (viewer, operator, demo-operator)          |
| [0003](docs/adr/0003-provider-machine-identity.md)          | Identidade de máquina por provedor; SQS como canal confiável |
| [0004](docs/adr/0004-wallet-pessimistic-locking.md)         | Lock pessimista por wallet                                   |
| [0005](docs/adr/0005-exact-money.md)                        | Money exato com decimal.js e NUMERIC                         |
| [0006](docs/adr/0006-external-operation-key-conflict.md)    | 409 ao trocar a chave de uma operação existente              |
| [0007](docs/adr/0007-stable-submission-receipt.md)          | Replay devolve o recibo original                             |
| [0008](docs/adr/0008-provider-scoped-idempotency.md)        | Idempotência com escopo por provedor                         |
| [0009](docs/adr/0009-reversal-uniqueness-by-kind.md)        | Unicidade de reversão por referência e tipo                  |
| [0010](docs/adr/0010-reference-state-policy.md)             | Tratamento do estado da referência                           |
| [0011](docs/adr/0011-reference-wait-policy.md)              | TTL e backoff de referências                                 |
| [0012](docs/adr/0012-double-entry-ledger.md)                | Ledger de partidas dobradas                                  |
| [0013](docs/adr/0013-outbox-persistent-leases.md)           | Outbox com leases persistentes e vazão por agregado          |
| [0014](docs/adr/0014-sqs-consumer-failures.md)              | Falhas no consumidor SQS, DLQ e SIGTERM                      |
| [0015](docs/adr/0015-http-response-contract.md)             | Contrato de respostas HTTP                                   |
| [0016](docs/adr/0016-modular-monolith-mikroorm.md)          | Monólito modular com MikroORM                                |
| [0017](docs/adr/0017-win-optional-reference.md)             | Referência opcional em WIN                                   |

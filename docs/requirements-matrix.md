# Matriz de requisitos e evidências

Esta matriz liga cada critério da [especificação](spec.md#matriz-de-requisitos-e-evidências) à
implementação, aos testes que o exercitam e à evidência registrada. **R** é um requisito do
[README original](research/challenge-readme.md). **A** é uma decisão aprovada no grill (spec e
ADRs). **D** é um diferencial opcional escolhido por nós.

Os testes de integração, concorrência e recuperação usam PostgreSQL, LocalStack SQS e Keycloak
reais, com processos reais. Nenhum deles substitui banco ou fila por mocks. A validação desta
entrega a partir de um checkout limpo está em [evidence/issue-14](evidence/issue-14/README.md).

## Requisitos do README (R01–R25)

| ID | Origem | Implementação | Testes | Evidência |
| --- | --- | --- | --- | --- |
| R01 Stack obrigatória | §4 | `package.json` (Bun 1.3.14, Nest 11, MikroORM 6.6), `tsconfig.json` (`strict`), `compose.yaml` (PostgreSQL 16.6, LocalStack 4.0.3) | `bun run build`; `tests/integration/infrastructure.test.ts` | CI; [issue-14](evidence/issue-14/README.md) |
| R02 Migrations reversíveis | §4 | `migrations/Migration2026111*.ts`, `scripts/migrate.ts` | `infrastructure.test.ts`, `*-schema.test.ts`; estágio 1 de `tests/recovery/integrated.test.ts` (todas até zero e de volta) | [issue-12](evidence/issue-12/README.md) |
| R03 Factories, rehydrate e encapsulamento | §6.0 | `shared/domain/money.ts`, `wallets/domain/{wallet,journal-entry}.ts`, `wagering/domain/wager-transaction.ts` | `tests/unit/{money,wallet,journal,wager-transaction}.test.ts` | [ARCHITECTURE](../ARCHITECTURE.md#visão-geral) |
| R04 Dinheiro exato | §§5, 6.1 | `Money` (decimal.js, strings com 2 casas), domínio SQL `wagering.money_amount` | `tests/unit/money.test.ts`; `wallet-schema.test.ts` (0.001, limites) | [ADR 0005](adr/0005-exact-money.md) |
| R05 Wallet única, version 1 e abertura contabilizada | §§6.2, 9 | `Wallet.open`, `wallet-repository.ts`, migration 0002 | `wallet.test.ts`, `wallet-http.test.ts`, `wallet-schema.test.ts` | [issue-3](evidence/issue-3/README.md) |
| R06 BET, WIN e LOSS | §7 | `wagering/domain/wager-step.ts` | `wallet.test.ts`, `settlement.test.ts`, `wagering-http.test.ts`, `settlement-http.test.ts` | [issue-4](evidence/issue-4/README.md), [issue-5](evidence/issue-5.md) |
| R07 Reversões integrais e vínculos | §7 | `wager-step.ts`, índice único parcial e trigger de referência (migration 0004) | `settlement.test.ts` (REFUND/ROLLBACK, `REVERSAL_INSUFFICIENT_FUNDS`), `settlement-http.test.ts`, `tests/concurrency/reversals.test.ts` | [issue-5](evidence/issue-5.md) |
| R08 Estados terminais; OPENING interno | §6.3 | Tabela de transições em `wager-transaction.ts` + trigger SQL | `wager-transaction.test.ts`, `wallet-chain.test.ts` (arestas SQL), `wagering-http.test.ts`, `command-schema.test.ts` | [issue-4](evidence/issue-4/README.md) |
| R09 Idempotência persistente e hash canônico | §§7, 9 | `wager-command.ts` (hash), UNIQUE de identidade, `submission_receipts`, `command_inbox` | `wagering-http.test.ts`, `command-idempotency.test.ts` (HTTP↔SQS cruzados) | [issue-4](evidence/issue-4/README.md), [issue-7](evidence/issue-7/README.md) |
| R10 Recibo original e saldo histórico | §§7, 9 | `submission-receipt.ts`, tabela de recibos imutável | `wagering-http.test.ts` (replay depois de outros débitos e reinício), `pending-references.test.ts` (202 estável) | [ADR 0007](adr/0007-stable-submission-receipt.md) |
| R11 Referências fora de ordem e TTL | §7.1 | `reprocess-references.ts`, `reference-retry.ts`, `reference_retries` (migration 0005) | `reference-retry.test.ts`, `settlement.test.ts`, `pending-references.test.ts`, `command-references.test.ts` | [issue-6](issue-6-evidence.md) |
| R12 Duas BET de 80.00 sobre 100.00 | §8 | Lock `FOR UPDATE` por wallet | `tests/concurrency/bet.test.ts`; estágio HTTP×SQS do roteiro integrado; `test:stack` (cenário `race`) | [issue-12](evidence/issue-12/README.md) |
| R13 Mesma aposta 50× em paralelo | §13 | UNIQUE de identidade + releitura do recibo sob o lock | `bet.test.ts` (50 submissões em 3 PIDs); roteiro integrado (25 HTTP + 25 SQS) | [issue-4](evidence/issue-4/README.md), [issue-12](evidence/issue-12/README.md) |
| R14 ≥3 processos; wallets independentes | §§8, 13 | Processos separados; nenhum lock global | `bet.test.ts`, `command-process.test.ts`, roteiro integrado (3 APIs + consumidor bloqueados ao mesmo tempo) | [issue-12](evidence/issue-12/README.md) |
| R15 Ledger imutável e consistente | §§5, 6.4 | Triggers de imutabilidade e de cadeia, grants do `jungle_runtime` | `wallet-chain.test.ts`, `wallet-schema.test.ts`; `tests/support/ledger-audit.ts` | [issue-9](evidence/issue-9/README.md) |
| R16 Atomicidade de wallet, ledger, inbox, recibo e outbox | §§6.5, 11 | Uma transação em `wagering-repository.ts`; triggers diferidos de outbox e inbox | `command-idempotency.test.ts`; roteiro integrado (falha injetada em cada uma das 6 tabelas) | [issue-12](evidence/issue-12/README.md) |
| R17 Inbox e ack após commit | §10 | `messaging/commands/command-consumer.ts` | `command-process.test.ts` (SIGKILL depois do commit e antes do delete); roteiro integrado | [issue-7](evidence/issue-7/README.md) |
| R18 Retry, DLQ e shutdown | §10 | `command-consumer.ts`, `provision-fifo-with-dlq.ts`, `worker-runtime.ts` | `command-dlq.test.ts`, `sqs-capabilities.test.ts`, `command-process.test.ts` (SIGTERM sob lock) | [issue-7](evidence/issue-7/README.md) |
| R19 Publishers concorrentes e recuperação | §11 | `messaging/outbox/*` (SKIP LOCKED, lease, token) | `outbox.test.ts` (2 processos, SIGKILL antes e depois do envio); roteiro integrado | [issue-8](evidence/issue-8/README.md) |
| R20 Eventos mínimos e envelope | §11 | `shared/domain/events/integration-event.ts`, `wager-events.ts`, `wallet-balance-changed.ts` | `wager-transaction.test.ts`, `wallet.test.ts`, `outbox-policy.test.ts`, `outbox.test.ts` | [issue-8](evidence/issue-8/README.md) |
| R21 Endpoints e paginação | §9 | `wallets.module.ts`, `wagering.module.ts`, cursores opacos | `wallet-http.test.ts`, `wagering-http.test.ts`, `identity.test.ts` | [ADR 0015](adr/0015-http-response-contract.md) |
| R22 Reconciliação sem correção silenciosa | §9 | `wallets/application/wallets.ts` (snapshot, log, métrica) | `wallet-http.test.ts` (divergência injetada em banco descartável) | [issue-9](evidence/issue-9/README.md) |
| R23 Logs, métricas e health | §12 | `observability/*`, observers por módulo, dashboard Grafana | `logger.test.ts`, `health.test.ts`, `identity.test.ts`, `metrics-network.test.ts`, asserções de métricas em `wallet-http`/`command-dlq` | [issue-11](evidence/issue-11/README.md) |
| R24 Reinício e consistência final | §13 | Estado de retry e lease persistido; workers sem estado | `bet.test.ts` (replay após reinício); estágio final do roteiro integrado (todas as wallets reconciliadas) | [issue-12](evidence/issue-12/README.md) |
| R25 Documentação reproduzível | §14 | README, ARCHITECTURE, esta matriz, [operations.md](operations.md) | Execução de checkout limpo | [issue-14](evidence/issue-14/README.md) |

## Diferenciais escolhidos (D01–D05)

| ID | Origem | Implementação | Testes | Evidência |
| --- | --- | --- | --- | --- |
| D01 Partidas dobradas | §6.4 + A | Journal de uma linha (par débito/crédito) e contas de contrapartida | `journal.test.ts`, `wallet-chain.test.ts`, `ledger-audit.ts` | [ADR 0012](adr/0012-double-entry-ledger.md) |
| D02 Keycloak e perfis | §2 + A | `identity/identity.module.ts`, `infra/keycloak/jungle-realm.json` | `identity.test.ts`, `wallet-http.test.ts`, `demo.test.ts` (401/403, provedor alheio, ownership) | [ADR 0002](adr/0002-demo-access-boundaries.md), [ADR 0003](adr/0003-provider-machine-identity.md) |
| D03 Console | A | `frontend/*`, `modules/demo/*` | `tests/integration/console.test.ts` (navegador), `demo.test.ts`, `tests/stack/demo-stack.test.ts` | [issue-10](evidence/issue-10/README.md) |
| D04 Teste de carga | §14 + A | `scripts/test-load.ts`, `tests/load/*` | `load-*.test.ts` (unidade), `load-smoke.test.ts` | [issue-13](evidence/issue-13/README.md) |
| D05 Demonstração hospedada e vídeo | A | [deploy/hosted/](../deploy/hosted/README.md), [roteiro](demo-script.md) | `test:stack` sobre HTTPS no stack hospedado local | [issue-14](evidence/issue-14/README.md). A publicação depende das decisões listadas em [submission.md](submission.md) |

## Falhas eliminatórias (§14)

| Falha | Situação | Onde verificar |
| --- | --- | --- |
| `number` para dinheiro | Ausente | `Money`/decimal.js; domínio SQL `money_amount`; `money.test.ts` |
| Saldo negativo por race | Ausente | Lock por wallet + `money_amount ≥ 0`; `bet.test.ts`; roteiro integrado |
| Débito ou crédito duplicado | Ausente | UNIQUE de identidade e de `journal.transaction_id`; 50× paralelas; auditoria de carga com 12/12 cenários ok |
| Idempotência só em memória | Ausente | Recibos, inbox e UNIQUE no PostgreSQL; replay depois de reinício |
| Correto só com uma instância | Ausente | 3 APIs + consumidores no roteiro integrado e na carga com 3 instâncias |
| Evento publicado antes do commit | Ausente | Outbox na transação; envio só no publisher; roteiro integrado |
| Ledger não auditável | Ausente | Journal imutável por trigger e grants; reconciliação; `ledger-audit.ts` |
| Testes só com mocks de PostgreSQL/SQS | Ausente | Todas as suítes de integração usam containers reais |

A revisão independente desta entrega está em [evidence/issue-14](evidence/issue-14/README.md#revisão-final).

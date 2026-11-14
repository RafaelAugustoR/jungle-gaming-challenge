# Issue #27 — vazão de publicação da outbox por wallet

A carga da [#13](../issue-13/README.md) mostrou a outbox publicando ~1,7 eventos/s
na wallet quente. O [#28](https://github.com/RafaelAugustoR/jungle-gaming-challenge/pull/28)
removeu a pausa de `OUTBOX_POLL_MS` após iterações produtivas, mas a wallet quente só
foi para ~2,8 eventos/s. Esta issue investigou o restante e registrou a decisão sobre
reservar cadeias por agregado na [ADR 0013](../../adr/0013-outbox-persistent-leases.md).

## Causa: a consulta de reserva, não a política

A seleção das cabeças (`PUBLISHABLE_HEADS` em `src/messaging/outbox/outbox-repository.ts`)
verifica, para cada evento pendente, se existe um evento anterior não publicado no mesmo
agregado. O índice único `(aggregate_id, sequence)` encontra os anteriores, mas o filtro
`published_at is null` era aplicado linha a linha sobre todo o histórico já publicado.

`explain-claim.ts` reproduz o cenário num banco descartável: uma wallet com 3 000 BETs
(6 001 eventos), metade publicada, mais 20 wallets pequenas.

| | Tempo da reserva | Buffers | Probe por evento pendente |
| --- | --- | --- | --- |
| Antes (sem índice parcial) | 3 287 ms | 14,2 milhões | ~2 980 linhas publicadas descartadas, 3 021 vezes |
| Com `outbox_unpublished_by_aggregate` | ~10 ms | ~10 mil | 1 entrada do índice parcial |

```sh
bun docs/evidence/issue-27/explain-claim.ts 3000 0.5         # baseline: remove o índice
bun docs/evidence/issue-27/explain-claim.ts 3000 0.5 index   # com o índice
```

A correção é a migration reversível `Migration202611150010`: índice parcial
`(aggregate_id, sequence) where published_at is null`. Não muda semântica, ordem,
leases nem deduplicação. O teste de integração
`claiming a head does not rescan the published history of a deep single-wallet backlog`
mede buffers do `EXPLAIN ANALYZE` da consulta real (300 publicados + 301 pendentes numa
wallet): 51 284 buffers sem o índice (falha, limite 20 000), poucos milhares com ele.

## Carga: A/B intercalado `main` × índice

`bun run test:load --scenarios hot-wallet,distributed --instances 1 --rate 100
--duration 15 --warmup 3 --outbox-drain-timeout 10000`, alternando `main` (`1f8f0e4`,
já com o #28) e este branch (`5193a78`) três vezes. Resumos, ambiente e relatório de cada
rodada estão em [`ab/`](ab/); `ab/host.log` registra o load average antes de cada uma.

| 1 API, 100 ops/s | `main` (3 rodadas) | Com índice (3 rodadas) |
| --- | --- | --- |
| Wallet quente: concluídas/s | 100 / 100 / 100 | 100 / 100 / 100 |
| Wallet quente: p50 ms | 10,8 / 27,9 / 11,1 | 10,9 / 10,7 / 11,3 |
| Wallet quente: p99 ms | 18 / 423 / 77 | 17 / 16 / 177 |
| Wallet quente: publicados/s na drenagem | 5,7 / 5,8 / 5,3 | 96,2 / 97,5 / 95,8 |
| Wallet quente: backlog máx. / idade máx. | ~3 080 / 15,2–15,5 s | ~1 790–1 910 / 9,0–9,6 s |
| Distribuído: p50 ms | 10,9 / 10,9 / 10,9 | 11,3 / 11,3 / 11,1 |
| Distribuído: drenagem após a carga | ~0,1 s | 0,1–0,2 s |

Invariantes e auditoria do ledger: 12/12 ok, zero erros técnicos. A vazão financeira e a
p50 são iguais nos dois lados; a p99 da wallet quente oscila nos dois sem direção (uma
rodada ruim em cada), o que é ruído do host. Na wallet quente, a publicação ficou ~17
vezes mais rápida.

**Limite que permanece:** uma wallet a 100 ops/s produz ~200 eventos/s (dois por
operação processada), acima dos ~96 eventos/s de uma cabeça por ciclo. O atraso só deixa
de crescer abaixo de ~48 ops/s numa única wallet. Reservar cadeias resolveria isso, mas
muda a ADR 0013; a decisão de não fazer agora, com o critério para revisitar, está
registrada na ADR.

## Cuidados com a medição

Uma primeira medição feita neste branch sugeriu regressão no caminho financeiro (wallet
quente a 84–88 ops/s). Um A/B contra `main` mostrou a mesma queda sem o índice: outra
sessão rodava `test:integration` e outro projeto Compose na mesma máquina. Os números
acima vêm de uma janela sem outras suítes em execução; os containers ociosos de outros
projetos continuaram ativos com baixo consumo, e o desenho intercalado distribui esse
ruído igualmente entre os dois lados.

Ainda não tratado: a parte externa da reserva varre a tabela inteira de outbox a cada
ciclo, inclusive eventos publicados, e não há expurgo. O custo cresce com o histórico;
está registrado na ADR 0013 para avaliar junto de uma política de retenção.

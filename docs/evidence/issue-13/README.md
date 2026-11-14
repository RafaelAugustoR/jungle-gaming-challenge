# Issue #13 — carga e limites

Requisito D04 da [spec](../../spec.md): `bun run test:load` com três cenários,
uma e três instâncias, ambiente, throughput, p50/p95/p99, erros, locks, lag e
limitações do gerador. Metodologia, opções e limitações do gerador estão em
[load-testing.md](../../load-testing.md). Não há meta de RPS: as taxas vieram de uma
sondagem prévia (100/300/600 ops/s), e 100 e 500 ficam abaixo e acima da saturação
observada com uma instância.

## Reproduzir

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres sqs keycloak
docker compose run --rm provision
bun run test:load --out artifacts/load/evidence
```

Execução registrada: commit `c325da3`, árvore limpa, 2026-11-14, seed `20261113`,
5 s de aquecimento + 30 s medidos por combinação, 100 wallets nos cenários
distribuídos, até 256 requisições em voo no gerador. Duração total ≈ 15 min.

## Ambiente

AMD Ryzen 7 7700 (16 núcleos lógicos), WSL2 Linux 6.6 com 23,5 GiB atribuídos;
Bun 1.3.14; PostgreSQL 16.6 (`max_connections=100`, `shared_buffers=128MB`),
LocalStack 4.0.3 e Keycloak 26.0.7 do Compose. Pool de 5 conexões por processo
API, lock timeout 3 s, statement timeout 5 s, um `outbox-publisher` com os padrões
de produção (lote 20, poll 500 ms). Gerador, APIs e dependências no mesmo host;
pico de memória usada no WSL durante a execução: ~11,4 GB.

## Resultados brutos

[`run/`](run/) contém o `report.md` gerado, `summary.json`, `environment.json` e,
por combinação, `run.json`, `requests.ndjson.gz` (uma linha por operação agendada:
instância, fase, horários agendado/enviado/concluído, status HTTP, resultado,
código de falha) e `db-samples.ndjson.gz` (amostras de 200 ms de locks e outbox).

## Resumo (janela medida, aquecimento excluído)

| Cenário | ops/s oferecidas | APIs | Concluídas/s | Não emitidas | p50 ms | p95 ms | p99 ms | Erros |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hot-wallet | 100 | 1 | 100,0 | 0 | 10 | 13 | 18 | 0 |
| hot-wallet | 100 | 3 | 100,0 | 0 | 12 | 20 | 48 | 0 |
| hot-wallet | 500 | 1 | 113,2 | 11 376 | 2 098 | 2 233 | 2 291 | 0 |
| hot-wallet | 500 | 3 | 110,2 | 11 472 | 2 140 | 3 039 | 3 133 | 0 |
| distributed | 100 | 1 | 100,0 | 0 | 11 | 16 | 31 | 0 |
| distributed | 100 | 3 | 100,0 | 0 | 12 | 15 | 16 | 0 |
| distributed | 500 | 1 | 387,8 | 3 131 | 632 | 752 | 846 | 0 |
| distributed | 500 | 3 | 499,7 | 0 | 14 | 24 | 39 | 0 |
| duplicates | 100 | 1 | 100,0 | 0 | 11 | 16 | 23 | 0 |
| duplicates | 100 | 3 | 100,0 | 0 | 11 | 15 | 18 | 0 |
| duplicates | 500 | 1 | 407,2 | 2 552 | 595 | 764 | 803 | 0 |
| duplicates | 500 | 3 | 499,8 | 0 | 12 | 18 | 50 | 0 |

"Erros" é toda requisição emitida sem resultado de negócio (5xx, 4xx inesperado,
409, 202, timeout ou falha de transporte), a mesma definição da taxa de erro.
Rejeições de negócio (`INSUFFICIENT_FUNDS` das BET deliberadamente impossíveis)
aparecem separadas em todas as execuções (39–273 por janela) e nunca contam como
erro. Nenhuma execução teve erro técnico, conflito de lock
(`wallet_lock_conflicts_total`) ou retry financeiro.

**Reconciliação e invariantes: 12/12 ok.** Todas as wallets reconciliadas pela API
com saldo armazenado = saldo do ledger = saldo esperado pelo cliente; transações =
operações únicas aplicadas; journal = aberturas + processadas; nenhuma operação com
dois resultados de primeira submissão; nenhuma BET impossível processada. A auditoria
compartilhada com o roteiro de recuperação (`tests/support/ledger-audit.ts`) zerou
em todas: pares válidos, nenhum efeito financeiro parcial, exatamente um recibo por
transação, nenhuma transação pendente e um conjunto de eventos por transação. Nos
cenários de duplicatas, 927 (100 ops/s) e 3 252–4 489 (500 ops/s) replays não
criaram nenhum efeito financeiro.

### Variação entre execuções

Uma execução completa anterior, com o mesmo seed e as mesmas opções (commit
`3987889`, antes da refatoração do harness pedida na revisão), mediu tetos de 10 a
20% maiores com uma API: 126,8 contra 113,2 ops/s na wallet quente, 422,9 contra
387,8 no cenário distribuído, e 495,6 (129 não emitidas) contra 407,2 (2 552 não
emitidas) com duplicatas. A refatoração não mudou o caminho da requisição. Neste
host compartilhado, os tetos devem ser lidos como ordem de grandeza: as conclusões
abaixo são as que se repetiram nas duas execuções.

## Gargalos observados

### 1. Wallet quente: lock por wallet serializa, mais instâncias não ajudam

Teto observado de ~110–127 ops/s em uma wallet nas duas execuções, cerca de 8–9 ms
por transação financeira segurando o lock da linha (ADR 0004). Com três APIs o
throughput não aumentou (110,2 contra 113,2 ops/s) e a cauda piorou (p95 3 039
contra 2 233 ms a 500 ops/s; p99 48 contra 18 ms a 100 ops/s): mais conexões
disputam o mesmo lock sem mais trabalho útil. As amostras mostram a fila de lock
limitada pelo pool: média de 3,69 backends esperando lock com uma API (máx. 4 =
pool − 1) e 13,69 com três (máx. 14 = 15 − 1). O restante espera no pool da
aplicação, por isso a espera mais antiga no PostgreSQL ficou em 44–163 ms, longe do
lock timeout de 3 s.

Na saturação, a latência é dada pela fila do gerador, não pelo sistema: pela lei
de Little, 256 em voo ÷ ~112 ops/s ≈ 2,3 s, próximo do p50 medido. O excedente
(~11 mil operações) foi registrado como não emitido em vez de mascarar a taxa
oferecida. Um gerador com limite maior de requisições em voo aumentaria a latência
e poderia levar esperas além do lock timeout, retornando 503
`INFRASTRUCTURE_UNAVAILABLE`. Isso não foi observado nesta configuração e não deve
ser presumido em outra.

### 2. Wallets distribuídas: uma API para no pool; três sustentam a taxa oferecida

Uma API concluiu 387,8 ops/s (422,9 na execução anterior) com p50 de 632 ms: 5
conexões ÷ ~12–13 ms por operação ≈ 400 ops/s, e o excedente fica em fila no pool
(256 ÷ 388 ≈ 0,66 s). Três APIs sustentaram as 500 ops/s oferecidas com p99 de
39 ms e carga igual entre instâncias (5 000 cada, p95 24–25 ms). Esperas de lock
ficaram praticamente em zero, o que mostra que não há serialização global entre
wallets. O teto com três instâncias **não foi medido**: só se sabe que é maior que
500 ops/s neste host. O ganho não é linear por construção (PostgreSQL, CPU e
gerador são compartilhados) e não deve ser extrapolado.

### 3. Duplicatas: replay é barato, mas disputa o mesmo pool

Sem saturação, replays resolvem pelo recibo antes de reservar a identidade: p50 de
~3,5 ms contra ~12 ms de operações novas. Na saturação de uma API (500 ops/s), os
dois ficaram em ~590 ms de p50, porque o replay também espera uma conexão do pool.
A deduplicação não alivia uma instância saturada: com uma API o cenário saturou em
407 ops/s e 2 552 operações não foram emitidas. Com três APIs, 500 ops/s com p99 de
50 ms e replays com p50 de 3,8 ms.

### 4. Outbox: publicação muito abaixo da produção de eventos

É o principal limite medido. Cada operação processada gera dois eventos e cada
rejeição gera um, ou seja, ~200 eventos/s a 100 ops/s. O publisher publicou ~27–37
eventos/s no total e ~1,7 eventos/s na wallet quente. **Nenhuma execução drenou
a outbox nos 30 s após a carga**, e a idade do evento mais antigo cresceu com a
duração da execução (até ~34 s). Há duas causas independentes no código, e nenhuma
depende do gerador:

1. **Sleep fixo após lote cheio.** `runWorker` dorme `OUTBOX_POLL_MS` (500 ms)
   depois de toda iteração, mesmo quando o lote veio cheio. Isso limita o total a
   `OUTBOX_BATCH_SIZE`/0,5 s = 40 eventos/s. É ajuste no loop do worker: a ADR 0013
   não trata de poll. Corrigido no [PR #28](https://github.com/RafaelAugustoR/jungle-gaming-challenge/pull/28).
2. **Uma cabeça por agregado por iteração.** `OutboxRepository.claim` reserva apenas
   o evento cabeça de cada wallet, para preservar a ordem por agregado. Com o sleep
   atual, uma wallet publica no máximo ~2 eventos/s; sem ele, continua limitada a um
   evento por ciclo de reserva, envio e confirmação. Reservar cadeias por agregado
   muda a ADR 0013 e foi avaliado na [issue #27](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/27): o custo real era a consulta de reserva (corrigido por índice parcial) e a reserva de cadeias ficou registrada como decisão adiada na ADR 0013 ([evidência](../issue-27/README.md)).

O caminho financeiro não é afetado (respostas não esperam a publicação e as
invariantes passaram), mas consumidores de eventos veem atraso crescente sob carga
sustentada. Um segundo publisher aumentaria o teto global com `skip locked`, sem
ajudar a wallet quente; isso não foi medido.

## Limitações desta medição

Todas as limitações do gerador em [load-testing.md](../../load-testing.md) se
aplicam: host único compartilhado, um processo gerador, latência medida no cliente,
amostragem de 200 ms, round-robin no cliente sem load balancer e somente entrada
HTTP. Os números valem para este host e esta configuração (pool 5, um publisher,
WSL2) e não são previsão de produção. A taxa de 500 ops/s não é meta: é um ponto
acima da saturação observada com uma instância.

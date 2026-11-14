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

Execução registrada: commit `3987889`, árvore limpa, 2026-11-14, seed `20261113`,
5 s de aquecimento + 30 s medidos por combinação, 100 wallets nos cenários
distribuídos, até 256 requisições em voo no gerador. Duração total ≈ 15 min.

## Ambiente

AMD Ryzen 7 7700 (16 núcleos lógicos), WSL2 Linux 6.6 com 23,5 GiB atribuídos;
Bun 1.3.14; PostgreSQL 16.6 (`max_connections=100`, `shared_buffers=128MB`),
LocalStack 4.0.3 e Keycloak 26.0.7 do Compose. Pool de 5 conexões por processo
API, lock timeout 3 s, statement timeout 5 s, um `outbox-publisher` com os padrões
de produção (lote 20, poll 500 ms). Gerador, APIs e dependências no mesmo host;
pico de memória usada no WSL durante a execução: ~12 GB.

## Resultados brutos

[`run/`](run/) contém o `report.md` gerado, `summary.json`, `environment.json` e,
por combinação, `run.json`, `requests.ndjson.gz` (uma linha por operação agendada:
instância, fase, horários agendado/enviado/concluído, status HTTP, resultado,
código de falha) e `db-samples.ndjson.gz` (amostras de 200 ms de locks e outbox).

## Resumo (janela medida, aquecimento excluído)

| Cenário | ops/s oferecidas | APIs | Concluídas/s | Não emitidas | p50 ms | p95 ms | p99 ms | Erros |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hot-wallet | 100 | 1 | 100,0 | 0 | 10 | 14 | 20 | 0 |
| hot-wallet | 100 | 3 | 100,0 | 0 | 11 | 15 | 32 | 0 |
| hot-wallet | 500 | 1 | 126,8 | 10 964 | 1 884 | 2 042 | 2 051 | 0 |
| hot-wallet | 500 | 3 | 121,5 | 11 123 | 1 825 | 2 863 | 2 983 | 0 |
| distributed | 100 | 1 | 100,0 | 0 | 10 | 13 | 15 | 0 |
| distributed | 100 | 3 | 100,0 | 0 | 11 | 14 | 15 | 0 |
| distributed | 500 | 1 | 422,9 | 2 055 | 587 | 643 | 678 | 0 |
| distributed | 500 | 3 | 499,9 | 0 | 12 | 21 | 28 | 0 |
| duplicates | 100 | 1 | 100,0 | 0 | 9 | 12 | 14 | 0 |
| duplicates | 100 | 3 | 100,0 | 0 | 10 | 14 | 15 | 0 |
| duplicates | 500 | 1 | 495,6 | 129 | 25 | 541 | 598 | 0 |
| duplicates | 500 | 3 | 499,8 | 0 | 10 | 17 | 24 | 0 |

Rejeições de negócio (`INSUFFICIENT_FUNDS` das BET deliberadamente impossíveis)
aparecem separadas em todas as execuções (52–273 por janela) e nunca contam como
erro. Nenhuma execução teve erro técnico, conflito, pendência, conflito de lock
(`wallet_lock_conflicts_total`) ou retry financeiro.

**Reconciliação e invariantes: 12/12 ok.** Todas as wallets reconciliadas pela API
com saldo armazenado = saldo do ledger = saldo esperado pelo cliente; transações =
operações únicas aplicadas; journal = aberturas + processadas; pares válidos; um
conjunto de eventos por transação; nenhuma operação com dois resultados de primeira
submissão; nenhuma BET impossível processada. Nos cenários de duplicatas, 927
(100 ops/s) e ~4 450 (500 ops/s) replays não criaram nenhum efeito financeiro.

## Gargalos observados

### 1. Wallet quente: lock por wallet serializa, mais instâncias não ajudam

Teto observado de ~122–127 ops/s em uma wallet, cerca de 8 ms por transação
financeira segurando o lock da linha (ADR 0004). Com três APIs o throughput não
aumentou (121,5 contra 126,8 ops/s) e a cauda piorou (p95 2 863 contra 2 042 ms a
500 ops/s; p99 32 contra 20 ms a 100 ops/s): mais conexões disputam o mesmo lock
sem mais trabalho útil. As amostras mostram a fila de lock limitada pelo pool:
média de 3,76 backends esperando lock com uma API (máx. 4 = pool − 1) e 13,73 com
três (máx. 14 = 15 − 1). O restante espera no pool da aplicação, por isso a espera
mais antiga no PostgreSQL ficou em 124–164 ms, longe do lock timeout de 3 s.

Na saturação, a latência é dada pela fila do gerador, não pelo sistema: pela lei
de Little, 256 em voo ÷ ~125 ops/s ≈ 2 s, que é o p50 medido. O excedente (~11 mil
operações) foi registrado como não emitido em vez de mascarar a taxa oferecida.
Um gerador com limite maior de requisições em voo aumentaria a latência e poderia
levar esperas além do lock timeout, retornando 503 `INFRASTRUCTURE_UNAVAILABLE`.
Isso não foi observado nesta configuração e não deve ser presumido em outra.

### 2. Wallets distribuídas: uma API para no pool; três sustentam a taxa oferecida

Uma API concluiu 422,9 ops/s com p50 de 587 ms: 5 conexões ÷ ~12 ms por operação
≈ 420 ops/s, e o excedente fica em fila no pool (256 ÷ 423 ≈ 0,6 s). Três APIs
sustentaram as 500 ops/s oferecidas com p99 de 28 ms e carga igual entre
instâncias (5 000 cada, p95 21–22 ms). Esperas de lock ficaram praticamente em
zero, o que mostra que não há serialização global entre wallets. O teto com três
instâncias **não foi medido**: só se sabe que é maior que 500 ops/s neste host.
O ganho não é linear por construção (PostgreSQL, CPU e gerador são compartilhados)
e não deve ser extrapolado.

### 3. Duplicatas: deduplicação mais barata que processamento

Replays resolvem pelo recibo antes de reservar a identidade: p50 de 2,6–3,2 ms
contra 10–11 ms de operações novas sem saturação. Por isso, a 500 ops/s com 30% de
replays, uma API quase acompanhou a taxa (495,6 ops/s, 129 não emitidas) enquanto o
cenário distribuído sem replays saturou em 423. Com uma API o p95 subiu para 541 ms
(fila no pool); com três ficou em 17 ms.

### 4. Outbox: publicação muito abaixo da produção de eventos

É o principal limite medido. Cada operação processada gera dois eventos e cada
rejeição gera um, ou seja, ~200 eventos/s a 100 ops/s. O publisher publicou ~26–36
eventos/s no total e ~1,3–1,7 eventos/s na wallet quente. **Nenhuma execução drenou
a outbox nos 30 s após a carga**, e a idade do evento mais antigo cresceu com a
duração da execução (~33 s). Há duas causas independentes no código, e nenhuma
depende do gerador:

1. **Sleep fixo após lote cheio.** `runWorker` dorme `OUTBOX_POLL_MS` (500 ms)
   depois de toda iteração, mesmo quando o lote veio cheio. Isso limita o total a
   `OUTBOX_BATCH_SIZE`/0,5 s = 40 eventos/s. É ajuste no loop do worker: a ADR 0013
   não trata de poll. Será corrigido num PR pequeno separado, antes da entrega.
2. **Uma cabeça por agregado por iteração.** `OutboxRepository.claim` reserva apenas
   o evento cabeça de cada wallet, para preservar a ordem por agregado. Com o sleep
   atual, uma wallet publica no máximo ~2 eventos/s; sem ele, continua limitada a um
   evento por ciclo de reserva, envio e confirmação. Reservar cadeias por agregado
   muda a ADR 0013 e está na [issue #27](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/27).

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

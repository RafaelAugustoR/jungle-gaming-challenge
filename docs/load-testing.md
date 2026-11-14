# Experimento de carga

Plano aprovado no grill em 2026-11-11 e implementado na Issue #13 como `bun run test:load`, usando Bun e a infraestrutura real do desafio. Resultados e análise da execução registrada: [evidências da Issue #13](evidence/issue-13/README.md).

## Cenários

Comparar uma e três instâncias da aplicação em cada cenário:

1. `hot-wallet` — muitas operações na mesma wallet: contenção, espera por lock e correção do saldo.
2. `distributed` — operações distribuídas entre wallets (padrão 100): processamento paralelo.
3. `duplicates` — wallets distribuídas com 30% de reenvios (mesma chave e corpo) de uma das 20 operações originais mais recentes, normalmente enviados a outra instância enquanto o original ainda pode estar em andamento: custo da deduplicação e ausência de efeitos financeiros repetidos.

O plano de cada cenário é determinístico por `--seed`: wallet, tipo, valor, IDs externos e chaves de idempotência são gerados por PRNG (mulberry32), sem `Math.random`. Operações são BET (1.00–20.00) e WIN sem referência (1.00–30.00) na proporção 70/30, com abertura de 1 000 000.00 por wallet para que o saldo nunca acabe por acaso. Uma fração configurável de BET (padrão 2%) usa um valor maior que qualquer saldo alcançável: são **rejeições de negócio conhecidas antes da execução** (`INSUFFICIENT_FUNDS`), separadas de erros técnicos.

## Executar

Pré-requisitos iguais aos de `test:recovery`: `.env` configurado e PostgreSQL, LocalStack e Keycloak do Compose prontos.

```sh
docker compose up -d --wait postgres sqs keycloak
docker compose run --rm provision
bun run test:load                       # padrão: 3 cenários × 1/3 APIs × 100 e 500 ops/s
bun run test:load --rate 200 --duration 60 --warmup 10 --scenarios hot-wallet --instances 1,3
```

| Opção | Padrão | Significado |
| --- | --- | --- |
| `--scenarios` | `hot-wallet,distributed,duplicates` | Cenários executados. |
| `--instances` | `1,3` | Quantidade de processos API por execução. |
| `--rate` | `100,500` | Taxa oferecida em ops/s; lista executa uma varredura. |
| `--duration` / `--warmup` | `30` / `5` | Segundos medidos e de aquecimento (excluído das estatísticas, incluído na reconciliação). |
| `--seed` | `20261113` | Semente do plano reproduzível. |
| `--wallets` / `--opening` | `100` / `1000000` | Wallets dos cenários distribuídos e abertura de cada uma. |
| `--oversized-ratio` | `0.02` | Fração de BET deliberadamente impossíveis. |
| `--duplicate-ratio` / `--duplicate-window` | `0.3` / `20` | Fração de reenvios e janela de originais recentes. |
| `--max-in-flight` | `256` | Limite de concorrência do gerador; excedentes são registrados como não emitidos. |
| `--request-timeout` | `20000` | Timeout HTTP por requisição (acima do prazo financeiro de 15 s). |
| `--sample-ms` | `200` | Intervalo de amostragem do PostgreSQL. |
| `--outbox-drain-timeout` | `30000` | Espera pela drenagem da outbox depois da carga. |
| `--out` | `artifacts/load/<timestamp>` | Diretório de resultados. |

O comando retorna código diferente de zero se qualquer invariante falhar.

## Topologia de cada execução

Cada combinação cenário × instâncias × taxa é isolada: banco descartável migrado do zero, N processos API reais (`createApplication`, cada um com seu pool próprio), um `outbox-publisher` de produção com padrões de produção e filas SQS exclusivas. Wallets são criadas pela API com perfil demo-operator e a carga usa o token de máquina de `provider-a`. Não há load balancer: o gerador distribui por round-robin pelo índice da operação, e o relatório mostra quantas requisições cada instância recebeu.

## Metodologia e evidências

- **Modelo aberto**: a operação *i* está agendada para *i/taxa*, independentemente das respostas anteriores. Respostas lentas aparecem como latência, backlog após a janela ou requisições não emitidas (limite `--max-in-flight`), nunca como redução silenciosa da taxa oferecida. O atraso de agendamento (envio real − agendado) é registrado por requisição.
- **Classificação**: `processed` (200), `rejected` (422 com `failureCode`), `replay` (`idempotentReplay: true`), `pending` (202), `conflict` (409) e `error` (5xx, 4xx inesperado, timeout ou falha de transporte). Rejeições e replays não são erros; *Financial/s* conta apenas primeiras submissões que chegaram a resultado terminal.
- **Latência** p50/p95/p99/máx por rank mais próximo, do envio à resposta, apenas na janela medida; também por resultado e por instância.
- **Contenção**: amostras de `pg_stat_activity` (backends esperando lock pesado, espera mais antiga, backends ativos) e deltas por processo de `wallet_lock_conflicts_total` e `jungle_retries_total{component="financial"}` lidos de `/internal/metrics` antes e depois.
- **Outbox lag**: pendentes e idade do evento mais antigo não publicado durante a carga; depois da última resposta, tempo até drenar (ou backlog restante no timeout) e taxa de publicação observada.
- **Reconciliação e invariantes** ao fim de cada execução: o estado final de cada operação única vem de qualquer resposta definitiva (original ou replay) ou, se incerto, da consulta pela identidade externa. O saldo esperado de cada wallet é recalculado no cliente e comparado com `storedBalance` e `calculatedBalance` da reconciliação HTTP de **todas** as wallets. SQL confere transações = operações únicas aplicadas, journal = aberturas + processadas, pares válidos, nenhum estado não terminal, eventos únicos, nenhuma operação com dois resultados de primeira submissão e nenhuma BET impossível processada.
- **Resultados brutos** por execução: `requests.ndjson.gz` (uma linha por operação agendada), `db-samples.ndjson.gz` e `run.json`; mais `environment.json`, `summary.json` e `report.md` comparativo na raiz.
- Não presumir ganho linear com três instâncias nem inventar meta de RPS. As taxas padrão vieram de uma sondagem (100/300/600 ops/s): 100 fica abaixo e 500 acima da saturação observada com uma instância. Gargalos e limites estão documentados na evidência.

## Limitações do gerador

- Gerador, APIs, PostgreSQL, LocalStack e Keycloak compartilham o mesmo host: CPU e memória competem, e as medições não representam hardware dedicado.
- Um único processo Bun gera a carga; acima de alguns milhares de ops/s o próprio gerador pode virar gargalo. O atraso de agendamento p99 está no relatório para expor isso.
- Latência é medida no cliente, inclusive o tempo em fila no pool de conexões da API; não separa rede, Nest e PostgreSQL.
- Amostras de `pg_stat_activity` são pontuais (200 ms) e podem perder esperas curtas; contadores Prometheus são por processo e reiniciam com ele.
- Round-robin no cliente não reproduz algoritmos de balanceadores nem afinidade de conexão.
- Somente a entrada HTTP é exercitada; o consumidor SQS de comandos compartilha o mesmo núcleo financeiro e locks, mas sua vazão não é medida aqui.

Referências: [README](https://github.com/junglegaming/backend-challenge), diferencial de carga da seção 14; [k6 open and closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/), como referência metodológica, sem substituir o runtime exigido.

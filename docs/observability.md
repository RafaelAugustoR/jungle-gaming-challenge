# Observabilidade e console

Escopo aprovado no grill em 2026-11-11.

## Logs

Logs JSON correlacionam HTTP, processamento financeiro e outbox com correlationId, messageId, transactionId, walletId e providerId quando aplicáveis. Não incluem tokens, segredos, dados sensíveis ou payloads financeiros completos.

## Métricas

Prometheus e Grafana são provisionados pelo Docker Compose, com dashboard versionado em `infra/observability/grafana/dashboards/jungle-operations.json`. Prometheus coleta API, command consumer, reference worker e outbox publisher em listeners separados. Esses listeners não têm portas publicadas no host; somente Prometheus os acessa pela rede do Compose. A URL pública do Grafana local é `http://localhost:3001`; substitua `GRAFANA_ADMIN_PASSWORD` antes de compartilhar o ambiente. Se `172.31.20.0/24` conflitar com outra rede Docker, altere `METRICS_NETWORK_SUBNET` no `.env`; o mesmo valor configura a rede interna e a allowlist do listener.

O endpoint da API `/internal/metrics` segue protegido pelo perfil `viewer`. `/health/live` e `/health/ready` permanecem públicos conforme o contrato. O listener de scrape interno usa `/metrics` na porta de `METRICS_PORT`, não publicada no host; sua proteção é o limite da rede privada do Compose. Em uma implantação externa, aplique a mesma separação de rede ou autenticação no proxy/scraper antes de expor esse listener.

`wager_transactions{operation,status}` é reconstruído em cada scrape a partir das linhas persistidas de transações. É um gauge de contagem durável, não um contador do processo: sobrevive a reinícios e não transforma replay em nova operação. `wager_transaction_attempts_total`, `wager_transaction_duplicates_total`, `worker_retries_total`, `worker_dead_letters_total`, `outbox_retry_attempts_total`, `wallet_lock_conflicts_total`, `wagering_transaction_retries_total`, `wager_transaction_duration_seconds` e métricas padrão do processo representam observações e tentativas de cada processo e reiniciam com ele. Prometheus trata reset de contador ao calcular `rate`/`increase`. `reference_retry_attempts`, `outbox_pending_events`, `outbox_blocked_events` e `outbox_oldest_pending_age_seconds` são lidos do banco no scrape da API. O snapshot é atualizado por uma consulta read-only em transação com `statement_timeout` de 750ms; scrapes simultâneos compartilham a mesma atualização e um cache de 2s reduz pressão sobre o pool financeiro.

Labels se limitam a `operation` (tipo de aposta), `status`, `channel`, `worker`, `source`, `route`, `method`, disposição finita e status HTTP. IDs de wallet, provedor, transação, mensagem, valores monetários e payloads nunca são labels. `outbox_pending_events` inclui eventos bloqueados e `outbox_blocked_events` destaca esse subconjunto. O dashboard usa contagens persistidas, tentativas e retries, transferências à DLQ, latência p95, backlog da outbox, divergências de reconciliação e disponibilidade de scrape.

### Diagnóstico e recuperação

1. Abra o Grafana em `http://localhost:3001` e o Prometheus em `http://localhost:9090`. Verifique o painel **Scrape target availability** e a página `/targets` do Prometheus. `up=0` indica conexão/listener indisponível; uma série ausente sugere serviço não iniciado, sobretudo o publisher do perfil `events`.
2. Consulte logs JSON por `correlationId`, `messageId` e `transactionId`. O logger mascara credenciais, authorization, payload, money, amount e balance; evite registrar objetos brutos fora do logger sanitizado.
3. Para investigar retries de comando, inspecione `worker_retries_total`, DLQ e logs `command_retry`/`command_dead_lettered`. Para outbox, combine `outbox_retry_attempts_total`, `outbox_pending_events`, `outbox_blocked_events`, `outbox_oldest_pending_age_seconds` com `wagering.outbox` e `last_error_code` via acesso SQL autorizado. Não trate erro de transporte/retry como rejeição financeira.
4. Se PostgreSQL ou SQS ficar indisponível, `/health/ready` passa a responder 503 e registra qual dependência falhou; `/health/live` continua indicando que o processo está ativo. Restaure a dependência e confirme readiness e `up=1`. Workers voltam a processar com o backoff configurado.
5. Depois de reiniciar um worker, os counters daquele processo começam novamente em zero. Prometheus mostra a lacuna durante a indisponibilidade; o gauge `wager_transactions` continua refletindo os registros financeiros do banco. Compare as contagens por status antes e depois da recuperação e aguarde o backlog da outbox reduzir.

Para publicar os eventos e observar o publisher, inicie também o perfil `events`:

```sh
docker compose --profile events up --build -d outbox-publisher event-consumer
```

O listener interno não é publicado no host; para inspecionar o endpoint viewer-autenticado da API use `GET /internal/metrics` com um token de viewer. O scrape interno não requer token: Prometheus está na mesma rede privada do Compose e a porta de métricas não está mapeada para o host.

Health checks separam liveness e readiness, com PostgreSQL e SQS na verificação de prontidão exigida pelo README. Métricas e dashboards não herdam a abertura pública dos health checks.

## Apresentação

O console operacional apresenta wallets, transações, ledger, reconciliação e cenários de demonstração, com os perfis aprovados na ADR 0002. Grafana apresenta o comportamento agregado sob carga e falhas. Ambos usam dados reais da execução, sem métricas inventadas.

OpenTelemetry fica como extensão, fora do escopo inicial aprovado de logs correlacionados e métricas.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 12; [Prometheus instrumentation](https://prometheus.io/docs/practices/instrumentation/).

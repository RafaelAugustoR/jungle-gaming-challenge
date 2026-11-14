# Observabilidade e console

Escopo aprovado no grill em 2026-11-11.

## Logs

Logs JSON correlacionam HTTP, processamento financeiro e outbox com correlationId, messageId, transactionId, walletId e providerId quando aplicáveis. Não incluem tokens, segredos, dados sensíveis ou payloads financeiros completos.

## Métricas

Prometheus e Grafana são provisionados pelo Docker Compose, com dashboard versionado em `infra/observability/grafana/dashboards/jungle-operations.json`. Prometheus coleta API, command consumer, reference worker e outbox publisher em listeners separados. Esses listeners não têm portas publicadas no host; somente Prometheus os acessa pela rede do Compose. A URL pública do Grafana local é `http://localhost:3001`; substitua `GRAFANA_ADMIN_PASSWORD` antes de compartilhar o ambiente. Se `172.31.20.0/24` conflitar com outra rede Docker, altere `METRICS_NETWORK_SUBNET` no `.env`; o mesmo valor configura a rede interna e a allowlist do listener.

O endpoint da API `/internal/metrics` segue protegido pelo perfil `viewer`. `/health/live` e `/health/ready` permanecem públicos conforme o contrato. O listener de scrape interno usa `/metrics` na porta de `METRICS_PORT`, não publicada no host; sua proteção é o limite da rede privada do Compose. Em uma implantação externa, aplique a mesma separação de rede ou autenticação no proxy/scraper antes de expor esse listener.

`wager_transactions{operation,status}` é reconstruído por um collector exclusivo da API a partir das linhas persistidas. O collector tem cache singleflight de 2s e `statement_timeout` de 750ms. Falha no banco mantém o último snapshot, informa `durable_snapshot_success=0` e sua idade em `durable_snapshot_age_seconds`; o scrape continua 200 para preservar counters HTTP e de processo durante incidentes. `durable_snapshot_success=1` indica atualização bem-sucedida. A query é read-only e usa a conexão do pool existente.

`wager_transaction_attempts_total`, `wager_transaction_duplicates_total`, `jungle_retries_total{component,reason}`, `worker_dead_letters_total`, `wallet_lock_conflicts_total` e `wager_transaction_duration_seconds` são observações por processo e reiniciam com ele. Contagens financeiras persistidas não se confundem com esses counters. Prometheus trata reset de contador ao calcular `rate`/`increase`. `reference_pending_transactions`, `reference_oldest_pending_age_seconds`, `outbox_pending_events`, `outbox_blocked_events` e `outbox_oldest_pending_age_seconds` vêm do collector durável da API. `worker_dlq_messages{worker}` é uma profundidade aproximada reportada pelo SQS; é atualizada periodicamente pelos consumers de comandos e eventos, cobre mensagens visíveis, atrasadas e em processamento, e sobrevive ao restart do worker porque a fonte é a própria fila. `worker_dead_letters_total` permanece como contador secundário apenas para transferências explícitas.

Labels se limitam a `operation` (tipo de aposta), `status`, `channel`, `worker`, `source`, `route`, `method`, disposição finita e status HTTP. IDs de wallet, provedor, transação, mensagem, valores monetários e payloads nunca são labels. `outbox_pending_events` inclui eventos bloqueados e `outbox_blocked_events` destaca esse subconjunto. O dashboard usa contagens persistidas, tentativas e retries, transferências à DLQ, latência p95, backlog da outbox, divergências de reconciliação e disponibilidade de scrape.

### Diagnóstico e recuperação

1. Abra o Grafana em `http://localhost:3001` e o Prometheus em `http://localhost:9090`. Verifique o painel **Scrape target availability** e a página `/targets` do Prometheus. `up=0` indica conexão/listener indisponível; uma série ausente sugere serviço não iniciado, sobretudo o publisher do perfil `events`.
2. Consulte logs JSON por `correlationId`, `messageId` e `transactionId`. O logger mascara credenciais, authorization, payload, money, amount e balance. Erros são serializados por allowlist: erros do driver PostgreSQL (que embutem o SQL com os valores) viram só `name`, `sqlState`, `constraint`, `table` e frames da stack; outros erros mantêm mensagens em formato de código (`INSUFFICIENT_FUNDS`) ou o texto mascarado. Evite registrar objetos brutos fora do logger sanitizado.
3. Para investigar retries, filtre `jungle_retries_total` por componente e motivo. Compare o counter secundário de transferências à DLQ com `worker_dlq_messages`, que inclui redrive nativo do SQS. Para outbox, combine os retries com `outbox_pending_events`, `outbox_blocked_events` e `outbox_oldest_pending_age_seconds`, e consulte `wagering.outbox`/`last_error_code` com acesso SQL autorizado. Não trate erro de transporte/retry como rejeição financeira. Em `wager_transaction_attempts_total`, falhas causadas pelo cliente usam a categoria do erro (`invalid`, `rejected`, `forbidden`, `conflict`, `notFound`); `status="error"` fica reservado para indisponibilidade, falha interna e erros inesperados.
4. Se PostgreSQL ou SQS ficar indisponível, `/health/ready` passa a responder 503 e registra qual dependência falhou; `/health/live` continua indicando que o processo está ativo. Restaure a dependência e confirme readiness e `up=1`. Workers voltam a processar com o backoff configurado.
5. `durable_snapshot_success=0` com `durable_snapshot_age_seconds` crescente mostra falha na leitura do banco; dados exibidos são o último snapshot conhecido e não devem ser tratados como atuais. Depois de reiniciar um worker, counters daquele processo começam em zero; a profundidade da DLQ e `wager_transactions` continuam duráveis nas respectivas fontes. Compare as contagens por status após a recuperação e aguarde o backlog da outbox reduzir.

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

A submissão HTTP/SQS e o reprocessamento de referências compartilham apenas o helper de medição de tentativas/latência; cada fluxo tem seu próprio observer/adaptador. Channel distingue http, sqs e reference. Retries usam componentes financial (retry SQL), command (reentrega), outbox (publicação), reference (referência adiada/indisponível) e os nomes dos runtimes para erro de iteração. Reasons são categorias finitas; serialization_failure não é statement_timeout. O painel de snapshot filtra job=api, único processo com collector durável.

Adapters ficam nos módulos donos (wagering/infrastructure/observability e messaging/*/observability); o módulo compartilhado mantém registry/collector/listeners. O fluxo de referências é a única origem de seus eventos de reagendamento/falha de batch. A profundidade das DLQs usa uma leitura SQS compartilhada; indisponibilidade da coleta mantém o último valor. O painel de outcomes de submissão exclui reference e agrupa os canais HTTP/SQS explicitamente.

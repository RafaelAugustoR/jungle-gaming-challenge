# Observabilidade e console

Escopo aprovado no grill em 2026-11-11.

## Logs

Logs JSON correlacionam HTTP, processamento financeiro e outbox com correlationId, messageId, transactionId, walletId e providerId quando aplicáveis. Não incluem tokens, segredos, dados sensíveis ou payloads financeiros completos.

## Métricas

Prometheus e Grafana serão provisionados pelo Docker Compose, com dashboard versionado. A instrumentação cobrirá transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência, além de divergências de reconciliação.

Labels usarão dimensões limitadas, como operação, status e canal. Identificadores individuais ficam nos logs, não em labels. Contadores de tentativas e resultados financeiros persistidos são conceitos distintos: um replay não representa outra aposta processada. A especificação detalhará coleta multiprocesso e recuperação de métricas após reinícios.

Health checks separam liveness e readiness, com PostgreSQL e SQS na verificação de prontidão exigida pelo README. Métricas e dashboards operacionais não herdam automaticamente a abertura pública dos health checks; seu acesso será limitado ao ambiente interno ou autenticado.

## Apresentação

O console operacional apresenta wallets, transações, ledger, reconciliação e cenários de demonstração, com os perfis aprovados na ADR 0002. Grafana apresenta o comportamento agregado sob carga e falhas. Ambos usam dados reais da execução, sem métricas inventadas.

OpenTelemetry fica como extensão, fora do escopo inicial aprovado de logs correlacionados e métricas.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 12; [Prometheus instrumentation](https://prometheus.io/docs/practices/instrumentation/).

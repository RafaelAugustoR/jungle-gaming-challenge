# Idempotência com escopo por provedor

A chave de idempotência será única por (providerId, idempotencyKey), tanto na entrada HTTP quanto no SQS. Provedores distintos podem usar a mesma string de chave sem interferência; dentro de um provedor, a mesma chave com payload diferente é conflito.

O header HTTP continua obrigatório e fonte da verdade, sem substituição automática por uma chave calculada. Os exemplos usarão o formato recomendado providerId:externalTransactionId. A identidade autenticada limita o providerId permitido na API; a unicidade de (providerId, externalTransactionId) continua protegendo a operação contra submissões com outra chave.

Essa decisão resolve o escopo deixado pendente na ADR 0006 e evita colisões entre integrações independentes. Referências: [README](https://github.com/junglegaming/backend-challenge), seção 9; [AWS idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Decisão aprovada no grill em 2026-11-11.

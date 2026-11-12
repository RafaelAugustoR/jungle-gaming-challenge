# Conflito ao trocar a chave de uma operação existente

A mesma chave de idempotência com o mesmo payload permite replay sem novo efeito financeiro; com payload diferente, retorna 409 Conflict. Se uma operação com o mesmo par (providerId, externalTransactionId) chegar com outra chave, também retorna 409 Conflict, indicando que a operação já existe. O provedor pode consultar a operação existente ou repetir a chave original.

A persistência protegerá a unicidade da chave de idempotência e da identidade externa da operação. O escopo da chave entre provedores ainda será explicitado na especificação. IDs externos iguais de provedores diferentes, usando chaves próprias, representam operações independentes.

Escolhemos conflito em vez de cadastrar aliases de chave ou aceitar a segunda submissão como nova operação, preservando a chave original como referência do replay e impedindo efeitos financeiros duplicados. Referências: [README](https://github.com/junglegaming/backend-challenge), seções 7 e 9; [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests); [AWS idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Decisão aprovada no grill em 2026-11-11.

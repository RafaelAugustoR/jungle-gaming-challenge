# Tratamento do estado da referência

Reversões cuja referência não existe ou está em PENDING ou PENDING_REFERENCE aguardam em PENDING_REFERENCE, com reprocessamento limitado. Quando a referência está PROCESSED, as demais regras são validadas antes de aplicar a reversão.

Referências em REJECTED ou FAILED não podem avançar para PROCESSED: a reversão será rejeitada imediatamente com REFERENCE_NOT_PROCESSED, sem efeito financeiro. Incompatibilidades já verificáveis de tipo, valor, provedor, jogador, wallet, moeda ou rodada causam rejeição com código específico, sem aguardar uma mudança que não resolveria o conflito.

Essa política distingue dependências que ainda podem ser atendidas de referências terminalmente inválidas. Não altera estados terminais nem reprocessa a operação de origem. O prazo de espera e os intervalos serão definidos separadamente.

Referências: [README](https://github.com/junglegaming/backend-challenge), seções 6.3 e 7; [AWS idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/), como orientação geral para retries, não como definição dos estados deste domínio. Decisão aprovada no grill em 2026-11-11.

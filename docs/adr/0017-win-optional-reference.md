# Referência opcional em WIN

WIN sem referência pode creditar a wallet, após validar os demais campos e invariantes. Quando uma referência é informada, ela deve apontar para uma BET PROCESSED compatível em provedor, jogador, wallet, moeda e rodada. O valor do WIN não precisa ser igual ao da BET: a exigência de igualdade de valor do README se aplica a REFUND e ROLLBACK.

Referência ausente ou ainda pendente leva o WIN a PENDING_REFERENCE, sujeito à política de espera aprovada na ADR 0011. Referência REJECTED, FAILED ou incompatível causa rejeição com código específico, sem crédito.

A referência ser opcional não permite ignorá-la quando fornecida. Exigir BET processada para WIN com referência é uma interpretação adicional explícita, não uma regra universal de provedores. Esta decisão especializa a ADR 0010: incompatibilidade de valor é verificada nas reversões que exigem igualdade, não entre WIN e BET.

Referência: [README](https://github.com/junglegaming/backend-challenge), seção 7. Decisão aprovada no grill em 2026-11-11.

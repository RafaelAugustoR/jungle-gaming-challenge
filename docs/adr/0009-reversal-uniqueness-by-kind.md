# Unicidade de reversão por referência e tipo

Seguiremos a regra literal da seção 7 do README: uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação. Reversões aplicadas serão protegidas por unicidade da referência e do tipo de reversão, além das verificações de provedor, jogador, wallet, moeda, rodada, valor e estado da referência.

Consequentemente, REFUND e ROLLBACK distintos podem referenciar a mesma BET processada: com abertura de 100.00, BET de 20.00, REFUND de 20.00 e ROLLBACK diretamente da BET de 20.00, o saldo final é 120.00. Esse efeito será documentado e testado; não afirmamos que seja uma regra universal de operações financeiras reais. ROLLBACK do REFUND tem outro efeito: debita o crédito produzido pelo REFUND, sujeito à regra de saldo não negativo.

Preferimos aderir à restrição explícita por tipo a impor silenciosamente uma proibição entre tipos. A regra pode ser revisada se a organização esclarecer intenção diferente. Rejeições não representam reversões aplicadas; a especificação detalhará a constraint sem transformar uma tentativa rejeitada em reversão financeira.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 7; [TigerBeetle correcting transfers](https://docs.tigerbeetle.com/coding/recipes/correcting-transfers/), apenas como referência de histórico imutável, não como fonte da política de apostas. Decisão aprovada no grill em 2026-11-11.
